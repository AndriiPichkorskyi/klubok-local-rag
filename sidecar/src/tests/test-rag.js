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

export async function runRagTests() {
  console.log(pc.bgCyan(pc.black(" ЗАПУСК АВТОМАТИЗОВАНОГО ТЕСТУВАННЯ RAG")));

  const status = await ollama.checkAvailability();
  if (!status.isAvailable) {
    console.error(pc.red("❌ Ollama не запущена!"));
    process.exit(1);
  }

  process.stdout.write("🔥 Прогрів моделей Ollama... ");
  await ollama.warmup();
  console.log(pc.green("Готово!"));

  // Ініціалізуємо БД перед тестами
  await db.init();

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

  console.log(pc.bgCyan(pc.black(` (${modes.length}} РЕЖИМІВ ТЕСТУВАННЯ) `)));
  const summary = {};

  const reportData = {
    timestamp: new Date().toISOString(),
    totalCases: TEST_CASES.length,
    models: {
      embed: config.embedModelName,
      chat: config.ollama.chatModel,
    },
    modes: {},
  };

  for (const modeObj of modes) {
    const mode = modeObj.name;
    console.log(`\n${pc.bgMagenta(pc.white(` ТЕСТУВАННЯ РЕЖИМУ: ${mode.toUpperCase()} `))}`);

    // Перевизначаємо конфіг в пам'яті для поточного режиму
    config.rag.searchMode = modeObj.search;
    config.rag.enableXmlTags = modeObj.xml;
    config.rag.enableContextReordering = modeObj.reorder;

    let passed = 0;
    let failed = 0;
    const startTime = Date.now();
    const results = [];

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
              // Check alternatives
              if (result.alternativeApps) {
                isAlternativeSuccess = expected.some((app) =>
                  result.alternativeApps.some((alt) => alt.toLowerCase() === app.toLowerCase()),
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
              ` (Головна: ${extractedApp}, Альтернативи: ${result.alternativeApps.join(", ")})` +
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

        results.push(resObj);
        return resObj;
      }),
    );

    await Promise.all(batchPromises);

    const totalTime = Date.now() - startTime;
    const passRate = Math.round((passed / TEST_CASES.length) * 100);

    // Розраховуємо загальні та середні метрики
    const avgTps = results.reduce((acc, curr) => acc + curr.tokensPerSecond, 0) / results.length;
    const avgMem = results.reduce((acc, curr) => acc + curr.memoryUsageMB, 0) / results.length;
    const totalInputTokens = results.reduce((acc, curr) => acc + curr.inputTokens, 0);
    const totalOutputTokens = results.reduce((acc, curr) => acc + curr.outputTokens, 0);

    summary[mode] = {
      passed,
      failed,
      passRate,
      totalTimeMs: totalTime,
      avgTps,
      avgMem,
      totalInputTokens,
      totalOutputTokens,
    };
    reportData.modes[mode] = { summary: summary[mode], results };
  }

  // Збереження звіту у файл
  const reportsDir = path.join(process.cwd(), "test-reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `report-${dateStr}.json`);
  await fs.writeFile(reportPath, JSON.stringify(reportData, null, 2), "utf8");

  // Вивід таблиці порівняння через спільний рендерер
  renderReportTable(reportData);
  console.log(`📁 Детальний звіт збережено у: ${reportPath}\n`);

  const anyFailed = Object.values(summary).some((s) => s.failed > 0);
  return !anyFailed;
}

// runTests();

import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRagTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
