/**
 * Файл: src/cli/index.js
 * Опис: Відповідає за графічний інтерфейс командного рядка (CLI) за допомогою
 *       бібліотеки @clack/prompts. Дозволяє користувачу взаємодіяти з системою
 *       (сканувати, векторизувати, ставити запитання).
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { config } from "../config/config.js";
import { db } from "../services/db.service.js";
import { ollama } from "../services/ollama.service.js";
import { measureTime, formatExecutionTime } from "./utils.js";
import { processQuery } from "../modules/rag/engine.js";
import { runRagTests } from "../tests/test-rag.js";
import { runExternalTests } from "../tests/test-external.js";
import { handleViewReports } from "./reports.js";
marked.setOptions({ renderer: new TerminalRenderer() });
function runProcess(scriptPath, envModel) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (envModel) env.EMBED_MODEL = envModel;
    const child = spawn("node", [scriptPath], { stdio: "inherit", env });
    child.on("close", resolve);
  });
}

/** Моделі ембедингу з конфіга без зашитих у CLI назв. */
function configuredEmbedModels() {
  return [...new Set([config.embedModelName, ...(config.embedModels || [])].filter(Boolean))];
}


import {
  runScanApps,
  runFetchDocs,
  runFetchLocalDocs,
  runKeywordAugmentation,
  runVectorize,
  runVectorizeIntents,
} from "../modules/indexer/pipeline.js";

/**
 * Головний цикл інтерактивного меню.
 */

/**
 * Декоратор (Higher-Order Function) для відтворення звуку після завершення довгої операції
 */
function withSound(fn) {
  return async (...args) => {
    try {
      await fn(...args);
      // Успішний звук
      process.stdout.write("\x07");
      import("node:child_process")
        .then((cp) => cp.exec("afplay /System/Library/Sounds/Glass.aiff").unref())
        .catch(() => {});
    } catch (e) {
      // Звук помилки
      import("node:child_process")
        .then((cp) => cp.exec("afplay /System/Library/Sounds/Basso.aiff").unref())
        .catch(() => {});
      throw e;
    }
  };
}

export async function runCLI() {
  p.intro(pc.bgCyan(pc.black(" macOS RAG CLI ")));

  const s = p.spinner();
  s.start("Перевірка з'єднання з Ollama...");
  const status = await ollama.checkAvailability();
  if (!status.isAvailable) {
    s.stop(pc.red("Ollama не запущена! Будь ласка, запустіть Ollama."));
    process.exit(1);
  }
  if (status.missingModels.length > 0) {
    s.stop(pc.yellow(`Відсутні моделі: ${status.missingModels.join(", ")}`));
    p.note(`Запустіть: ollama pull <model_name>`, "Увага");
  } else {
    s.message("Прогрів моделей Ollama...");
    await ollama.warmup();
    s.stop(pc.green("Ollama готова до роботи."));
  }

  let running = true;
  while (running) {
    const action = await p.select({
      message: "Головне меню. Що ви хочете зробити?",
      options: [
        { value: "query", label: "🔍 Задати питання (Пошук інструменту)" },
        { value: "update_menu", label: "🔄 Оновлення бази (Сканування, Довідка, Вектори)" },
        { value: "clear_menu", label: "⚙️  Очистити базу даних" },
        { value: "stats", label: "📊 Переглянути статистику" },
        { value: "test", label: "🤖 Запустити автоматичне тестування (RAG Benchmark)" },
        { value: "test_external", label: "🧬 Запустити EXTERNAL тестування (Intents, OOD, Ambiguous)" },
        { value: "reports", label: "🧪 Переглянути тестові звіти (Automated Tests)" },
        { value: "exit", label: "❌ Вихід" },
      ],
    });

    if (p.isCancel(action) || action === "exit") {
      running = false;
      break;
    }

    switch (action) {
      case "query":
        await handleQuery();
        break;
      case "update_menu":
        await handleUpdateMenu();
        break;
      case "clear_menu":
        await handleClear();
        break;

      case "test":
        await withSound(handleTest)();
        break;
      case "test_external":
        await withSound(handleExternalTest)();
        break;
      case "reports":
        await handleViewReports();
        break;
      case "stats":
        await handleStats();
        break;
    }
  }

  p.outro(pc.green("Дякую за використання macOS RAG CLI!"));
}

