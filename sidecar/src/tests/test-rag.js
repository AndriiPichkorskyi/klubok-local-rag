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
import {
  resolveBenchmarkPlan,
  assertModeLimit,
  nextSeedFor,
  isRandomSeedMode,
  summarizeSeedGroups,
  summarizeRandomSeedRuns,
  compareAxisPairs,
  summarizeAxisImpact,
} from "./benchmark-matrix.js";
import {
  resolveCaseLanguage,
  createLanguageTally,
  summarizeLanguages,
  LANGUAGE_LABELS,
} from "./language.js";
import { createHash } from "crypto";

/**
 * RAG-бенчмарк по всіх комбінаціях режимів.
 *
 * Функція НЕ завершує процес: рішення про exit ухвалює той, хто її викликав
 * з термінала (див. блок наприкінці файлу). З RPC-сервера вона виконується
 * всередині живого процесу, і `process.exit` убив би застосунок разом із ним.
 *
 * @param {Function} onProgress - необов'язковий колбек (msg, pct|null).
 * @param {Object} [options] - `{axes}`: осі, задані ззовні (панель розробника).
 *        Конфіг лишається джерелом за замовчуванням: те, чого немає в `axes`,
 *        береться з `rag.benchmark.axes`.
 * @returns {Promise<{ok: boolean, totalCases: number, passed: number,
 *                    failed: number, passRate: number, reportPath: string}>}
 */
