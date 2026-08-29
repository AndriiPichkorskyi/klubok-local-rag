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

import { config } from "../config/config.js";
import { getPlatformAdapter } from "../platform/index.js";
import { ollama, isModelInstalled, resolveModelLists } from "../services/ollama.service.js";

/** Моделі зі списку, яких немає серед встановлених. */
function missingFrom(wantedList, installed) {
  return (wantedList || []).filter((model) => !isModelInstalled(model, installed));
}

/**
 * Первинна перевірка системи (RPC-метод `bootstrap.check`).
 * Ніколи не кидає виняток через недоступну Ollama чи непідтримувану ОС —
 * це нормальні стани, які треба показати користувачу, а не аварія.
 *
 * @param {Function} onProgress - колбек (msg, pct|null); потрібен лише для autoPull.
 * @returns {Promise<Object>} звіт про готовність
 */
export async function check(onProgress = () => {}) {
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

  // Списки моделей — з одного джерела (див. resolveModelLists), інакше
  // config.ollama і config.bootstrap.requiredModels мовчки розходяться.
  const { required, optional } = resolveModelLists();

  let ollamaStatus = await ollama.checkAvailability();
  let installed = ollamaStatus.installedModels;
  let missingRequired = ollamaStatus.isAvailable ? missingFrom(required, installed) : [...required];

  // config.bootstrap.autoPull: раніше прапорець не читав ніхто. Тепер він
  // робить рівно те, що обіцяє його опис у конфізі, — тягне відсутні
  // обов'язкові моделі. За замовчуванням вимкнений: це гігабайти трафіку.
  const pulled = [];
  if (config.bootstrap?.autoPull === true && ollamaStatus.isAvailable && missingRequired.length) {
    for (const model of missingRequired) {
      onProgress(`autoPull: завантажуємо модель ${model}...`, null);
      await ollama.pull(model, onProgress);
      pulled.push(model);
    }
    ollamaStatus = await ollama.checkAvailability();
    installed = ollamaStatus.installedModels;
    missingRequired = ollamaStatus.isAvailable ? missingFrom(required, installed) : [...required];
  }

  const missingOptional = ollamaStatus.isAvailable
    ? missingFrom(optional, installed)
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
      installedModels: installed,
    },
    models: { required, optional, missingRequired, missingOptional, autoPulled: pulled },
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
