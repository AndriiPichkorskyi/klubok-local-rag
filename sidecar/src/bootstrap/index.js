/**
 * Файл: src/bootstrap/index.js
 * Опис: Модуль 2.1 — первинна ініціалізація. Відповідає на єдине питання:
 *       «чи готова система до роботи, а якщо ні — що саме зробити».
 *       Перевіряє ОС (через адаптер платформи), доступність Ollama і
 *       наявність моделей із config.bootstrap.
 *
 *       Модуль навмисно не чіпає БД: він мусить працювати навіть тоді,
 *       коли все інше зламане.
 */

import os from "os";
import axios from "axios";

import { config } from "../config/config.js";
import { getPlatformAdapter } from "../platform/index.js";
import { ollama } from "../services/ollama.service.js";

/** Скільки чекаємо на відповідь Ollama під час перевірки живості. */
const TAGS_TIMEOUT_MS = 5000;

/**
 * Питає в Ollama список встановлених моделей.
 * Ollama лежить — це не виняток, а звичайний результат перевірки.
 * @returns {Promise<{isAvailable: boolean, models: string[], error: string|null}>}
 */
async function fetchInstalledModels(baseUrl) {
  try {
    const { data } = await axios.get(`${baseUrl}/api/tags`, { timeout: TAGS_TIMEOUT_MS });
    const models = Array.isArray(data?.models)
      ? data.models.map((m) => m.name).filter(Boolean)
      : [];
    return { isAvailable: true, models, error: null };
  } catch (error) {
    return { isAvailable: false, models: [], error: error.message };
  }
}

/**
 * Чи встановлена модель. Ollama віддає назви з тегом ("qwen3:1.7b"),
 * а модель без тега в конфізі відповідає тегу ":latest".
 * @param {string} wanted
 * @param {string[]} installed
 */
function isModelInstalled(wanted, installed) {
  if (installed.includes(wanted)) return true;
  if (!wanted.includes(":")) return installed.includes(`${wanted}:latest`);
  return false;
}

/** Моделі зі списку, яких немає серед встановлених. */
function missingFrom(wantedList, installed) {
  return (wantedList || []).filter((model) => !isModelInstalled(model, installed));
}

/**
 * Первинна перевірка системи (RPC-метод `bootstrap.check`).
 * Ніколи не кидає виняток через недоступну Ollama чи непідтримувану ОС —
 * це нормальні стани, які треба показати користувачу, а не аварія.
 *
 * @returns {Promise<Object>} звіт про готовність
 */
export async function check() {
  const adapter = getPlatformAdapter();
  const baseUrl = config.ollama.baseUrl;

  const platform = {
    os: process.platform,
    name: adapter.name,
    arch: process.arch,
    release: os.release(),
    supported: adapter.supported === true,
    reason: adapter.supported ? null : adapter.reason || "Адаптер цієї ОС не реалізовано.",
  };

  // Директорії питаємо лише в робочого адаптера: заглушка на це чесно відмовляє.
  const scanDirs = platform.supported ? adapter.getScanDirs() : null;

  const ollamaStatus = await fetchInstalledModels(baseUrl);
  const required = config.bootstrap?.requiredModels || [];
  const optional = config.bootstrap?.optionalModels || [];
  const missingRequired = ollamaStatus.isAvailable
    ? missingFrom(required, ollamaStatus.models)
    : [...required];
  const missingOptional = ollamaStatus.isAvailable
    ? missingFrom(optional, ollamaStatus.models)
    : [...optional];

  const ready = platform.supported && ollamaStatus.isAvailable && missingRequired.length === 0;

  const actions = [];
  if (!platform.supported) {
    actions.push(`ОС не підтримується: ${platform.reason}`);
  }
  if (!ollamaStatus.isAvailable) {
    actions.push(
      `Ollama не відповідає на ${baseUrl} (${ollamaStatus.error}). ` +
        "Запустіть Ollama (команда `ollama serve` або застосунок Ollama) і повторіть перевірку.",
    );
  } else {
    for (const model of missingRequired) {
      actions.push(
        `Немає обов'язкової моделі «${model}». Завантажте її: bootstrap.pullModel({model:"${model}"}) ` +
          `або в терміналі \`ollama pull ${model}\`.`,
      );
    }
    for (const model of missingOptional) {
      actions.push(`Необов'язково: моделі «${model}» немає, частина сценаріїв буде недоступна.`);
    }
  }

  return {
    platform,
    scanDirs,
    ollama: {
      baseUrl,
      isAvailable: ollamaStatus.isAvailable,
      error: ollamaStatus.error,
      installedModels: ollamaStatus.models,
    },
    models: { required, optional, missingRequired, missingOptional },
    ready,
    actions,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Завантаження моделі з прогресом (RPC-метод `bootstrap.pullModel`).
 * Уся робота з HTTP-стрімом Ollama живе в ollama.service.pull().
 *
 * @param {string} model - назва моделі
 * @param {Function} onProgress - колбек (msg, pct|null)
 */
export async function pullModel(model, onProgress = () => {}) {
  if (!model || typeof model !== "string") {
    throw new Error("Не вказано параметр `model` — нема чого завантажувати.");
  }
  onProgress(`Завантаження моделі ${model}...`, null);
  return await ollama.pull(model, onProgress);
}

export default { check, pullModel };
