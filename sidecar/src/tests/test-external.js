import pLimit from "p-limit";
import fs from "fs/promises";
import path from "path";
import pc from "picocolors";
import { processQuery } from "../modules/rag/engine.js";
import { ollama } from "../services/ollama.service.js";
import { config } from "../config/config.js";
import { db } from "../services/db.service.js";
import { fileURLToPath } from "url";
import { renderReportTable } from "../cli/reports.js";
import { logger } from "../services/logger.service.js";
import { createReportStream } from "./report-stream.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadDataset(filename) {
  const data = await fs.readFile(path.join(__dirname, filename), "utf8");
  return JSON.parse(data);
}

/**
 * EXTERNAL-тести на зовнішніх датасетах (intents, OOD, ambiguous).
 *
 * Функція НЕ завершує процес і НЕ лишає по собі змінений глобальний config:
 * і те, і те вбивало б RPC-сервер або тихо міняло поведінку решти сесії.
 *
 * @param {Function} onProgress - необов'язковий колбек (msg, pct|null).
 * @returns {Promise<{ok: boolean, totalCases: number, passed: number,
 *                    failed: number, passRate: number, reportPath: string}>}
 */
export async function runExternalTests(onProgress = () => {}) {
  console.log(pc.bgCyan(pc.black(" ЗАПУСК EXTERNAL ТЕСТУВАННЯ (Hybrid + XML + Reorder | 4b) ")));

  // Перевірка моделі (якщо користувач має на увазі embedding модель 4b)
  if (!config.embedModelName.includes("4b")) {
    console.warn(
      pc.yellow(
        `⚠️ Поточна EMBED_MODEL = ${config.embedModelName}. Рекомендується перезапустити скрипт з EMBED_MODEL=qwen3-embedding:4b`,
      ),
    );
  }

  const status = await ollama.checkAvailability();
  if (!status.isAvailable) {
    throw new Error(
      `Ollama не запущена (${status.error || "немає з'єднання"}) — тести не можуть стартувати.`,
    );
  }

  onProgress("Прогрів моделей Ollama...", null);
  process.stdout.write("🔥 Прогрів моделей Ollama... ");
  await ollama.warmup();
  console.log(pc.green("Готово!"));

  await db.init();

  // Той самий журнал і те саме спостереження за пам'яттю, що й у RAG-бенчмарку:
  // 312 зовнішніх кейсів — теж довга операція, і вона теж має лишати слід.
  await logger.init();
  logger.installProcessHandlers({ role: "test-external" });
  logger.startMemoryWatch();
  const unsubscribeMemoryWarning = logger.onMemoryWarning((text) => onProgress(text, null));

  /** Потік звіту. Оголошений тут, щоб finally міг закрити його і після збою. */
  let report = null;

  // Режим тесту фіксований, але config глобальний: запам'ятовуємо попередні
  // значення і повертаємо їх у finally, інакше після одного запуску вся
  // сесія (і метод config.get) працює вже з іншими налаштуваннями.
  const savedRag = {
    searchMode: config.rag.searchMode,
    enableXmlTags: config.rag.enableXmlTags,
    enableContextReordering: config.rag.enableContextReordering,
  };
  try {
    config.rag.searchMode = "hybrid";
    config.rag.enableXmlTags = true;
    config.rag.enableContextReordering = true;

    const intents = await loadDataset("dataset_intents.json");
    const ood = await loadDataset("dataset_ood.json");
    const ambiguous = await loadDataset("dataset_ambiguous.json");

    // Маппінг Bundle ID -> App Name
    async function getAppNames(bundleIds) {
      if (!bundleIds || bundleIds.length === 0) return [];
      const placeholders = bundleIds.map(() => "?").join(",");
      const rows = await db.sqliteDb.all(
        `SELECT name FROM apps WHERE id IN (${placeholders})`,
        bundleIds,
      );
      return rows.map((r) => r.name);
    }

    const TEST_CASES = [];

    for (const item of intents) {
      const appNames = await getAppNames(
        item.acceptableApplicationIdentifiers || [item.expectedApplicationIdentifier],
      );
      if (appNames.length > 0) {
        TEST_CASES.push({
          query: item.query,
          expectedApp: appNames,
          type: "valid",
          category: "intents",
        });
      }
    }

    for (const item of ood) {
      TEST_CASES.push({
        query: item.query,
        expectedApp: [],
        type: "not_found",
        category: "ood",
      });
    }

    // Для ambiguous приймаємо або Not Found, або будь-яку з acceptable
    for (const item of ambiguous) {
      // В цьому датасеті capabilityIds, а не bundle IDs. Доведеться ігнорувати точну перевірку,
      // але ми знаємо, що allowUnknown: true. Просто будемо перевіряти, як LLM реагує.
      TEST_CASES.push({
        query: item.query,
        expectedApp: [],
        type: "ambiguous",
        category: "ambiguous",
      });
    }

    console.log(`\nВсього завантажено ${TEST_CASES.length} зовнішніх тестів.`);

    let passed = 0;
    let failed = 0;
    let doneRuns = 0;
    const startTime = Date.now();

    // Звіт пишемо на диск поступово: результати не накопичуються в пам'яті,
    // лишаються самі лічильники (див. tests/report-stream.js).
    const reportsDir = path.join(config.paths.sidecarDir, "test-reports");
    await fs.mkdir(reportsDir, { recursive: true });
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportsDir, `report-external-${dateStr}.json`);
    const reportHeader = {
      timestamp: new Date().toISOString(),
      totalCases: TEST_CASES.length,
      models: {
        embed: config.embedModelName,
        chat: config.ollama.chatModel,
      },
    };
    report = createReportStream(reportPath, reportHeader);
    await report.beginMode("external_hybrid");
    const acc = {
      count: 0,
      timeMs: 0,
      tpsSum: 0,
      tpsCount: 0,
      memSum: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    const CONCURRENCY = config.rag.testConcurrency;
    const limit = pLimit(CONCURRENCY);
    let testIndexCounter = 0;

    const batchPromises = TEST_CASES.map((test) =>
      limit(async () => {
        const testIndex = testIndexCounter++;
        const queryStart = Date.now();
        const result = await processQuery(test.query, () => {});
        const queryTime = Date.now() - queryStart;

        let tps = 0,
          inputTokens = 0,
          outputTokens = 0,
          ttft = 0;
        if (result.ollamaMetrics) {
          inputTokens = result.ollamaMetrics.prompt_eval_count || 0;
          outputTokens = result.ollamaMetrics.eval_count || 0;
          if (result.ollamaMetrics.prompt_eval_duration) {
            ttft = result.ollamaMetrics.prompt_eval_duration / 1e9;
          }
          if (result.ollamaMetrics.eval_duration) {
            tps = outputTokens / (result.ollamaMetrics.eval_duration / 1e9);
          }
        }
        const memUsageMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

        const { response, recommendedApp } = result;
        console.log(
          `${pc.blue(`[Тест ${testIndex + 1}/${TEST_CASES.length} | ${test.category}]:`)} "${test.query}" -> ${pc.yellow(recommendedApp)}`,
        );
        doneRuns++;
        onProgress(
          `${doneRuns}/${TEST_CASES.length} [${test.category}]: "${test.query}"`,
          Math.round((doneRuns / TEST_CASES.length) * 100),
        );
        logger.setStage("externalBenchmark", {
          doneRuns,
          totalRuns: TEST_CASES.length,
          category: test.category,
        });

        let isSuccess = false;
        let reason = "";

        if (test.type === "valid") {
          const expected = test.expectedApp;
          const isMatch = expected.some(
            (app) => app.toLowerCase() === recommendedApp.toLowerCase(),
          );
          // contextApps, а не alternativeApps: останній навмисно порожній, коли
          // рекомендації немає, а тут ми міряємо якість пошуку, а не вибір LLM.
          const isAlternativeMatch = (result.contextApps || []).some((app) =>
            expected.some((expApp) => expApp.toLowerCase() === app.toLowerCase()),
          );

          if (isMatch || isAlternativeMatch) {
            isSuccess = true;
          } else {
            reason = `Очікувалося: ${expected.join(" або ")}, Отримано: ${recommendedApp}`;
          }
        } else if (test.type === "not_found") {
          if (
            recommendedApp === "NOT_FOUND" ||
            recommendedApp === "INVALID_QUERY" ||
            response.toLowerCase().includes("не вдалося знайти")
          ) {
            isSuccess = true;
          } else {
            reason = `Очікувалося NOT_FOUND, але рекомендовано: ${recommendedApp}`;
          }
        } else if (test.type === "ambiguous") {
          // Для ambiguous ми приймаємо NOT_FOUND, або будь-яку рекомендацію, оскільки запит неоднозначний.
          // Головне, щоб LLM не впала.
          isSuccess = true;
          if (recommendedApp === "NOT_FOUND") reason = "Визнано як Unknown (це ок)";
          else reason = `Рекомендовано: ${recommendedApp}`;
        }

        if (isSuccess) passed++;
        else failed++;

        if (!isSuccess) {
          console.log(pc.red(`   ❌ ФЕЙЛ: ${reason}`));
        } else {
          console.log(pc.green(`   ✅ ПАС`));
        }

        // Результат одразу лягає на диск і більше не тримається в пам'яті.
        acc.count += 1;
        acc.timeMs += queryTime;
        acc.memSum += memUsageMB;
        acc.inputTokens += inputTokens;
        acc.outputTokens += outputTokens;
        if (tps > 0) {
          acc.tpsSum += tps;
          acc.tpsCount += 1;
        }
        await report.addResult({
          query: test.query,
          expected: test.expectedApp ? test.expectedApp.join(", ") : test.type,
          got: recommendedApp,
          success: isSuccess,
          timeMs: queryTime,
          ttft,
          tps,
          memory: memUsageMB,
          inputTokens,
          outputTokens,
        });
      }),
    );

    await Promise.all(batchPromises);

    const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const passRate = ((passed / TEST_CASES.length) * 100).toFixed(1);

    console.log(`\n${pc.bgGreen(pc.black(` ТЕСТУВАННЯ ЗАВЕРШЕНО ЗА ${totalTimeSec} сек `))}`);
    console.log(`Успішно: ${pc.green(passed)}, Провалено: ${pc.red(failed)}`);
    console.log(`Pass Rate: ${pc.yellow(`${passRate}%`)}\n`);

    // Ті самі підсумки, але з лічильників, а не з масиву результатів.
    const modeSummary = {
      passed,
      failed,
      passRate: parseFloat(passRate),
      totalTimeMs: acc.timeMs,
      avgTps: acc.tpsCount > 0 ? acc.tpsSum / acc.tpsCount : 0,
      avgMem: acc.memSum / (acc.count || 1),
      totalInputTokens: acc.inputTokens,
      totalOutputTokens: acc.outputTokens,
    };
    await report.endMode(modeSummary);
    // Хвіст звіту і зняття суфікса .partial — самі результати вже на диску.
    await report.close();

    // Для таблиці в терміналі потрібні лише підсумки, не результати.
    const reportSummary = { ...reportHeader, modes: { external_hybrid: { summary: modeSummary } } };

    // Вивід таблиці порівняння
    renderReportTable(reportSummary);
    console.log(`📁 Детальний звіт збережено у: ${reportPath}\n`);

    onProgress("EXTERNAL-тести завершено.", 100);

    return {
      ok: failed === 0,
      totalCases: TEST_CASES.length,
      passed,
      failed,
      passRate: parseFloat(passRate),
      reportPath,
    };
  } finally {
    // Відновлюємо конфіг навіть якщо тест упав посередині.
    Object.assign(config.rag, savedRag);
    // Прогін обірвався — не лишаємо відкритий дескриптор. Недописаний звіт
    // лишається файлом *.json.partial.
    if (report) await report.abort();
    logger.setStage("externalBenchmark", null);
    unsubscribeMemoryWarning();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Термінальний запуск: рішення про долю процесу ухвалюється тут, а не в тесті.
  runExternalTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(pc.red(err.message));
      process.exit(1);
    });
}
