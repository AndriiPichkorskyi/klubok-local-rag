/**
 * Файл: src/services/ollama.service.js
 * Опис: Клас-обгортка для взаємодії з локальним сервером Ollama.
 *       Використовується для генерації ембедингів (векторів) та відповідей LLM.
 */

import axios from "axios";
import readline from "readline";
import { config } from "../config/config.js";
import { CLASSIFIER_SYSTEM_PROMPT } from "../modules/rag/prompts.js";

/** Скільки чекаємо на відповідь Ollama під час перевірки живості. */
const TAGS_TIMEOUT_MS = 5000;

/** Прибирає дублі та порожні значення зі списку назв моделей. */
function uniqueNames(list) {
  return [...new Set(list.filter((name) => typeof name === "string" && name.trim()))];
}

/**
 * Чи встановлена модель. Ollama віддає назви з тегом ("llama3:latest"),
 * а модель без тега в конфізі означає саме тег ":latest".
 * @param {string} wanted - назва з конфіга
 * @param {string[]} installed - назви, які віддала Ollama
 */
export function isModelInstalled(wanted, installed) {
  if (!wanted) return true;
  if (installed.includes(wanted)) return true;
  if (!wanted.includes(":")) return installed.includes(`${wanted}:latest`);
  return false;
}

/**
 * Єдине джерело правди про моделі. Раніше їх було два — `config.ollama`
 * (чат + вектори) і `config.bootstrap.requiredModels` — і вони могли мовчки
 * розійтися. Тепер обов'язковий список виводиться з моделей, які процес
 * реально використовує, плюс те, що додано в bootstrap вручну.
 * @returns {{required: string[], optional: string[]}}
 */
export function resolveModelLists() {
  const required = uniqueNames([
    config.ollama.chatModel,
    config.ollama.embedModel,
    ...(config.bootstrap?.requiredModels || []),
  ]);
  const optional = uniqueNames([
    config.ollama.visionModel,
    ...(config.bootstrap?.optionalModels || []),
  ]).filter((model) => !required.includes(model));
  return { required, optional };
}

/**
 * Витягує справжню причину відмови Ollama. Axios ховає її за загальним
 * «Request failed with status code 400», а Ollama завжди пише пояснення
 * у тілі відповіді — без нього діагностувати неможливо.
 */
function describeOllamaError(error, context) {
  const body = error?.response?.data;
  const reason =
    (typeof body === "string" && body) ||
    body?.error ||
    body?.message ||
    error?.message ||
    "невідома помилка";
  const status = error?.response?.status;
  const prefix = status ? `Ollama відповіла ${status}` : "Ollama недоступна";
  const enriched = new Error(`${prefix} (${context}): ${reason}`);
  enriched.status = status;
  enriched.ollamaError = reason;
  enriched.cause = error;
  return enriched;
}

class OllamaService {
  // Читаємо конфіг щоразу, а не копіюємо в конструкторі: інакше `config.reload`
  // (RPC-метод config.reload) не впливав би на вже створений сервіс.
  get baseUrl() {
    return config.ollama.baseUrl;
  }
  get chatModel() {
    return config.ollama.chatModel;
  }
  get embedModel() {
    return config.ollama.embedModel;
  }
  get visionModel() {
    return config.ollama.visionModel;
  }

  /**
   * Перевіряє доступність сервера Ollama та наявність необхідних моделей.
   * @returns {Promise<{isAvailable: boolean, missingModels: string[], installedModels: string[], error: string|null}>}
   */
  async checkAvailability() {
    try {
      const { data } = await axios.get(`${this.baseUrl}/api/tags`, { timeout: TAGS_TIMEOUT_MS });
      // Несподіване тіло відповіді — це не «Ollama лежить»: сервер відповів.
      // Порожній список моделей чесніший за TypeError, який ловив би catch нижче.
      const installedModels = Array.isArray(data?.models)
        ? data.models.map((m) => m.name).filter(Boolean)
        : [];

      const { required } = resolveModelLists();
      const missingModels = required.filter((model) => !isModelInstalled(model, installedModels));

      return {
        isAvailable: true,
        missingModels,
        installedModels,
        error: null,
      };
    } catch (err) {
      return {
        isAvailable: false,
        missingModels: [],
        installedModels: [],
        error: err.message,
      };
    }
  }

