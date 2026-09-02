/**
 * Файл: src/modules/rag/engine.js
 * Опис: Ядро RAG (Retrieval-Augmented Generation). Отримує запит користувача,
 *       шукає релевантну документацію через LanceDB, і просить Ollama (LLM)
 *       сформувати кінцеву рекомендацію з цитатою (із захистом від галюцинацій).
 */

import { config } from "../../config/config.js";
import { db } from "../../services/db.service.js";
import { jsonrepair } from "jsonrepair";
import { ollama } from "../../services/ollama.service.js";
import { generatePrompt } from "./prompts.js";

/** Дозволені режими пошуку. Значення поза списком — помилка виклику, а не тихий фолбек. */
export const SEARCH_MODES = ["vector", "fts", "hybrid"];

/**
 * Основна функція обробки запиту.
 *
 * @param {string} queryText - Запит користувача (наприклад "як записати звук").
 * @param {Function} onProgress - Колбек для оновлення тексту статусу (спінера).
 * @param {string|null} searchMode - Режим пошуку; null = взяти config.rag.searchMode.
 * @param {boolean|null} excludeLocal - Відкинути локальну довідку; null = config.rag.excludeLocalDocs.
 * @param {Object|null} overrides - Точкове перевизначення осей генерації на ОДИН виклик:
 *        `{seed, temperature}`. Потрібне бенчмарку з віссю `seed: "random"`: там кожен
 *        кейс має власне зерно, а `config.rag.seed` — глобальний і спільний для трьох
 *        паралельних задач (p-limit), тож підміняти його на кожен запит означало б
 *        гонку і зерно «сусіда» в звіті. Незадане поле = значення з конфіга, тобто
 *        звичайний шлях користувача не змінюється взагалі.
 * @returns {Promise<{response: string, contextApps: string[], executionTimeMs: number}>}
 */
