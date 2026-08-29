/**
 * Файл: src/services/ollama.service.js
 * Опис: Клас-обгортка для взаємодії з локальним сервером Ollama.
 *       Використовується для генерації ембедингів (векторів) та відповідей LLM.
 */

import axios from "axios";
import readline from "readline";
import { config } from "../config/config.js";

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
   * @param {string} prompt - Текст промпту.
   * @returns {Promise<string>} - Згенерований текст.
   */
  async generateChatResponse(prompt, enableJsonFormat = false, systemPrompt = null) {
    const payload = {
      model: this.chatModel,
      prompt: prompt,
      stream: false,
      keep_alive: "5m",
      options: {
        temperature: 0.1,    // Для JSON-парсингу потрібна низька креативність
        seed: 42,
        num_ctx: 4096,
        num_predict: 400,
      }
    };
    
    // Якщо передано кастомний системний промпт - використовуємо його
    if (systemPrompt) {
      payload.system = systemPrompt;
    } else if (enableJsonFormat) {
      payload.system = "You are a highly analytical classification engine. Your task is to output STRICTLY valid JSON based on the schema provided. Base your decision EXCLUSIVELY on the Context provided. Do not invent any information.";
    }
    
    if (enableJsonFormat) {
      payload.format = {
        type: "object",
        properties: {
          isMatch: { type: "boolean" },
          reason: { type: "string" },
          sourceId: { type: "integer" }
        },
        required: ["isMatch", "reason"]
      };
    }
    const response = await axios.post(`${this.baseUrl}/api/generate`, payload);
    return response.data; // Повертаємо весь об'єкт, щоб мати доступ до метрик (total_duration, eval_count тощо)
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
      system: "You are an expert search engine optimizer. Focus on creative, diverse, and natural phrasing.",
      stream: false,
      keep_alive: "5m",
      options: {
        temperature: 0.7, // Вища креативність для генерації синонімів
        num_ctx: 2048,
        num_predict: 200,
      }
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