export async function runRagTests(onProgress = () => {}, options = {}) {
  // Override models if requested
  const savedChatModel = config.ollama.chatModel;
  const savedEmbedModel = config.embedModelName;
  if (options.overrideChatModel) config.ollama.chatModel = options.overrideChatModel;
  if (options.overrideEmbedModel) config.embedModelName = options.overrideEmbedModel;

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
    systemPromptMode: config.rag.systemPromptMode,
    seed: config.rag.seed,
    temperature: config.rag.temperature,
  };
  try {
    // Матриця більше не зашита в код: осі беруться з config/pipeline.config.json
    // (rag.benchmark.axes). Типові значення дають ті самі 12 режимів, що й раніше.
    const benchmarkConfig = config.rag.benchmark || {};
    // Один резолвер плану на обидва тести і на метод tests.plan: числа, які
    // панель показала перед запуском, і числа прогону рахує та сама формула.
    const plan = resolveBenchmarkPlan({
      benchmark: benchmarkConfig,
      overrides: options?.axes ?? null,
      caseCount: TEST_CASES.length,
      extra: {
        chatModel: config.ollama.chatModel,
        embedModel: config.embedModelName,
      },
    });
    // Запобіжник: повний добуток усіх осей — 36·T·N режимів по 26 кейсів, і
    // запустити таке випадково коштує людині ночі. maxModes = 0 — без обмеження.
    assertModeLimit(plan);
    const { axes, modes } = plan;

    // Прогрес рахуємо наскрізно по всіх режимах: панель показує один індикатор.
    const { lines: matrixLines, totalRuns } = plan;
    let doneRuns = 0;

    // Масштаб прогону — на екран і в прогрес ДО першого запиту до LLM.
    console.log(pc.bgCyan(pc.black(` (${modes.length} РЕЖИМІВ ТЕСТУВАННЯ) `)));
    matrixLines.forEach((line) => console.log(pc.cyan(line)));
    onProgress(`Старт: ${modes.length} режимів × ${TEST_CASES.length} кейсів = ${totalRuns} прогонів LLM.`, 0);
    logger.event("info", "test.matrix", { axes, modes: modes.length, totalRuns }, matrixLines.join(" "));

    // Мова кожного кейса визначається ОДИН раз до прогону, а не на кожному
    // режимі: значення однакове для всіх режимів, а лічильник «вгаданих»
    // інакше множився б на кількість режимів.
    const caseLanguage = new Map();
    let guessedLanguageCases = 0;
    const languageCensus = {};
    for (const test of TEST_CASES) {
      const resolved = resolveCaseLanguage(test);
      caseLanguage.set(test, resolved);
      if (resolved.languageSource === "auto") guessedLanguageCases += 1;
      languageCensus[resolved.language] = (languageCensus[resolved.language] || 0) + 1;
    }
    console.log(
      pc.cyan(
        "Мови набору: " +
          Object.entries(languageCensus)
            .map(([lang, count]) => `${LANGUAGE_LABELS[lang] || lang} — ${count}`)
            .join(", ") +
          (guessedLanguageCases > 0
            ? ` (з них ${guessedLanguageCases} визначено автоматично)`
            : " (усі задані явно)"),
      ),
    );

    const summary = {};
    // Хеші сирих відповідей LLM: режим → (запит → hash). Потрібні, щоб
    // довести інертність осі побайтовим збігом, а не статистикою.
    const hashesByMode = new Map();
    // Фактично використані зерна: режим → [seed кожного кейса]. Для осі
    // seed: "random" це єдиний спосіб потім сказати, ЩО саме прогнали.
    const seedsByMode = new Map();

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
      // Нове у звіті: матриця, якою його отримано, і очікуваний масштаб.
      benchmarkKind: "rag",
      axes,
      modeCount: modes.length,
      expectedRuns: totalRuns,
      defaults: {
        enableJsonFormat: config.rag.enableJsonFormat,
        topK: config.rag.topK,
        excludeLocalDocs: config.rag.excludeLocalDocs,
      },
    };
    report = createReportStream(reportPath, reportHeader);

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
      await report.beginMode(mode, modeObj.params);

      // Перевизначаємо конфіг в пам'яті для поточного режиму.
      // Усі кейси режиму йдуть з однаковими осями, тож паралельність (p-limit)
      // не бачить чужих значень.
      config.rag.searchMode = modeObj.search;
      config.rag.enableXmlTags = modeObj.xml;
      config.rag.enableContextReordering = modeObj.reorder;
      config.rag.systemPromptMode = modeObj.systemPrompt;
      // Вісь seed: "random" не має одного значення на режим — зерно
      // народжується на КОЖЕН кейс і передається в processQuery окремим
      // аргументом (глобальний config тут дав би гонку між паралельними
      // задачами). У самому конфізі на час такого режиму лишається null.
      config.rag.seed = isRandomSeedMode(modeObj) ? null : modeObj.seed;
      config.rag.temperature = modeObj.temperature;
      
      if (modeObj.chatModel) config.ollama.chatModel = modeObj.chatModel;
      if (modeObj.embedModel) {
        config.embedModelName = modeObj.embedModel;
        await db.ensureLanceDbConnected(); // Hot-swap vector DB if embedding model changed
      }

      const modeHashes = new Map();
      hashesByMode.set(mode, modeHashes);
      const modeSeeds = [];
      seedsByMode.set(mode, modeSeeds);
      // Розбивка pass rate по мовах для цього режиму.
      const langTally = createLanguageTally();

      let passed = 0;
      let failed = 0;
      const startTime = Date.now();
      // Замість масиву результатів — лічильники: усе інше вже на диску.
      const acc = { count: 0, tpsSum: 0, ttftSum: 0, memSum: 0, sysRamSum: 0, sysPowerSum: 0, inputTokens: 0, outputTokens: 0 };

      const CONCURRENCY = config.rag.testConcurrency;

      const limit = pLimit(CONCURRENCY);
      let testIndexCounter = 0;

      const batchPromises = TEST_CASES.map((test) =>
        limit(async () => {
          if (options.signal?.aborted) throw options.signal.reason;
          const testIndex = testIndexCounter++;
          // Зерно цього конкретного запиту: значення осі або нове випадкове.
          const caseSeed = nextSeedFor(modeObj);
          const queryStart = Date.now();
          const result = await processQuery(test.query, () => {}, null, null, {
            seed: caseSeed,
            temperature: modeObj.temperature,
          });
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
          let sysMetrics = {};
          try {
            const metricsJson = await fs.readFile("/tmp/ollama_metrics.json", "utf8");
            sysMetrics = JSON.parse(metricsJson);
          } catch (e) {
            // Файл може бути заблокований або ще не створений
          }

          const { response, recommendedApp, rawLlmOutput, retrievalStats } = result;

          console.log(
            `${pc.blue(`[${mode}] Тест ${testIndex + 1}/${TEST_CASES.length}:`)} "${test.query}"`
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

          const metricsStr = `[${(queryTime / 1000).toFixed(1)}c | TTFT: ${ttft > 0 ? ttft.toFixed(2) + "c" : "N/A"} | ${tps > 0 ? tps.toFixed(1) + " t/s" : "N/A"} | Node RAM: ${memUsageMB}MB | Ollama RAM: ${Math.round(sysMetrics.ram_mb || 0)}MB]`;

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

          // Побайтовий відбиток відповіді моделі. Два режими з однаковим
          // хешем на всіх кейсах = вісь між ними не змінила НІЧОГО.
          const rawOutputHash =
            typeof rawLlmOutput === "string"
              ? createHash("sha256").update(rawLlmOutput).digest("hex")
              : null;
          modeHashes.set(test.query, rawOutputHash);

          // Мова запиту — і в лічильник режиму, і в сам результат, щоб
          // таблицю звітів можна було сортувати за нею.
          const { language, languageSource } = caseLanguage.get(test);
          langTally.add(language, isSuccess || isAlternativeSuccess, languageSource === "auto");

          // Фактичне зерно беремо з відповіді движка, а не з наміру: якщо
          // ланцюжок колись розірветься, у звіті буде видно саме те, що пішло
          // в Ollama. `seedSource` відрізняє точку осі від випадкового зерна.
          const usedSeed = result.retrievalStats?.seed ?? caseSeed ?? null;
          modeSeeds.push(usedSeed);

          const resObj = {
            query: test.query,
            language,
            languageSource,
            seed: usedSeed,
            seedSource: modeObj.seedKind,
            temperature: result.retrievalStats?.temperature ?? modeObj.temperature,
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
            sysOllamaRamMB: sysMetrics.ram_mb || 0,
            sysPowerScore: sysMetrics.power_score || 0,
            llmResponse: response,
            rawLlmOutput: rawLlmOutput,
            rawOutputHash,
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
          acc.ttftSum += ttft;
          acc.memSum += memUsageMB;
          acc.sysRamSum += (sysMetrics.ram_mb || 0);
          acc.sysPowerSum += (sysMetrics.power_score || 0);
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
        wallTimeMs: totalTime,
        avgTps: acc.tpsSum / divisor,
        avgTtft: acc.ttftSum / divisor,
        avgMem: acc.memSum / divisor,
        avgSysRam: acc.sysRamSum / divisor,
        avgSysPower: acc.sysPowerSum / divisor,
        totalInputTokens: acc.inputTokens,
        totalOutputTokens: acc.outputTokens,
        byLanguage: langTally.snapshot(),
      };
      await report.endMode(summary[mode]);
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
    // === Розкид по seed-ах ===
    // Без нього «XML не впливає» не відрізнити від «одному зразку не пощастило»:
    // на кожен режим припадає рівно стільки зразків, скільки seed-ів у осі.
    const seedGroups = summarizeSeedGroups(modes, summary);

    // === Доказ інертності осі: побайтовий збіг виводу LLM ===
    const axisComparison = compareAxisPairs(modes, hashesByMode);
    const axisImpact = summarizeAxisImpact(axisComparison);

    // === Розбивка за мовою запиту ===
    // Документація в базі україномовна, тож англійські запити — окремий
    // (крослінгвальний) результат, а не шум у загальному числі.
    const languageBreakdown = summarizeLanguages(modes, summary, guessedLanguageCases);

    // === Прогони на випадковому зерні ===
    // Окремим блоком, а не серед seedGroups: усереднювати їх можна, називати
    // режимом-точкою — ні (див. шапку benchmark-matrix.js).
    const randomSeedRuns = summarizeRandomSeedRuns(modes, summary, seedsByMode);

    const footer = { seedGroups, axisComparison, axisImpact, languageBreakdown };
    if (randomSeedRuns) footer.randomSeedRuns = randomSeedRuns;
    await report.close(footer);

    // Вивід таблиці порівняння через спільний рендерер.
    // Той самий об'єкт, що й у test-external.js — його віддає сам потік звіту.
    renderReportTable(report.summaryView(footer));

    // Таблиця розкиду друкується лише тоді, коли seed-ів справді кілька:
    // на одному зразку min = max = mean, і рядок був би шумом.
    const multiSeedGroups = Object.entries(seedGroups).filter(([, g]) => g.runs > 1);
    if (multiSeedGroups.length > 0) {
      console.log(pc.bold(`\n📈 РОЗКИД PASS RATE ПО SEED-АХ (${axes.seed.length} прогони на режим):`));
      console.log("-".repeat(101));
      console.log(
        pc.bold("Режим".padEnd(32)) +
          pc.bold("Прогонів".padEnd(10)) +
          pc.bold("Середнє".padEnd(10)) +
          pc.bold("Мін".padEnd(8)) +
          pc.bold("Макс".padEnd(8)) +
          pc.bold("σ".padEnd(8)) +
          pc.bold("Значення"),
      );
      for (const [name, group] of multiSeedGroups) {
        const r = group.passRate;
        console.log(
          name.padEnd(32) +
            String(group.runs).padEnd(10) +
            `${r.mean.toFixed(1)}%`.padEnd(10) +
            `${r.min}%`.padEnd(8) +
            `${r.max}%`.padEnd(8) +
            r.stdev.toFixed(2).padEnd(8) +
            r.values.map((v) => `${v}%`).join(", "),
        );
      }
      console.log("-".repeat(101));
    }

    // Прогони на випадковому зерні друкуються окремою таблицею — саме щоб їх
    // не сплутали з режимами: у них немає точки, яку можна повторити.
    if (randomSeedRuns) {
      console.log(pc.bold("\n🎲 ПРОГОНИ НА ВИПАДКОВОМУ ЗЕРНІ (не точки порівняння):"));
      console.log("-".repeat(101));
      console.log(
        pc.bold("Режим".padEnd(38)) +
          pc.bold("Кейсів".padEnd(10)) +
          pc.bold("Різних seed".padEnd(14)) +
          pc.bold("Pass rate".padEnd(12)) +
          pc.bold("Приклади seed"),
      );
      for (const [name, stat] of Object.entries(randomSeedRuns.modes)) {
        console.log(
          name.padEnd(38) +
            String(stat.cases).padEnd(10) +
            String(stat.distinctSeeds).padEnd(14) +
            `${stat.passRate}%`.padEnd(12) +
            stat.seedSample.join(", ") +
            (stat.seedsTruncated ? ", …" : ""),
        );
      }
      console.log("-".repeat(101));
      console.log(pc.gray(`   ${randomSeedRuns.note}`));
    }

    // Зведення по осях: скільки кейсів дали ПОБАЙТОВО однаковий вивід між
    // режимами, що відрізняються рівно цією віссю.
    if (axisComparison.length > 0) {
      console.log(pc.bold(`\n🧬 ІДЕНТИЧНІСТЬ ВИВОДУ LLM ПО ОСЯХ (порівнянних пар: ${axisComparison.length}):`));
      console.log("-".repeat(101));
      console.log(
        pc.bold("Вісь".padEnd(16)) +
          pc.bold("Пар".padEnd(8)) +
          pc.bold("Кейсів".padEnd(10)) +
          pc.bold("Ідентичних".padEnd(14)) +
          pc.bold("Висновок"),
      );
      for (const [axis, stat] of Object.entries(axisImpact)) {
        const verdict = stat.inert
          ? pc.red("вісь ІНЕРТНА: вивід збігся побайтово скрізь")
          : `вісь впливає: ${stat.cases - stat.identical} кейсів відрізняються`;
        console.log(
          axis.padEnd(16) +
            String(stat.pairs).padEnd(8) +
            String(stat.cases).padEnd(10) +
            `${stat.identical} (${stat.identicalPct}%)`.padEnd(14) +
            verdict,
        );
      }
      console.log("-".repeat(101));
      // Окремо — пари з повним збігом: саме вони закривають питання остаточно.
      const fullyIdentical = axisComparison.filter((p) => p.identical === p.cases);
      for (const pair of fullyIdentical) {
        console.log(
          pc.gray(
            `   ${pair.from} ≡ ${pair.to} — ${pair.identical}/${pair.cases} кейсів побайтово однакові (вісь ${pair.axis})`,
          ),
        );
      }
      logger.event(
        "info",
        "test.axis.impact",
        { axisImpact },
        `Порівняння осей: ${Object.entries(axisImpact)
          .map(([a, st]) => `${a} ${st.identicalPct}% ідентичних`)
          .join(", ")}`,
      );
    }

    console.log(`\n📁 Детальний звіт збережено у: ${reportPath}\n`);

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
    config.ollama.chatModel = savedChatModel;
    config.embedModelName = savedEmbedModel;
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