async function handleUpdateMenu() {
  const updateAction = await p.select({
    message: "Оновлення бази. Оберіть дію:",
    options: [
      {
        value: "full_sync_test_all",
        label: `🌓 Повне оновлення всіх моделей (${configuredEmbedModels().join(", ")}) + 🤖 Тестування`,
      },
      {
        value: "full_sync_test",
        label: "🚀 Повне оновлення + 🤖 Тестування",
      },
      {
        value: "full_sync",
        label: "🛸 Повне оновлення (Сканування + Довідка + Наміри + Вектори)",
      },
      { value: "scan", label: "1️⃣  Тільки сканувати програми" },
      { value: "fetch", label: "2️⃣  Тільки завантажити довідку" },
      { value: "keywords", label: "✨ Тільки згенерувати наміри (Keyword Augmentation)" },
      { value: "vectorize_intents", label: "🏷️ Тільки побудувати вектори для намірів" },
      { value: "vectorize", label: "3️⃣  Тільки побудувати вектори" },
      { value: "back", label: "🔙 Повернутися назад" },
    ],
  });

  if (p.isCancel(updateAction) || updateAction === "back") return;

  switch (updateAction) {
    case "full_sync_test_all":
      await withSound(async () => {
        await handleFullSyncAll();

        // Після оновлення запускаємо тести для обох
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const script = path.join(__dirname, "..", "tests", "run-all-tests.js");



        await runProcess(script, null);
      })();
      break;
    case "full_sync_test":
      await withSound(async () => {
        await handleFullSync();
        await handleTest();
      })();
      break;
    case "full_sync":
      await withSound(handleFullSync)();
      break;
    case "scan":
      await withSound(handleScan)();
      break;
    case "fetch":
      await withSound(handleFetch)();
      break;
    case "keywords":
      await withSound(handleKeywords)();
      break;
    case "vectorize_intents":
      await withSound(handleVectorizeIntents)();
      break;
    case "vectorize":
      await withSound(async () => {
        await handleVectorize();
        await handleVectorizeIntents();
      })();
      break;
  }
}

async function handleTest() {
  const models = configuredEmbedModels();
  const modelChoice = await p.select({
    message: "Оберіть модель для тестування (RAG Benchmark):",
    options: [
      { value: "all", label: `Усі з конфіга (${models.join(", ")})` },
      ...models.map((model) => ({ value: model, label: model })),
      { value: "back", label: "🔙 Повернутися назад" },
    ],
  });

  if (p.isCancel(modelChoice) || modelChoice === "back") return;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);



  console.clear();

  if (modelChoice === "all") {
    const script = path.join(__dirname, "..", "tests", "run-all-tests.js");
    await runProcess(script, null);
  } else {
    console.log(pc.bgBlue(pc.white(`🚀 ЗАПУСК ТЕСТІВ ДЛЯ МОДЕЛІ: ${modelChoice} `)));
    const script = path.join(__dirname, "..", "tests", "test-rag.js");
    await runProcess(script, modelChoice);
  }

  p.log.success("Тестування завершено. Перегляньте звіти в меню.");
}

async function handleExternalTest() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  console.log(pc.bgBlue(pc.white(`🚀 ЗАПУСК EXTERNAL ТЕСТІВ (Hybrid + XML + Reorder | ${config.embedModelName}) `)));
  const script = path.join(__dirname, "..", "tests", "test-external.js");
  await runProcess(script, config.embedModelName);
  p.log.success("External тестування завершено.");
}

