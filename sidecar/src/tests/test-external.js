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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadDataset(filename) {
  const data = await fs.readFile(path.join(__dirname, filename), "utf8");
  return JSON.parse(data);
}

/**
 * Кейси зовнішніх датасетів (intents, OOD, ambiguous) у вигляді, готовому до прогону.
 *
 * Винесено окремою функцією, бо кількість кейсів потрібна ДВІЧІ: самому тесту
 * і методу `tests.plan`, який показує в панелі ціну прогону ще до запуску.
 * Рахувати «приблизно» тут не можна: частина intents-кейсів відпадає, якщо
 * потрібної програми немає в базі (`getAppNames` повертає порожньо), тож
 * реальна кількість менша за суму довжин файлів.
 *
 * Викликати ПІСЛЯ `db.init()`: потрібна таблиця `apps`.
 * @returns {Promise<Array<Object>>}
 */
export async function loadExternalCases() {
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

  const cases = [];

  for (const item of intents) {
    const appNames = await getAppNames(
      item.acceptableApplicationIdentifiers || [item.expectedApplicationIdentifier],
    );
    if (appNames.length > 0) {
      cases.push({
        query: item.query,
        expectedApp: appNames,
        type: "valid",
        category: "intents",
        // Мова задана в самому датасеті і перевірена вручну.
        language: item.language,
      });
    }
  }

  for (const item of ood) {
    cases.push({
      query: item.query,
      expectedApp: [],
      type: "not_found",
      category: "ood",
      language: item.language,
    });
  }

  // Для ambiguous приймаємо або Not Found, або будь-яку з acceptable
  for (const item of ambiguous) {
    // В цьому датасеті capabilityIds, а не bundle IDs. Доведеться ігнорувати точну перевірку,
    // але ми знаємо, що allowUnknown: true. Просто будемо перевіряти, як LLM реагує.
    cases.push({
      query: item.query,
      expectedApp: [],
      type: "ambiguous",
      category: "ambiguous",
      language: item.language,
    });
  }

  return cases;
}

/**
 * EXTERNAL-тести на зовнішніх датасетах (intents, OOD, ambiguous).
 *
 * ЧОМУ ТУТ ТЕПЕР МАТРИЦЯ. Нічний прогін RAG-бенчмарку на 36 режимах дав 92%
 * у 35 режимах із 36 (σ = 0) при тому, що вивід моделі відрізнявся в 91–95%
 * випадків: набір із 26 кейсів уперся в стелю, і один кейс важить 3.8 п.п.
 * Тут кейсів 153 і pass rate ≈ 59% — вшестеро краща роздільність і є куди
 * рухатись, тож справжнє місце експерименту саме тут. Осі — ті самі
 * (`rag.benchmark.axes` + перекриття з інтерфейсу), режими будуються тим
 * самим `resolveBenchmarkPlan`, звіт має ту саму форму, що й у RAG.
 *
 * Функція НЕ завершує процес і НЕ лишає по собі змінений глобальний config:
 * і те, і те вбивало б RPC-сервер або тихо міняло поведінку решти сесії.
 *
 * @param {Function} onProgress - необов'язковий колбек (msg, pct|null).
 * @param {Object} [options] - `{axes}`: осі, задані ззовні (панель розробника);
 *        незадані беруться з конфіга.
 * @returns {Promise<{ok: boolean, totalCases: number, passed: number,
 *                    failed: number, passRate: number, reportPath: string}>}
 */
