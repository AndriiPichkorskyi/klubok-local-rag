/**
 * Файл: src/modules/rag/engine.js
 * Опис: Ядро RAG (Retrieval-Augmented Generation). Отримує запит користувача,
 *       шукає релевантну документацію через LanceDB, і просить Ollama (LLM)
 *       сформувати кінцеву рекомендацію з цитатою (із захистом від галюцинацій).
 */

import { config } from "../../config/config.js";
import { db } from "../../services/db.service.js";
import { ollama } from "../../services/ollama.service.js";
import { generatePrompt } from "./prompts.js";

/**
 * Основна функція обробки запиту.
 *
 * @param {string} queryText - Запит користувача (наприклад "як записати звук").
 * @param {Function} onProgress - Колбек для оновлення тексту статусу (спінера).
 * @returns {Promise<{response: string, contextApps: string[], executionTimeMs: number}>}
 */
export async function processQuery(queryText, onProgress = () => {}, searchMode = null, excludeLocal = false) {
  const start = performance.now();

  let relevantChunks = [];

  if (config.rag.searchMode === "fts") {
    onProgress("Виконуємо текстовий пошук (FTS)...");
    relevantChunks = await db.searchSimilarFts(queryText, config.rag.topK, excludeLocal);
  } else if (config.rag.searchMode === "hybrid") {
    onProgress("Генеруємо вектор для гібридного пошуку...");
    const queryVector = await ollama.generateEmbedding(queryText);

    onProgress("Виконуємо гібридний пошук (Vector + FTS)...");
    const vectorResults = await db.searchSimilar(queryVector, config.rag.topK, excludeLocal);
    const ftsResults = await db.searchSimilarFts(queryText, config.rag.topK, excludeLocal);

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
    relevantChunks = await db.searchSimilar(queryVector, config.rag.topK, excludeLocal);
  }

  // МЕТРИКИ ПОШУКУ
  let retrievalStats = {
    initialChunks: relevantChunks.length,
    filteredChunks: relevantChunks.length,
    distances: relevantChunks.filter(c => c._distance !== undefined).map(c => c._distance)
  };

  // === 1. Strict Top-K (Фільтрація по порогу релевантності) ===
  // Якщо ми використовуємо чисто векторний пошук, відкидаємо занадто далекі результати
  if (config.rag.searchMode === "vector") {
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
      contextApps: [],
      executionTimeMs: performance.now() - start,
      recommendedApp: "NOT_FOUND",
      retrievalStats
    };
  }

  // 3. Parent Document Retrieval (Завантаження повних статей)
  onProgress(`Завантажуємо повні статті для найкращих знахідок...`);

  let parentDocuments = [];
  const seenDocIds = new Set();

  for (const chunk of relevantChunks) {
    // Якщо це унікальний документ (і не метадані docId: 0)
    if (!seenDocIds.has(chunk.docId) && chunk.docId !== 0 && chunk.docId !== undefined) {
      seenDocIds.add(chunk.docId);
      const fullDoc = await db.getWebDocumentById(chunk.docId);
      if (fullDoc && fullDoc.content) {
        parentDocuments.push({
          appName: chunk.appName,
          title: chunk.docTitle || "Довідка",
          content: fullDoc.content,
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
  const prompt = generatePrompt(contextText, queryText, config.rag.enableXmlTags, config.rag.enableJsonFormat);

  // 4. Генеруємо відповідь
  onProgress("Генеруємо рекомендацію за допомогою LLM...");
  const ollamaResult = await ollama.generateChatResponse(prompt, config.rag.enableJsonFormat);
  const rawLlmOutput = ollamaResult.response;
  let responseText = rawLlmOutput;

  const end = performance.now();
  const executionTimeMs = end - start;

  const uniqueApps = [...new Set(parentDocuments.map((d) => d.appName))];

  let recommendedApp = null;

  if (config.rag.enableJsonFormat) {
    try {
      const parsed = JSON.parse(responseText);
      if (parsed.isMatch && parsed.sourceId > 0 && parsed.sourceId <= parentDocuments.length) {
        const sourceDoc = parentDocuments[parsed.sourceId - 1];
        recommendedApp = sourceDoc.appName;
        responseText = `**${recommendedApp}**\n\n${parsed.reason}\n\n**📄 Повна стаття довідки (${sourceDoc.appName} - ${sourceDoc.title}):**\n\n${sourceDoc.content.trim()}`;
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
      console.error("JSON parsing error:", e.message, responseText);
      responseText = "Помилка формату відповіді від LLM.";
      recommendedApp = "NOT_FOUND";
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
        responseText = `**${recommendedApp}**\n\n` + responseText;
        responseText += `\n\n**📄 Повна стаття довідки (${sourceDoc.appName} - ${sourceDoc.title}):**\n\n${sourceDoc.content.trim()}`;
      }
    } else {
      if (responseText.includes("INVALID_QUERY")) {
        responseText = "Здається, ваш запит не зовсім зрозумілий або містить випадкові символи. Будь ласка, уточніть його.";
        recommendedApp = "INVALID_QUERY";
      } else {
        responseText = "На жаль, я не знайшов на вашому Mac програми, яка б підходила для цього завдання.";
        recommendedApp = "NOT_FOUND";
      }
    }
  }

  // Альтернативні програми (все, що знайшла векторна база, крім головної рекомендації)
  const alternativeApps = uniqueApps.filter(app => app !== recommendedApp);

  // Повертаємо всі дані для подальшого запиту фідбеку та логування у CLI
  return {
    response: responseText,
    rawLlmOutput: rawLlmOutput,
    recommendedApp: recommendedApp || "Не визначено",
    alternativeApps,
    contextApps: uniqueApps,
    executionTimeMs,
    ollamaMetrics: ollamaResult,
    retrievalStats
  };
}