  /**
   * Прогріває моделі (завантажує їх у VRAM/RAM), щоб перший запит виконувався швидко.
   * Виконується асинхронно та паралельно для чат-моделі та моделі векторів.
   */
  async warmup() {
    try {
      // Відправляємо мінімальні запити, щоб Ollama завантажила моделі в пам'ять
      await Promise.all([
        axios.post(`${this.baseUrl}/api/generate`, {
          model: this.chatModel,
          prompt: "hi",
          stream: false,
          keep_alive: "10m", // Тримаємо в пам'яті 10 хвилин
        }),
        axios.post(`${this.baseUrl}/api/embeddings`, {
          model: this.embedModel,
          prompt: "hi",
          keep_alive: "10m",
        }),
      ]);
    } catch (e) {
      // Ігноруємо помилки прогріву
    }
  }

  /**
   * Створює числовий вектор (ембединг) для вказаного тексту.
   * @param {string} text - Текст для векторизації.
   * @returns {Promise<number[]>} - Вектор.
   */
  async generateEmbedding(text) {
    const response = await axios.post(`${this.baseUrl}/api/embeddings`, {
      model: this.embedModel,
      prompt: text,
      keep_alive: "5m", // Тримаємо модель векторів в пам'яті
    });
    return response.data.embedding;
  }

  /**
   * Відправляє промпт до LLM та отримує згенеровану текстову відповідь.
   *
   * Ані seed, ані temperature більше не захардкоджені: обидва — параметри
   * експерименту. Раніше `seed: 42` разом із `temperature: 0.1` давали майже
   * детермінований вивід, тобто на кожен режим бенчмарку припадав рівно один
   * зразок і жодного уявлення про розкид.
   *
   * @param {string} prompt - Текст промпту.
   * @param {boolean} enableJsonFormat - Вимагати від моделі строгий JSON.
   * @param {string|null} systemPrompt - Готовий текст системного повідомлення
   *        (див. generatePrompt). `null` = поле `system` не надсилати.
   * @param {Object} [options] - Параметри осей експерименту:
   *        `systemPromptMode` ("system"|"inline"|"none"),
   *        `seed` (число або `null` = не надсилати seed узагалі),
   *        `temperature` (число).
   * @returns {Promise<Object>} - Повна відповідь Ollama (з метриками).
   */
  async generateChatResponse(prompt, enableJsonFormat = false, systemPrompt = null, options = {}) {
    // Пріоритет: явний аргумент виклику > конфіг > історичний дефолт.
    const seed = options.seed !== undefined ? options.seed : config.rag?.seed;
    const temperature =
      options.temperature !== undefined ? options.temperature : config.rag?.temperature;

    const payload = {
      model: this.chatModel,
      prompt: prompt,
      stream: false,
      keep_alive: "5m",
      options: {
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1,
        num_ctx: 4096,
        num_predict: 9192,
        // Скидаємо штрафи, які можуть бути "зашиті" в Modelfile цієї моделі.
        // Високий presence_penalty (як 1.5 у логах) штрафує символ `{`,
        // через що граматика вимушено генерує безкінечні пробіли замість JSON.
        // presence_penalty: 0.0,
        // frequency_penalty: 0.0,
        // repeat_penalty: 1.0,
      },
    };

    // seed === null означає «прогін без фіксованого зерна»: поле просто не
    // надсилаємо, і кожен виклик дає свій зразок.
    if (seed !== null && seed !== undefined && Number.isFinite(Number(seed))) {
      payload.options.seed = Number(seed);
    }

    // Якщо передано готовий системний промпт - використовуємо його.
    // Режими "inline" та "none" осі systemPrompt навмисно НЕ мають фолбеку:
    // саме відсутність поля `system` вони й перевіряють.
    const suppressSystem =
      options.systemPromptMode === "inline" || options.systemPromptMode === "none";
    if (systemPrompt) {
      payload.system = systemPrompt;
    } else if (enableJsonFormat && !suppressSystem) {
      payload.system = CLASSIFIER_SYSTEM_PROMPT;
    }

    if (enableJsonFormat) {
      payload.format = {
        type: "object",
        properties: {
          isMatch: { type: "boolean" },
          reason: { type: "string" },
          sourceId: { type: "integer" },
        },
        required: ["isMatch", "reason"],
      };
    }
    const response = await axios.post(`${this.baseUrl}/api/generate`, payload);
    return response.data; // Повертаємо весь об'єкт, щоб мати доступ до метрик (total_duration, eval_count тощо)
  }