export async function runExternalTests(onProgress = () => {}, options = {}) {
  console.log(pc.bgCyan(pc.black(" ЗАПУСК EXTERNAL ТЕСТУВАННЯ (матриця режимів) ")));

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
  // 153 кейси × кілька режимів — теж довга операція, і вона теж має лишати слід.
  await logger.init();
  logger.installProcessHandlers({ role: "test-external" });
  logger.startMemoryWatch();
  const unsubscribeMemoryWarning = logger.onMemoryWarning((text) => onProgress(text, null));

  /** Потік звіту. Оголошений тут, щоб finally міг закрити його і після збою. */
  let report = null;

  // Режими перемикаються через глобальний config: запам'ятовуємо попередні
  // значення і повертаємо їх у finally, інакше після одного запуску вся
  // сесія (і метод config.get) працює вже з іншими налаштуваннями.
  const savedRag = {
    searchMode: config.rag.searchMode,
    enableXmlTags: config.rag.enableXmlTags,
    enableContextReordering: config.rag.enableContextReordering,
    systemPromptMode: config.rag.systemPromptMode,
    seed: config.rag.seed,
    temperature: config.rag.temperature,
  };
  try {
    const TEST_CASES = await loadExternalCases();
    console.log(`\nВсього завантажено ${TEST_CASES.length} зовнішніх тестів.`);

    const benchmarkConfig = config.rag.benchmark || {};
    const plan = resolveBenchmarkPlan({
      benchmark: benchmarkConfig,
      overrides: options?.axes ?? null,
      caseCount: TEST_CASES.length,
      extra: {
        chatModel: config.ollama.chatModel,
        embedModel: config.embedModelName,
      },
      title: "Матриця режимів EXTERNAL (ті самі rag.benchmark.axes):",
    });
    // 153 кейси × багато режимів — це години. Запобіжник спрацьовує ДО
    // першого запиту до LLM і пояснює, що саме звузити.
    assertModeLimit(plan);
    const { axes, modes, lines: matrixLines, totalRuns } = plan;

    // Масштаб прогону — на екран і в прогрес ДО першого запиту до LLM.
    console.log(pc.bgCyan(pc.black(` (${modes.length} РЕЖИМІВ ТЕСТУВАННЯ) `)));
    matrixLines.forEach((line) => console.log(pc.cyan(line)));
    onProgress(
      `Старт: ${modes.length} режимів × ${TEST_CASES.length} кейсів = ${totalRuns} прогонів LLM.`,
      0,
    );
    logger.event(
      "info",
      "test.matrix",
      { kind: "external", axes, modes: modes.length, totalRuns },
      matrixLines.join(" "),
    );

    // Мова кожного кейса — один раз до прогону (див. tests/language.js).
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
      // Той самий набір заголовкових полів, що й у RAG-бенчмарку: форма звіту
      // одна на обидва тести.
      benchmarkKind: "external",
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

    const summary = {};
    // Хеші сирих відповідей LLM: режим → (запит → hash). Побайтовий збіг —
    // найсильніший доказ інертності осі.
    const hashesByMode = new Map();
    // Фактично використані зерна: режим → [seed кожного кейса].
    const seedsByMode = new Map();

    let doneRuns = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    const runStartedAt = Date.now();

    for (const modeObj of modes) {
      const mode = modeObj.name;
      const modeIndex = modes.indexOf(modeObj) + 1;
      console.log(`\n${pc.bgMagenta(pc.white(` РЕЖИМ: ${mode.toUpperCase()} `))}`);
      onProgress(`Режим ${mode} (${modeIndex}/${modes.length})`, Math.round((doneRuns / totalRuns) * 100));
      logger.setStage("externalBenchmark", {
        mode,
        modeIndex,
        modesTotal: modes.length,
        doneRuns,
        totalRuns,
      });
      await report.beginMode(mode, modeObj.params);

      // Перевизначаємо конфіг у пам'яті для поточного режиму: усі кейси
      // режиму йдуть з однаковими осями, тож паралельність не бачить чужих
      // значень. Виняток — випадкове зерно: воно передається на кожен запит
      // окремим аргументом processQuery, бо глобальний config тут дав би гонку.
      config.rag.searchMode = modeObj.search;
      config.rag.enableXmlTags = modeObj.xml;
      config.rag.enableContextReordering = modeObj.reorder;
      config.rag.systemPromptMode = modeObj.systemPrompt;
      config.rag.seed = isRandomSeedMode(modeObj) ? null : modeObj.seed;
      config.rag.temperature = modeObj.temperature;

      const modeHashes = new Map();
      hashesByMode.set(mode, modeHashes);
      const modeSeeds = [];
      seedsByMode.set(mode, modeSeeds);
      const langTally = createLanguageTally();

      let passed = 0;
      let failed = 0;
      const modeStartedAt = Date.now();
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
          // Зерно цього конкретного запиту: значення осі або нове випадкове.
          const caseSeed = nextSeedFor(modeObj);
          const queryStart = Date.now();
          const result = await processQuery(test.query, () => {}, null, null, {
            seed: caseSeed,
            temperature: modeObj.temperature,
          });
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

          const { response, recommendedApp, rawLlmOutput } = result;
          // Той самий побайтовий відбиток відповіді, що й у RAG-бенчмарку.
          const rawOutputHash =
            typeof rawLlmOutput === "string"
              ? createHash("sha256").update(rawLlmOutput).digest("hex")
              : null;
          modeHashes.set(test.query, rawOutputHash);

          console.log(
            `${pc.blue(`[${mode}] Тест ${testIndex + 1}/${TEST_CASES.length} | ${test.category}:`)} "${test.query}" -> ${pc.yellow(recommendedApp)}`,
          );
          doneRuns++;
          onProgress(
            `[${mode}] ${doneRuns}/${totalRuns} [${test.category}]: "${test.query}"`,
            Math.round((doneRuns / totalRuns) * 100),
          );
          logger.setStage("externalBenchmark", {
            mode,
            modeIndex,
            modesTotal: modes.length,
            doneRuns,
            totalRuns,
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
          const { language, languageSource } = caseLanguage.get(test);
          langTally.add(language, isSuccess, languageSource === "auto");

          // Фактичне зерно беремо з відповіді движка, а не з наміру: у звіті
          // має лишитись те, що справді пішло в Ollama, інакше прогін на
          // випадковому зерні неможливо відтворити.
          const usedSeed = result.retrievalStats?.seed ?? caseSeed ?? null;
          modeSeeds.push(usedSeed);

          await report.addResult({
            query: test.query,
            language,
            languageSource,
            seed: usedSeed,
            seedSource: modeObj.seedKind,
            temperature: result.retrievalStats?.temperature ?? modeObj.temperature,
            expected: test.expectedApp ? test.expectedApp.join(", ") : test.type,
            got: recommendedApp,
            success: isSuccess,
            timeMs: queryTime,
            ttft,
            tps,
            memory: memUsageMB,
            inputTokens,
            outputTokens,
            rawOutputHash,
          });
        }),
      );

      await Promise.all(batchPromises);

      const wallTimeMs = Date.now() - modeStartedAt;
      const passRate = parseFloat(((passed / TEST_CASES.length) * 100).toFixed(1));
      totalPassed += passed;
      totalFailed += failed;

      // Ті самі підсумки, що й були: `totalTimeMs` лишається СУМОЮ тривалостей
      // кейсів (так його рахував цей тест завжди), а час «від першого до
      // останнього» додано окремим полем.
      summary[mode] = {
        passed,
        failed,
        passRate,
        totalTimeMs: acc.timeMs,
        wallTimeMs,
        avgTps: acc.tpsCount > 0 ? acc.tpsSum / acc.tpsCount : 0,
        avgMem: acc.memSum / (acc.count || 1),
        totalInputTokens: acc.inputTokens,
        totalOutputTokens: acc.outputTokens,
        byLanguage: langTally.snapshot(),
      };
      await report.endMode(summary[mode]);
      console.log(
        `${pc.bgGreen(pc.black(` РЕЖИМ ${mode} ЗАВЕРШЕНО ЗА ${(wallTimeMs / 1000).toFixed(1)} сек `))} ` +
          `Успішно: ${pc.green(passed)}, Провалено: ${pc.red(failed)}, Pass Rate: ${pc.yellow(`${passRate}%`)}`,
      );
      logger.event(
        "info",
        "test.mode.done",
        { kind: "external", mode, ...summary[mode], memory: logger.memorySnapshot() },
        `Режим ${mode} завершено: ${passed}/${TEST_CASES.length}`,
      );
    }

    const totalTimeSec = ((Date.now() - runStartedAt) / 1000).toFixed(1);
    console.log(`\n${pc.bgGreen(pc.black(` ТЕСТУВАННЯ ЗАВЕРШЕНО ЗА ${totalTimeSec} сек `))}`);

    // === Розкид по seed-ах, порівняння осей, мовна розбивка ===
    // Ті самі функції, що й у RAG-бенчмарку: у зовнішніх тестах тепер теж
    // кілька режимів, тож осьовий хвіст звіту тут доречний і потрібний.
    const seedGroups = summarizeSeedGroups(modes, summary);
    const axisComparison = compareAxisPairs(modes, hashesByMode);
    const axisImpact = summarizeAxisImpact(axisComparison);
    // Розбивка за мовою запиту. Саме тут вона й важлива: у зовнішніх датасетах
    // поділ між українською та англійською майже рівний (84 / 79 / 1 нейтральний),
    // тож крослінгвальний результат вимірюється на збалансованому наборі.
    const languageBreakdown = summarizeLanguages(modes, summary, guessedLanguageCases);
    const randomSeedRuns = summarizeRandomSeedRuns(modes, summary, seedsByMode);

    const footer = { seedGroups, axisComparison, axisImpact, languageBreakdown };
    if (randomSeedRuns) footer.randomSeedRuns = randomSeedRuns;

    // Хвіст звіту і зняття суфікса .partial — самі результати вже на диску.
    await report.close(footer);

    // Вивід таблиці порівняння. Об'єкт бере той самий потоковий записувач,
    // що й у test-rag.js: власної збірки {summary} тут більше немає, тож
    // форма й порядок ключів у двох тестах не розходяться.
    renderReportTable(report.summaryView(footer));

    const multiSeedGroups = Object.entries(seedGroups).filter(([, g]) => g.runs > 1);
    if (multiSeedGroups.length > 0) {
      console.log(pc.bold(`\n📈 РОЗКИД PASS RATE ПО SEED-АХ (${axes.seed.length} прогони на режим):`));
      console.log("-".repeat(101));
      for (const [name, group] of multiSeedGroups) {
        const r = group.passRate;
        console.log(
          name.padEnd(38) +
            `середнє ${r.mean.toFixed(1)}%`.padEnd(18) +
            `мін ${r.min}%`.padEnd(12) +
            `макс ${r.max}%`.padEnd(12) +
            `σ ${r.stdev.toFixed(2)}`,
        );
      }
      console.log("-".repeat(101));
    }

    if (randomSeedRuns) {
      console.log(pc.bold("\n🎲 ПРОГОНИ НА ВИПАДКОВОМУ ЗЕРНІ (не точки порівняння):"));
      console.log("-".repeat(101));
      for (const [name, stat] of Object.entries(randomSeedRuns.modes)) {
        console.log(
          name.padEnd(38) +
            `кейсів ${stat.cases}`.padEnd(16) +
            `різних seed ${stat.distinctSeeds}`.padEnd(20) +
            `pass rate ${stat.passRate}%`,
        );
      }
      console.log("-".repeat(101));
      console.log(pc.gray(`   ${randomSeedRuns.note}`));
    }

    if (axisComparison.length > 0) {
      console.log(
        pc.bold(`\n🧬 ІДЕНТИЧНІСТЬ ВИВОДУ LLM ПО ОСЯХ (порівнянних пар: ${axisComparison.length}):`),
      );
      console.log("-".repeat(101));
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
    }

    console.log(`📁 Детальний звіт збережено у: ${reportPath}\n`);

    const totalRunCases = totalPassed + totalFailed;
    onProgress("EXTERNAL-тести завершено.", 100);

    return {
      ok: totalFailed === 0,
      totalCases: totalRunCases,
      passed: totalPassed,
      failed: totalFailed,
      passRate: totalRunCases ? parseFloat(((totalPassed / totalRunCases) * 100).toFixed(1)) : 0,
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