async function handleQuery() {
  const query = await p.text({
    message: 'Опишіть ваше завдання (наприклад, "How can I compress a video?"):',
    placeholder: "Введіть запит...",
  });

  if (p.isCancel(query) || !query.trim()) return;

  const s = p.spinner();
  s.start("Підготовка до пошуку...");

  try {
    const { result, executionTimeMs } = await measureTime(() =>
      processQuery(query, (msg) => {
        s.message(msg);
      }),
    );
    s.stop(`Готово за ${formatExecutionTime(executionTimeMs)}`);

    // Використовуємо marked для красивого рендеру Markdown у терміналі
    p.outro(pc.bgMagenta(pc.white(" Результат LLM ")));
    console.log(marked(result.response));

    if (result.alternativeApps && result.alternativeApps.length > 0) {
      console.log(pc.yellow(`🔍 Також можуть допомогти: ${result.alternativeApps.join(", ")}`));
    }

    if (result.rawLlmOutput) {
      console.log(
        "" +
          pc.bgBlue(pc.white(" Сирий вивід від LLM ")) +
          "" +
          pc.gray(result.rawLlmOutput) +
          "",
      );
    }

    if (result.contextApps && result.contextApps.length > 0) {
      p.log.info(pc.gray(`Додатки в контексті: ${result.contextApps.join(", ")}`));
    }

    // Запит фідбеку
    const feedback = await p.select({
      message: "Чи була ця відповідь корисною?",
      options: [
        { value: "exact_match", label: "✅ Точне співпадіння" },
        {
          value: "in_list_not_first",
          label: "⚠️ Запропонована програма є в списку, але не на першому місці",
        },
        { value: "no_match", label: "❌ Немає співпадінь" },
        { value: "other", label: "❓ Інше" },
      ],
    });

    if (!p.isCancel(feedback)) {
      // Логуємо результати
      // Оскільки виокремити саму назву програми з довільного тексту LLM важко без додаткового виклику LLM,
      // ми записуємо всю відповідь, але ви можете додати логіку парсингу тут за потреби.
      const { logger } = await import("../services/logger.service.js");
      await logger.init(); // Обов'язково створюємо папку logs, якщо її немає

      await logger.logQueryWithFeedback(
        query,
        result.contextApps,
        result.recommendedApp,
        result.response,
        result.rawLlmOutput,
        result.retrievalStats,
        feedback,
      );
      p.log.success("Дякуємо за фідбек! Його збережено в логах.");
    }
  } catch (error) {
    s.stop(pc.red("Виникла помилка під час обробки запиту."));
    p.log.error(error.message);
  }
}

async function handleFullSync() {
  p.note(
    "Запуск повного циклу оновлення бази даних. Це може зайняти деякий час.",
    "🚀 Повне оновлення",
  );
  await handleScan();
  await handleFetch();
  await handleKeywords();
  await handleVectorize();
  p.log.success(pc.green("✅ Повне оновлення бази успішно завершено!"));
}

async function handleFullSyncAll() {
  const models = configuredEmbedModels();
  p.note(
    `Запуск повного циклу оновлення та векторизації для моделей: ${models.join(", ")}.`,
    "🚀 Повне оновлення (усі моделі)",
  );
  await handleScan();
  await handleFetch();
  await handleKeywords();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const vectorizeScript = path.join(__dirname, "run-vectorize.js");

  for (const model of models) {
    console.log(pc.bgBlue(pc.white(` 🔄 ВЕКТОРИЗАЦІЯ ДЛЯ ${model} `)));
    await runProcess(vectorizeScript, model);
  }

  p.log.success(pc.green("✅ Повне оновлення бази для всіх моделей успішно завершено!"));
}

async function handleScan() {
  const s = p.spinner();
  s.start("Сканування...");
  try {
    const { result, executionTimeMs } = await measureTime(() =>
      runScanApps((msg) => s.message(msg)),
    );
    s.stop(`Сканування завершено за ${formatExecutionTime(executionTimeMs)}`);
    p.log.success(`Додано/оновлено програм: ${result}`);
  } catch (err) {
    s.stop(pc.red("Помилка сканування."));
    p.log.error(err.message);
  }
}

