import pLimit from "p-limit";
import fs from "fs/promises";
import path from "path";
import pc from "picocolors";
import { processQuery } from "../modules/rag/engine.js";
import { ollama } from "../services/ollama.service.js";
import { TEST_CASES } from "./test-cases.js";
import { config } from "../config/config.js";
import { db } from "../services/db.service.js";
import { renderReportTable } from "../cli/reports.js";
import { logger } from "../services/logger.service.js";
import { createReportStream } from "./report-stream.js";

/**
 * RAG-бенчмарк по всіх комбінаціях режимів.
 *
 * Функція НЕ завершує процес: рішення про exit ухвалює той, хто її викликав
 * з термінала (див. блок наприкінці файлу). З RPC-сервера вона виконується
 * всередині живого процесу, і `process.exit` убив би застосунок разом із ним.
 *
 * @param {Function} onProgress - необов'язковий колбек (msg, pct|null).
 * @returns {Promise<{ok: boolean, totalCases: number, passed: number,
 *                    failed: number, passRate: number, reportPath: string}>}
 */
export async function runRagTests(onProgress = () => {}) {
  console.log(pc.bgCyan(pc.black(" ЗАПУСК АВТОМАТИЗОВАНОГО ТЕСТУВАННЯ RAG")));

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

  // Ініціалізуємо БД перед тестами
  await db.init();

  // Бенчмарк — найдовша операція в системі, і саме на ній 26.08 зник sidecar.
  // Тому вмикаємо файловий журнал і зріз пам'яті навіть при термінальному
  // запуску: якщо процес уб'ють ззовні, у журналі лишиться, на якому режимі
  // й на якому кейсі це сталося.
  await logger.init();
  logger.installProcessHandlers({ role: "test-rag" });
  logger.startMemoryWatch();
  // Попередження про пам'ять має дійти до людини ДО падіння — і в журнал,
  // і в прогрес (у панелі розробника це той самий рядок, що й хід тестів).
  const unsubscribeMemoryWarning = logger.onMemoryWarning((text) => onProgress(text, null));

  /** Потік звіту. Оголошений тут, щоб finally міг закрити його і після збою. */
  let report = null;

  // Режими перемикаються через глобальний config, тож запам'ятовуємо стан
  // і повертаємо його у finally: інакше решта сесії працює з чужими
  // налаштуваннями, і ніде цього не видно.
  const savedRag = {
    searchMode: config.rag.searchMode,
    enableXmlTags: config.rag.enableXmlTags,
    enableContextReordering: config.rag.enableContextReordering,
  };
  try {
    const searchModes = ["vector", "fts", "hybrid"];
    const xmlModes = [false, true];
    const reorderModes = [false, true];

    const modes = [];
    for (const search of searchModes) {
      for (const xml of xmlModes) {
        for (const reorder of reorderModes) {
          const name = `${search}${xml ? "+XML" : ""}${reorder ? "+Reorder" : ""}`;
          modes.push({ name, search, xml, reorder });
        }
      }
    }

    console.log(pc.bgCyan(pc.black(` (${modes.length} РЕЖИМІВ ТЕСТУВАННЯ) `)));
    const summary = {};

    // Прогрес рахуємо наскрізно по всіх режимах: панель показує один індикатор.
    const totalRuns = modes.length * TEST_CASES.length;
    let doneRuns = 0;

    // Звіт пишемо на диск ПОСТУПОВО. Раніше всі 12 режимів × усі кейси
    // лежали в пам'яті до останнього рядка, і лише потім JSON.stringify
    // робив із них рядок на ≈2 МБ. Тепер у пам'яті лишаються самі підсумки.
    const reportsDir = path.join(config.paths.sidecarDir, "test-reports");
    await fs.mkdir(reportsDir, { recursive: true });
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(reportsDir, `report-${dateStr}.json`);

    const reportHeader = {
      timestamp: new Date().toISOString(),
      totalCases: TEST_CASES.length,
      models: {
        embed: config.embedModelName,
        chat: config.ollama.chatModel,
      },
    };
    report = createReportStream(reportPath, reportHeader);
    // Для таблиці в терміналі потрібні лише підсумки режимів, не результати.
    const reportSummary = { ...reportHeader, modes: {} };

    for (const modeObj of modes) {
      const mode = modeObj.name;
      console.log(`\n${pc.bgMagenta(pc.white(` ТЕСТУВАННЯ РЕЖИМУ: ${mode.toUpperCase()} `))}`);
      onProgress(
        `Режим ${mode} (${modes.indexOf(modeObj) + 1}/${modes.length})`,
        Math.round((doneRuns / totalRuns) * 100),
      );

      // Етап у журналі: саме він показує в пульсі, що процес робив у мить смерті.
      logger.setStage("ragBenchmark", {
        mode,
        modeIndex: modes.indexOf(modeObj) + 1,
        modesTotal: modes.length,
        doneRuns,
        totalRuns,
      });
      await report.beginMode(mode);

      // Перевизначаємо конфіг в пам'яті для поточного режиму
      config.rag.searchMode = modeObj.search;
      config.rag.enableXmlTags = modeObj.xml;
      config.rag.enableContextReordering = modeObj.reorder;

      let passed = 0;
      let failed = 0;
      const startTime = Date.now();
      // Замість масиву результатів — лічильники: усе інше вже на диску.
      const acc = { count: 0, tpsSum: 0, memSum: 0, inputTokens: 0, outputTokens: 0 };

      const CONCURRENCY = config.rag.testConcurrency;

      const limit = pLimit(CONCURRENCY);
      let testIndexCounter = 0;

      const batchPromises = TEST_CASES.map((test) =>
        limit(async () => {
          const testIndex = testIndexCounter++;
          const queryStart = Date.now();
          const result = await processQuery(test.query, () => {});
          const queryTime = Date.now() - queryStart;

          // Збираємо метрики
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

          const { response, recommendedApp, rawLlmOutput, retrievalStats } = result;

          console.log(
            `${pc.blue(`[${mode}] Тест ${testIndex + 1}/${TEST_CASES.length}:`)} "${test.query}"`,
          );

          let isSuccess = false;
          let isAlternativeSuccess = false;
          let reason = "";
          let extractedApp = null;

          if (test.type === "invalid") {
            if (
              response.includes("випадкові символи") ||
              response.includes("не зовсім зрозумілий") ||
              response.toLowerCase().includes("не вдалося знайти") ||
              recommendedApp === "INVALID_QUERY" ||
              recommendedApp === "NOT_FOUND"
            ) {
              isSuccess = true;
            } else {
              reason = "LLM спробувала дати відповідь на абракадабру.";
            }
          } else if (test.type === "not_found") {
            if (
              response.toLowerCase().includes("не вдалося знайти") ||
              response.toLowerCase().includes("no suitable app") ||
              response.toLowerCase().includes("немає програми") ||
              response.toLowerCase().includes("not found") ||
              recommendedApp === "NOT_FOUND"
            ) {
              isSuccess = true;
            } else {
              reason = "LLM сгалюцинувала програму для неможливого завдання.";
            }
          } else {
            extractedApp = recommendedApp;
            if (extractedApp && extractedApp !== "Не визначено") {
              const expected = Array.isArray(test.expectedApp)
                ? test.expectedApp
                : [test.expectedApp];
              const isMatch = expected.some(
                (app) => app.toLowerCase() === extractedApp.toLowerCase(),
              );

              if (isMatch) {
                isSuccess = true;
              } else {
                // Перевіряємо, чи потрібна програма взагалі потрапила в контекст.
                // Саме contextApps, а не alternativeApps: останній навмисно
                // порожній, коли рекомендації немає (NOT_FOUND/INVALID_QUERY),
                // а ця метрика міряє якість пошуку, а не вибір LLM.
                if (result.contextApps) {
                  isAlternativeSuccess = expected.some((app) =>
                    result.contextApps.some((alt) => alt.toLowerCase() === app.toLowerCase()),
                  );
                }
                const expectedStr = Array.isArray(test.expectedApp)
                  ? test.expectedApp.join(" або ")
                  : test.expectedApp;
                reason = `Очікувалась "${expectedStr}", але рекомендовано "${extractedApp}".`;
              }
            } else {
              reason = `Не знайдено форматування **Назва Програми** або тег SOURCE_ID відсутній.`;
            }
          }

          const metricsStr = `[${(queryTime / 1000).toFixed(1)}c | TTFT: ${ttft > 0 ? ttft.toFixed(2) + "c" : "N/A"} | ${tps > 0 ? tps.toFixed(1) + " t/s" : "N/A"} | RAM: ${memUsageMB}MB]`;

          if (isSuccess) {
            console.log(
              "  " +
                pc.green(`✅ Успішно!`) +
                (extractedApp ? ` (Знайдено: ${extractedApp})` : "") +
                pc.gray(` ${metricsStr}`),
            );
            passed++;
          } else if (isAlternativeSuccess) {
            console.log(
              "  " +
                pc.yellow(`⚠️ Частково успішно!`) +
                ` (Головна: ${extractedApp}, У контексті: ${result.contextApps.join(", ")})` +
                pc.gray(` ${metricsStr}`),
            );
            passed++;
          } else {
            console.log("  " + pc.red(`❌ Провалено! ${reason}`) + pc.gray(` ${metricsStr}`));
            failed++;
          }

          const resObj = {
            query: test.query,
            expectedType: test.type,
            expectedApp: test.expectedApp,
            isSuccess: isSuccess || isAlternativeSuccess,
            isAlternativeSuccess,
            reason,
            extractedApp,
            timeMs: queryTime,
            ttftSeconds: ttft,
            tokensPerSecond: tps,
            inputTokens,
            outputTokens,
            memoryUsageMB: memUsageMB,
            llmResponse: response,
            rawLlmOutput: rawLlmOutput,
            retrievalStats,
          };

          doneRuns++;
          onProgress(
            `[${mode}] ${doneRuns}/${totalRuns}: "${test.query}"`,
            Math.round((doneRuns / totalRuns) * 100),
          );
          logger.setStage("ragBenchmark", {
            mode,
            modeIndex: modes.indexOf(modeObj) + 1,
            modesTotal: modes.length,
            doneRuns,
            totalRuns,
            lastCase: testIndex + 1,
          });

          // Результат одразу лягає на диск і більше не тримається в пам'яті.
          acc.count += 1;
          acc.tpsSum += tps;
          acc.memSum += memUsageMB;
          acc.inputTokens += inputTokens;
          acc.outputTokens += outputTokens;
          await report.addResult(resObj);
          // Нічого не повертаємо навмисно: Promise.all зібрав би масив
          // результатів і звів нанівець увесь сенс потокового запису.
        }),
      );

      await Promise.all(batchPromises);

      const totalTime = Date.now() - startTime;
      const passRate = Math.round((passed / TEST_CASES.length) * 100);

      // Ті самі середні метрики, але з лічильників, а не з масиву результатів.
      const divisor = acc.count || 1;
      summary[mode] = {
        passed,
        failed,
        passRate,
        totalTimeMs: totalTime,
        avgTps: acc.tpsSum / divisor,
        avgMem: acc.memSum / divisor,
        totalInputTokens: acc.inputTokens,
        totalOutputTokens: acc.outputTokens,
      };
      await report.endMode(summary[mode]);
      reportSummary.modes[mode] = { summary: summary[mode] };
      logger.event(
        "info",
        "test.mode.done",
        { mode, ...summary[mode], memory: logger.memorySnapshot() },
        `Режим ${mode} завершено: ${passed}/${TEST_CASES.length}`,
      );
    }

    // Теку беремо з конфіга, а не з process.cwd(): під Tauri sidecar стартує
    // з кореня проєкта, і звіт лягав повз ту теку, яку читає RPC-метод
    // reports.list. Тут лише дописуємо хвіст і знімаємо суфікс .partial —
    // самі результати вже на диску.
    await report.close();

    // Вивід таблиці порівняння через спільний рендерер
    renderReportTable(reportSummary);
    console.log(`📁 Детальний звіт збережено у: ${reportPath}\n`);

    const modeSummaries = Object.values(summary);
    const passed = modeSummaries.reduce((acc, s) => acc + s.passed, 0);
    const failed = modeSummaries.reduce((acc, s) => acc + s.failed, 0);
    const totalRunCases = passed + failed;

    onProgress("RAG-бенчмарк завершено.", 100);

    return {
      ok: failed === 0,
      totalCases: totalRunCases,
      passed,
      failed,
      passRate: totalRunCases ? Math.round((passed / totalRunCases) * 100) : 0,
      reportPath,
    };
  } finally {
    // Відновлюємо конфіг навіть якщо тест упав посередині.
    Object.assign(config.rag, savedRag);
    // Прогін обірвався — не лишаємо відкритий дескриптор. Недописаний звіт
    // лишається файлом *.json.partial: він не ламає reports.list, але
    // показує, докуди дійшли.
    if (report) await report.abort();
    logger.setStage("ragBenchmark", null);
    unsubscribeMemoryWarning();
  }
}

// runTests();

import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Термінальний запуск: тут і тільки тут вирішуємо долю процесу.
  // Без onProgress — у терміналі й так друкується детальний хід тестів.
  runRagTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(pc.red(err.message));
      process.exit(1);
    });
}