  /**
   * Запит до vision-моделі: текстовий промпт + зображення в base64.
   *
   * Три відмінності від generateChatResponse(), через які це окремий метод:
   *  1) інша модель (config.ollama.visionModel), і плутати їх не можна;
   *  2) поле `images` — саме так Ollama приймає картинку в /api/generate;
   *  3) виклик довгий, тому мусить бути скасовним і мати власний таймаут.
   *
   * Скасування зроблено штатним для проєкта способом: AbortSignal з ctx
   * прокидається в axios (так само, як у scraper.service.js). Скасований
   * запит кидає CanceledError — RPC-сервер перетворює його на «cancelled».
   *
   * `format` — JSON-схема структурованого виводу Ollama. Це заміна власному
   * парсеру: модель обмежена граматикою і не може віддати щось поза схемою.
   *
   * @param {Object} params
   * @param {string} params.prompt - основний промпт.
   * @param {string[]} params.images - зображення в base64 (без префікса data:).
   * @param {string|null} [params.system] - системне повідомлення.
   * @param {Object|null} [params.format] - JSON-схема відповіді.
   * @param {AbortSignal|null} [params.signal] - сигнал скасування.
   * @param {number} [params.timeoutMs] - ліміт очікування відповіді.
   * @param {number} [params.temperature] - температура (за замовчуванням 0: нам потрібна стабільність).
   * @param {number} [params.numPredict] - ліміт токенів відповіді.
   * @param {string} [params.model] - перевизначення моделі (за замовчуванням visionModel).
   * @returns {Promise<Object>} - повна відповідь Ollama (з метриками).
   */
  async generateVisionResponse({
    prompt,
    images = [],
    system = null,
    format = null,
    signal = null,
    timeoutMs = 120000,
    temperature = 0,
    numPredict = 400,
    numCtx = null,
    model = null,
  }) {
    if (!prompt) throw new Error("generateVisionResponse: не вказано промпт.");
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error("generateVisionResponse: не передано жодного зображення.");
    }

    const payload = {
      model: model || this.visionModel,
      prompt,
      images,
      stream: false,
      keep_alive: "5m",
      options: {
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0,
        num_predict: numPredict,
        // Без цього Ollama бере типові 4096, а зображення 1024px разом із
        // довідкою в промпті легко дають понад 5000 токенів — і запит падає з
        // exceed_context_size ще до того, як модель щось побачить.
        num_ctx: Number(numCtx) || Number(config.walkthrough?.visionNumCtx) || 8192,
      },
    };
    if (system) payload.system = system;
    if (format) payload.format = format;

