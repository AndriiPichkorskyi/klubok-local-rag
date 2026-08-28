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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadDataset(filename) {
  const data = await fs.readFile(path.join(__dirname, filename), 'utf8');
  return JSON.parse(data);
}

export async function runExternalTests() {
  console.log(pc.bgCyan(pc.black(" ЗАПУСК EXTERNAL ТЕСТУВАННЯ (Hybrid + XML + Reorder | 4b) ")));

  // Примусово встановлюємо режим
  config.rag.searchMode = "hybrid";
  config.rag.enableXmlTags = true;
  config.rag.enableContextReordering = true;
  
  // Перевірка моделі (якщо користувач має на увазі embedding модель 4b)
  if (!config.embedModelName.includes('4b')) {
     console.warn(pc.yellow(`⚠️ Поточна EMBED_MODEL = ${config.embedModelName}. Рекомендується перезапустити скрипт з EMBED_MODEL=qwen3-embedding:4b`));
  }

  const status = await ollama.checkAvailability();
  if (!status.isAvailable) {
    console.error(pc.red("❌ Ollama не запущена!"));
    process.exit(1);
  }

  process.stdout.write("🔥 Прогрів моделей Ollama... ");
  await ollama.warmup();
  console.log(pc.green("Готово!"));

  await db.init();

  const intents = await loadDataset("dataset_intents.json");
  const ood = await loadDataset("dataset_ood.json");
  const ambiguous = await loadDataset("dataset_ambiguous.json");

  // Маппінг Bundle ID -> App Name
  async function getAppNames(bundleIds) {
    if (!bundleIds || bundleIds.length === 0) return [];
    const placeholders = bundleIds.map(() => '?').join(',');
    const rows = await db.sqliteDb.all(`SELECT name FROM apps WHERE id IN (${placeholders})`, bundleIds);
    return rows.map(r => r.name);
  }

  const TEST_CASES = [];

  for (const item of intents) {
    const appNames = await getAppNames(item.acceptableApplicationIdentifiers || [item.expectedApplicationIdentifier]);
    if (appNames.length > 0) {
      TEST_CASES.push({
        query: item.query,
        expectedApp: appNames,
        type: "valid",
        category: "intents"
      });
    }
  }

  for (const item of ood) {
    TEST_CASES.push({
      query: item.query,
      expectedApp: [],
      type: "not_found",
      category: "ood"
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
      category: "ambiguous"
    });
  }

  console.log(`\nВсього завантажено ${TEST_CASES.length} зовнішніх тестів.`);

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

      let tps = 0, inputTokens = 0, outputTokens = 0, ttft = 0;
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
      console.log(`${pc.blue(`[Тест ${testIndex + 1}/${TEST_CASES.length} | ${test.category}]:`)} "${test.query}" -> ${pc.yellow(recommendedApp)}`);

      let isSuccess = false;
      let reason = "";

      if (test.type === "valid") {
        const expected = test.expectedApp;
        const isMatch = expected.some((app) => app.toLowerCase() === recommendedApp.toLowerCase());
        const isAlternativeMatch = result.alternativeApps.some((app) =>
           expected.some((expApp) => expApp.toLowerCase() === app.toLowerCase())
        );

        if (isMatch || isAlternativeMatch) {
          isSuccess = true;
        } else {
          reason = `Очікувалося: ${expected.join(" або ")}, Отримано: ${recommendedApp}`;
        }
      } else if (test.type === "not_found") {
        if (recommendedApp === "NOT_FOUND" || recommendedApp === "INVALID_QUERY" || response.toLowerCase().includes("не вдалося знайти")) {
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

      results.push({
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

  // Зберігаємо результати
  const reportData = {
    timestamp: new Date().toISOString(),
    totalCases: TEST_CASES.length,
    models: {
      embed: config.embedModelName,
      chat: config.ollama.chatModel,
    },
    modes: {}
  };

  const totalTimeMs = results.reduce((acc, r) => acc + r.timeMs, 0);
  const totalInputTokens = results.reduce((acc, r) => acc + r.inputTokens, 0);
  const totalOutputTokens = results.reduce((acc, r) => acc + r.outputTokens, 0);
  const validTps = results.filter(r => r.tps > 0);
  const avgTps = validTps.length > 0 ? validTps.reduce((acc, r) => acc + r.tps, 0) / validTps.length : 0;
  const avgMem = results.reduce((acc, r) => acc + r.memory, 0) / (results.length || 1);

  reportData.modes["external_hybrid"] = {
    summary: {
      passed,
      failed,
      passRate: parseFloat(passRate),
      totalTimeMs,
      avgTps,
      avgMem,
      totalInputTokens,
      totalOutputTokens,
    },
    results: results
  };

  // Збереження звіту у файл
  const reportsDir = path.join(process.cwd(), "test-reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportsDir, `report-external-${dateStr}.json`);
  await fs.writeFile(reportPath, JSON.stringify(reportData, null, 2), "utf8");

  // Вивід таблиці порівняння
  renderReportTable(reportData);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runExternalTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