async function handleFetch() {
  const s = p.spinner();
  s.start("Завантаження документів...");
  try {
    const { result, executionTimeMs } = await measureTime(async () => {
      const resWeb = await runFetchDocs((msg) => s.message(msg));
      const resLocal = await runFetchLocalDocs((msg) => s.message(msg));
      
      return {
        docsCount: (resWeb?.docsCount || 0) + (resLocal?.docsCount || 0),
        mbDownloaded: resWeb?.mbDownloaded || "0"
      };
    });
    s.stop(`Завантаження завершено за ${formatExecutionTime(executionTimeMs)}`);
    p.log.success(
      `Збережено нових веб-документів: ${result.docsCount} (${result.mbDownloaded} MB)`,
    );
  } catch (err) {
    s.stop(pc.red("Помилка завантаження."));
    p.log.error(err.message);
  }
}

async function handleKeywords() {
  const s = p.spinner();
  s.start("Генерація ключових слів (Document Expansion)...");
  try {
    const { result: count, executionTimeMs } = await measureTime(() =>
      runKeywordAugmentation((msg) => s.message(msg)),
    );
    s.stop(pc.green(`✅ Згенеровано наміри для ${count} програм!`));
    p.log.info(pc.gray(`Час виконання: ${formatExecutionTime(executionTimeMs)}`));
  } catch (error) {
    s.stop(pc.red("Виникла помилка під час генерації ключових слів."));
    p.log.error(error.message);
  }
}

async function handleVectorize() {
  const s = p.spinner();
  s.start("Генерація векторів...");
  try {
    const { result, executionTimeMs } = await measureTime(() =>
      runVectorize((msg) => s.message(msg)),
    );
    s.stop(`Векторизація завершена за ${formatExecutionTime(executionTimeMs)}`);
    p.log.success(`Створено нових векторів (чанків): ${result}`);
  } catch (err) {
    s.stop(pc.red("Помилка векторизації."));
    p.log.error(err.message);
  }
}

async function handleVectorizeIntents() {
  const s = p.spinner();
  s.start("Векторизація намірів...");
  try {
    const { result, executionTimeMs } = await measureTime(() =>
      runVectorizeIntents((msg) => s.message(msg)),
    );
    s.stop(`Векторизація намірів завершена за ${formatExecutionTime(executionTimeMs)}`);
    p.log.success(`Створено векторів для намірів: ${result}`);
  } catch (err) {
    s.stop(pc.red("Помилка векторизації намірів."));
    p.log.error(err.message);
  }
}

async function handleStats() {
  const stats = await db.getStats();
  p.log.info(`Проіндексовано програм: ${pc.cyan(stats.appsCount)}`);
  p.log.info(`Загальна кількість векторних чанків: ${pc.cyan(stats.chunksCount)}`);
}

async function handleClear() {
  const table = await p.select({
    message: "Яку таблицю ви хочете очистити?",
    options: [
      { value: "all", label: "🧹 Очистити ВСЕ (повне скидання)" },
      { value: "clear_web", label: "🌐 Очистити тільки ВЕБ документи" },
      { value: "clear_local", label: "💻 Очистити тільки ЛОКАЛЬНУ довідку" },
      { value: "apps", label: "📱 Таблиця програм (SQLite)" },
      { value: "document_links", label: "🔗 Посилання на документацію (SQLite)" },
      { value: "raw_html", label: "💾 Сирий HTML код довідки (SQLite)" },
      { value: "web_documents", label: "📄 Очищений текст документації (SQLite)" },
      { value: "lancedb", label: "✨ Векторна база (LanceDB)" },
      { value: "intents", label: "🏷️ Очистити наміри (Ключові слова та їх вектори)" },
      { value: "back", label: "🔙 Повернутися назад" },
    ],
  });

  if (p.isCancel(table) || table === "back") return;

  const confirm = await p.confirm({
    message: pc.red(`Ви впевнені, що хочете очистити ${table}? Це незворотна дія.`),
  });

  if (confirm && !p.isCancel(confirm)) {
    const s = p.spinner();
    s.start("Очищення...");
    if (table === "intents") {
      await db.clearIntents();
    } else if (table === "clear_web") {
      await db.clearDocumentsByType("WEB");
    } else if (table === "clear_local") {
      await db.clearDocumentsByType("LOCAL");
    } else if (table === "all") {
      await db.clearAll();
    } else {
      await db.clearTable(table);
    }
    s.stop(pc.green(`Очищення ${table} успішно завершено.`));
  }
}