    try {
      const response = await axios.post(`${this.baseUrl}/api/generate`, payload, {
        signal: signal || undefined,
        timeout: timeoutMs,
      });
      return response.data;
    } catch (error) {
      if (axios.isCancel(error) || error?.name === "CanceledError") throw error;
      // Опис запиту в повідомленні: без нього незрозуміло, що саме не сподобалось.
      const overflow = error?.response?.data?.error;
      if (overflow?.type === "exceed_context_size_error") {
        throw new Error(
          `Запит не вмістився в контекст моделі: ${overflow.n_prompt_tokens} токенів ` +
            `проти ${overflow.n_ctx} доступних. Збільште walkthrough.visionNumCtx або ` +
            `зменште walkthrough.maxImageWidth чи walkthrough.maxDocsCharsForVision у конфізі.`,
        );
      }
      const shape =
        `модель ${payload.model}, зображень ${images.length}, ` +
        `base64 ${images[0] ? images[0].length : 0} символів, ` +
        `system ${payload.system ? "є" : "немає"}, format ${payload.format ? "схема" : "немає"}`;
      throw describeOllamaError(error, shape);
    }
  }

  /**
   * Текстовий запит до чат-моделі з довільною JSON-схемою відповіді.
   * Потрібен режиму `plan` модуля walkthrough: там план кроків готує звичайна
   * чат-модель, а форму відповіді (масив кроків) задає схема, а не парсер.
   *
   * generateChatResponse() для цього не годиться: у ньому схема захардкоджена
   * під класифікатор RAG (isMatch/reason/sourceId), і чіпати її не можна —
   * на неї спирається src/user/parseAnswer.js.
   *
   * @param {Object} params - {prompt, system, format, signal, timeoutMs, temperature, numPredict, numCtx, seed, model}
   * @returns {Promise<Object>} - повна відповідь Ollama.
   */
  async generateStructuredResponse({
    prompt,
    system = null,
    format = null,
    signal = null,
    timeoutMs = 120000,
    temperature = 0.1,
    numPredict = 800,
    numCtx = 8192,
    seed = undefined,
    model = null,
  }) {
    if (!prompt) throw new Error("generateStructuredResponse: не вказано промпт.");

    const payload = {
      model: model || this.chatModel,
      prompt,
      stream: false,
      keep_alive: "5m",
      options: {
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1,
        num_ctx: numCtx,
        num_predict: numPredict,
      },
    };
    const effectiveSeed = seed !== undefined ? seed : config.rag?.seed;
    if (
      effectiveSeed !== null &&
      effectiveSeed !== undefined &&
      Number.isFinite(Number(effectiveSeed))
    ) {
      payload.options.seed = Number(effectiveSeed);
    }
    if (system) payload.system = system;
    if (format) payload.format = format;

    const response = await axios.post(`${this.baseUrl}/api/generate`, payload, {
      signal: signal || undefined,
      timeout: timeoutMs,
    });
    return response.data;
  }

  /**
   * Генерує ключові слова та наміри для програми (Document Expansion).
   * @param {string} appName - Назва програми.
   * @param {string} context - Короткий опис програми з документації.
   * @returns {Promise<string>} - Згенеровані ключові слова через кому.
   */
  async generateKeywords(appName, context) {
    const prompt = `You are a macOS search optimization expert. Based on the excerpt for the app "${appName}", generate a paragraph of 5-7 natural search queries, questions, or commands that a user would type to find this app in Ukrainian.
CRITICAL RULES:
1. Write them as natural, complete sentences separated by periods. NO comma-separated lists, NO bullets.
2. Use BOTH formal terms and common colloquial synonyms (e.g., use "дзвінок" instead of just "виклик", "фотка" instead of "зображення"). This is crucial for search!
3. The queries MUST be STRICTLY RELEVANT to the app's actual purpose.
4. DO NOT copy the examples below. They are just formatting examples!
   Example for a voice app: "Як записати голос? Мені треба створити аудіо."
   Example for a photo app: "Як відредагувати фотографію? Обрізати зображення."

Excerpt:
${context}`;

    const response = await axios.post(`${this.baseUrl}/api/generate`, {
      model: this.chatModel,
      prompt: prompt,
      system:
        "You are an expert search engine optimizer. Focus on creative, diverse, and natural phrasing.",
      stream: false,
      keep_alive: "5m",
      options: {
        temperature: 0.7, // Вища креативність для генерації синонімів
        num_ctx: 2048,
        num_predict: 200,
      },
    });

    return response.data.response.trim();
  }

  /**
   * Завантажує модель через HTTP-API Ollama (`POST /api/pull`).
   * Ollama віддає стрімінг JSON-lines; кожен рядок перетворюємо на виклик
   * onProgress(msg, pct) — так само, як інші довгі операції проєкта.
   *
   * @param {string} model - Назва моделі, напр. "qwen3:1.7b".
   * @param {Function} onProgress - Колбек прогресу (msg, pct|null).
   * @returns {Promise<{model: string, status: string}>}
   */
  async pull(model, onProgress = () => {}) {
    if (!model) throw new Error("Не вказано модель для завантаження.");

    const response = await axios.post(
      `${this.baseUrl}/api/pull`,
      { model, stream: true },
      { responseType: "stream", timeout: 0 },
    );

    const lines = readline.createInterface({ input: response.data, crlfDelay: Infinity });
    let lastStatus = "";
    let failure = null;

    for await (const line of lines) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // Неповний або нечитабельний рядок — пропускаємо
      }

      if (event.error) {
        failure = new Error(`Ollama відмовила у завантаженні «${model}»: ${event.error}`);
        break;
      }

      lastStatus = event.status || lastStatus;
      const pct =
        Number(event.total) > 0 && Number.isFinite(Number(event.completed))
          ? Math.max(0, Math.min(100, Math.round((event.completed / event.total) * 100)))
          : null;
      onProgress(`${model}: ${lastStatus}`, pct);
    }

    lines.close();
    if (failure) throw failure;
    return { model, status: lastStatus || "success" };
  }
}

export const ollama = new OllamaService();