export async function processQuery(
  queryText,
  onProgress = () => {},
  searchMode = null,
  excludeLocal = null,
  overrides = null,
) {
  const start = performance.now();

  // Аргумент має пріоритет над конфігом: панель розробника порівнює режими
  // між собою, не переписуючи pipeline.config.json.
  if (searchMode !== null && searchMode !== undefined && !SEARCH_MODES.includes(searchMode)) {
    throw new Error(
      `Невідомий searchMode «${searchMode}». Дозволені: ${SEARCH_MODES.join(", ")}.`,
    );
  }
  const mode = searchMode ?? config.rag.searchMode;
  const skipLocal =
    typeof excludeLocal === "boolean" ? excludeLocal : config.rag.excludeLocalDocs === true;

  // Осі генерації: аргумент виклику > конфіг. Обидві потрапляють і в запит до
  // Ollama, і в retrievalStats — щоб той, хто читає результат, бачив, чим саме
  // його отримано, а не те, що було в конфізі на момент читання.
  const seed = overrides && overrides.seed !== undefined ? overrides.seed : config.rag.seed;
  const temperature =
    overrides && overrides.temperature !== undefined
      ? overrides.temperature
      : config.rag.temperature;

  let relevantChunks = [];

  if (mode === "fts") {
    onProgress("Виконуємо текстовий пошук (FTS)...");
    relevantChunks = await db.searchSimilarFts(queryText, config.rag.topK, skipLocal);
  } else if (mode === "hybrid") {
    onProgress("Генеруємо вектор для гібридного пошуку...");
    const queryVector = await ollama.generateEmbedding(queryText);

    onProgress("Виконуємо гібридний пошук (Vector + FTS)...");
    const vectorResults = await db.searchSimilar(queryVector, config.rag.topK, skipLocal);
    const ftsResults = await db.searchSimilarFts(queryText, config.rag.topK, skipLocal);

    // Reciprocal Rank Fusion (RRF) для об'єднання результатів
    const scores = new Map();
    const k = 60;

    vectorResults.forEach((res, rank) => {
      const key = `${res.appName}_${res.docId}_${res.text.substring(0, 20)}`;
      scores.set(key, { item: res, score: 1 / (k + rank) });
    });

    ftsResults.forEach((res, rank) => {
      const key = `${res.appName}_${res.docId}_${res.text.substring(0, 20)}`;
      const existing = scores.get(key);
      const score = 1 / (k + rank);
      if (existing) {
        existing.score += score;
      } else {
        scores.set(key, { item: res, score });
      }
    });

    relevantChunks = Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
      .slice(0, config.rag.topK);
  } else {
    // Векторний пошук (за замовчуванням)
    onProgress("Генеруємо вектор запиту...");
    const queryVector = await ollama.generateEmbedding(queryText);
    onProgress("Шукаємо релевантні інструменти у векторній базі...");
    relevantChunks = await db.searchSimilar(queryVector, config.rag.topK, skipLocal);
  }

  // МЕТРИКИ ПОШУКУ
  let retrievalStats = {
    searchMode: mode,
    excludeLocal: skipLocal,
    // Фактичні осі генерації цього виклику. Для випадкового зерна це ЄДИНЕ
    // місце, де видно, чим саме отримано відповідь.
    seed: seed ?? null,
    temperature: temperature ?? null,
    initialChunks: relevantChunks.length,
    filteredChunks: relevantChunks.length,
    distances: relevantChunks.filter(c => c._distance !== undefined).map(c => c._distance)
  };

  // === 1. Strict Top-K (Фільтрація по порогу релевантності) ===
  // Якщо ми використовуємо чисто векторний пошук, відкидаємо занадто далекі результати
  if (mode === "vector") {
    // В LanceDB менший _distance означає більшу схожість. Поріг підбирається експериментально.
    const distanceThreshold = 0.95;
    relevantChunks = relevantChunks.filter(
      (chunk) => chunk._distance === undefined || chunk._distance < distanceThreshold,
    );
    retrievalStats.filteredChunks = relevantChunks.length;
  }

  if (relevantChunks.length === 0) {
    return {
      response: "Не вдалося знайти жодних релевантних інструментів для вашого запиту.",
      rawLlmOutput: null,
      recommendedApp: "NOT_FOUND",
      alternativeApps: [],
      contextApps: [],
      executionTimeMs: performance.now() - start,
      ollamaMetrics: null,
      retrievalStats
    };
  }

  // 3. Parent Document Retrieval (Завантаження повних статей)
  onProgress(`Завантажуємо повні статті для найкращих знахідок...`);

  let parentDocuments = [];
  const seenDocIds = new Set();

  for (const chunk of relevantChunks) {
    if (!seenDocIds.has(chunk.docId) && chunk.docId !== 0 && chunk.docId !== undefined) {
      seenDocIds.add(chunk.docId);
      
      let docTitle = chunk.docTitle || "Довідка";
      let docContent = null;

      if (chunk.docId === -1 && config.rag.includeAppIntents) {
        docTitle = "Базовий опис та ключові слова";
        docContent = chunk.text;
      } else {
        const fullDoc = await db.getWebDocumentById(chunk.docId);
        if (fullDoc && fullDoc.content) {
          docContent = fullDoc.content;
        }
      }

      if (docContent) {
        parentDocuments.push({
          appName: chunk.appName,
          title: docTitle,
          content: docContent,
          originalChunkText: chunk.text,
        });
      }
      
      // Обмежуємо до топ-3 повних статей (щоб не переповнити LLM контекст)
      if (parentDocuments.length >= 3) break;
    }
  }

  // Фолбек: якщо знайдено лише метадані (програми без довідки), беремо їхні чанки
  if (parentDocuments.length === 0) {
    for (const chunk of relevantChunks) {
      parentDocuments.push({
        appName: chunk.appName,
        title: "Базовий опис",
        content: chunk.text,
        originalChunkText: chunk.text,
      });
      if (parentDocuments.length >= 5) break;
    }
  }

  // === 2. Re-ranking (Context Reordering) ===
  // Вирішуємо проблему "Lost in the middle".
  // Найбільш релевантні документи (індекси 0, 1) ставимо на початок і в самий кінець масиву.
  if (config.rag.enableContextReordering) {
    const reorderedDocuments = new Array(parentDocuments.length);
    let left = 0;
    let right = parentDocuments.length - 1;
    for (let i = 0; i < parentDocuments.length; i++) {
      if (i % 2 === 0) {
        reorderedDocuments[right] = parentDocuments[i];
        right--;
      } else {
        reorderedDocuments[left] = parentDocuments[i];
        left++;
      }
    }
    parentDocuments = reorderedDocuments;
  }

  const contextText = parentDocuments
    .map(
      (d, i) =>
        `--- START DOCUMENT ${i + 1} ---\nApp: ${d.appName}\nTitle: ${d.title}\nContent:\n${d.content}\n--- END DOCUMENT ${i + 1} ---`,
    )
    .join("\n\n");

  // === 3. Constraint Placement & XML Tags ===
  // Ми винесли логіку формування промптів у окремий файл для кращої архітектури.
  // Тут також реалізовано Constraint Placement (правила в самому кінці)
  // та опціональні XML теги для кращого розпізнавання структури моделлю.
  // Осі `systemPrompt`, `seed` і `temperature` читаються з конфіга так само,
  // як `enableXmlTags`: бенчмарк підміняє їх у пам'яті на час режиму, а
  // звичайний шлях користувача бере значення за замовчуванням із конфіга.
  const systemPromptMode = config.rag.systemPromptMode ?? "system";
  const { prompt, systemPrompt } = generatePrompt(
    contextText,
    queryText,
    config.rag.enableXmlTags,
    config.rag.enableJsonFormat,
    systemPromptMode,
  );

  // 4. Генеруємо відповідь
  onProgress("Генеруємо рекомендацію за допомогою LLM...");
  const ollamaResult = await ollama.generateChatResponse(
    prompt,
    config.rag.enableJsonFormat,
    systemPrompt,
    {
      systemPromptMode,
      seed,
      temperature,
    },
  );
  const rawLlmOutput = ollamaResult.response;
  let responseText = rawLlmOutput;

  const end = performance.now();
  const executionTimeMs = end - start;

  const uniqueApps = [...new Set(parentDocuments.map((d) => d.appName))];

  let recommendedApp = null;

  if (config.rag.enableJsonFormat) {
    try {
      let cleanText = responseText.trim();
      if (!cleanText) throw new Error("Модель повернула порожню відповідь.");
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/^```json\s*/, "").replace(/```$/, "").trim();
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/^```\s*/, "").replace(/```$/, "").trim();
      }
      const parsed = JSON.parse(jsonrepair(cleanText));
      if (parsed.isMatch && parsed.sourceId > 0 && parsed.sourceId <= parentDocuments.length) {
        const sourceDoc = parentDocuments[parsed.sourceId - 1];
        recommendedApp = sourceDoc.appName;
        responseText = parsed.reason;
      } else {
        if (parsed.reason === "INVALID_QUERY") {
          responseText = "Здається, ваш запит не зовсім зрозумілий або містить випадкові символи. Будь ласка, уточніть його.";
          recommendedApp = "INVALID_QUERY";
        } else {
          responseText = parsed.reason || "На жаль, я не знайшов на вашому Mac програми, яка б підходила для цього завдання.";
          recommendedApp = "NOT_FOUND";
        }
      }
    } catch (e) {
      console.error("JSON parsing error:", e.message, "\n--- СИРА ВІДПОВІДЬ LLM ---\n", responseText, "\n--------------------------");
      responseText = `Помилка обробки відповіді LLM: ${e.message}\n\n**Сира відповідь моделі:**\n\`\`\`text\n${responseText || "<порожньо>"}\n\`\`\``;
      recommendedApp = "ERROR";
    }
  } else {
    // 1. Спочатку перевіряємо наявність тегу [SOURCE_ID: X]
    const sourceMatch = responseText.match(/\[\s*SOURCE_ID:\s*(\d+)\s*\]/i);

    if (sourceMatch) {
      const sourceId = parseInt(sourceMatch[1], 10);
      if (sourceId > 0 && sourceId <= parentDocuments.length) {
        const sourceDoc = parentDocuments[sourceId - 1];
        recommendedApp = sourceDoc.appName;
        responseText = responseText.replace(sourceMatch[0], "").trim();
      }
    }

    // Тег [SOURCE_ID: X] з номером поза межами списку документів = посилання на
    // неіснуюче джерело. Довіряти такій відповіді не можна, тож обробляємо її
    // так само, як відсутній тег, а не віддаємо сирий текст LLM разом із тегом.
    if (!recommendedApp) {
      if (responseText.includes("INVALID_QUERY")) {
        responseText = "Здається, ваш запит не зовсім зрозумілий або містить випадкові символи. Будь ласка, уточніть його.";
        recommendedApp = "INVALID_QUERY";
      } else {
        responseText = "На жаль, я не знайшов на вашому Mac програми, яка б підходила для цього завдання.";
        recommendedApp = "NOT_FOUND";
      }
    }
  }

  // Альтернативні програми (все, що знайшла векторна база, крім головної рекомендації).
  // Маркер замість назви означає «рекомендації немає», тож альтернатив теж немає:
  // інакше сюди потрапляв би весь контекст як «найкращі з поганих» збігів.
  const MARKERS = ["NOT_FOUND", "INVALID_QUERY", "Не визначено"];
  const finalApp = recommendedApp || "Не визначено";
  const alternativeApps = MARKERS.includes(finalApp)
    ? []
    : uniqueApps.filter((app) => app !== finalApp);

  // Повертаємо всі дані для подальшого запиту фідбеку та логування у CLI
  return {
    response: responseText,
    rawLlmOutput: rawLlmOutput,
    recommendedApp: finalApp,
    alternativeApps,
    contextApps: uniqueApps,
    contextDocuments: parentDocuments,
    executionTimeMs,
    ollamaMetrics: ollamaResult,
    retrievalStats
  };
}
