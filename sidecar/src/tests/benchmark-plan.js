/**
 * Файл: src/tests/benchmark-plan.js
 * Опис: Ціна прогону ДО його запуску — скільки буде режимів, скільки запитів
 *       до LLM і скільки це приблизно триватиме.
 *
 * Навіщо. Осі тепер задаються в панелі розробника, а бенчмарк запускають на
 * ніч. Побачити «6 режимів × 68 кейсів = 408 прогонів» треба
 * ДО запуску, а не за фактом. Рахувати це в React власною формулою не можна:
 * два незалежні підрахунки неминуче розійдуться. Тому і панель, і сам
 * прогін питають одне й те саме місце — `resolveBenchmarkPlan`.
 *
 * Оцінка часу береться з ОСТАННЬОГО звіту того самого виду, а не зі стелі:
 * швидкість залежить від машини, моделі й довжини промпта. Якщо звітів ще
 * немає — беремо виміряний раніше типовий темп і чесно кажемо про це полем
 * `estimate.source`.
 */

import fs from "fs/promises";
import path from "path";
import { config } from "../config/config.js";
import { TEST_CASES } from "./test-cases.js";
import { loadExternalCases } from "./test-external.js";
import { resolveBenchmarkPlan } from "./benchmark-matrix.js";

/** Види бенчмарку. Ті самі значення, що й `benchmarkKind` у звіті. */
export const BENCHMARK_KINDS = ["rag", "external"];

/**
 * Типовий темп, коли жодного звіту ще немає. Числа не вигадані: це wall-час
 * на один прогін із нічних звітів 29.08 (RAG — 2682 с на 936 прогонів;
 * EXTERNAL — 3093 с сумарної латентності на 153 кейси при testConcurrency = 3).
 */
const DEFAULT_MS_PER_RUN = { rag: 2900, external: 6700 };

/** Кеш кількості зовнішніх кейсів: файл кейсів за сесію не міняється. */
let externalCaseCount = null;

/** Кеш оцінки темпу: вид → {file, mtimeMs, msPerRun, source}. */
const estimateCache = new Map();

/** Тека звітів. Береться з конфіга, а не з cwd (див. rpc.md, reports.list). */
function reportsDir() {
  return path.join(config.paths.sidecarDir, "test-reports");
}

/** Чи належить файл звіту цьому виду бенчмарку. */
function matchesKind(name, kind) {
  if (!name.endsWith(".json")) return false;
  const isExternal = name.startsWith("report-external-");
  return kind === "external" ? isExternal : name.startsWith("report-") && !isExternal;
}

/**
 * Скільки кейсів у наборі. Для зовнішніх тестів рахуємо тим самим експортом,
 * яким і прогонятимемо, щоб план не розходився з фактичним запуском.
 * @param {"rag"|"external"} kind
 */
export async function caseCountFor(kind) {
  if (kind !== "external") return TEST_CASES.length;
  if (externalCaseCount !== null) return externalCaseCount;
  const cases = await loadExternalCases();
  externalCaseCount = cases.length;
  return externalCaseCount;
}

/**
 * Wall-час одного прогону з останнього звіту цього виду.
 *
 * `wallTimeMs` у підсумку режиму з'явився разом із матрицею в EXTERNAL-тесті.
 * У старих звітах його немає, і там `totalTimeMs` означає різне: у RAG це
 * час режиму «від першого до останнього», у EXTERNAL — СУМА тривалостей
 * кейсів. Тому для старого EXTERNAL-звіту ділимо на testConcurrency.
 *
 * @param {"rag"|"external"} kind
 * @returns {Promise<{msPerRun: number, source: string}>}
 */
export async function estimateMsPerRun(kind) {
  const dir = reportsDir();
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((name) => matchesKind(name, kind));
  } catch {
    names = [];
  }

  let newest = null;
  for (const name of names) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!stat) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: stat.mtimeMs };
  }

  if (!newest) {
    return { msPerRun: DEFAULT_MS_PER_RUN[kind] || DEFAULT_MS_PER_RUN.rag, source: "типовий темп (звітів ще немає)" };
  }

  const cached = estimateCache.get(kind);
  if (cached && cached.file === newest.name && cached.mtimeMs === newest.mtimeMs) {
    return { msPerRun: cached.msPerRun, source: cached.source };
  }

  let report = null;
  try {
    report = JSON.parse(await fs.readFile(path.join(dir, newest.name), "utf8"));
  } catch {
    // Зіпсований або недописаний звіт — не привід ламати планування.
    return { msPerRun: DEFAULT_MS_PER_RUN[kind] || DEFAULT_MS_PER_RUN.rag, source: "типовий темп (останній звіт не прочитано)" };
  }

  const concurrency = Number(config.rag.testConcurrency) || 1;
  let wallMs = 0;
  let runs = 0;
  for (const entry of Object.values(report.modes || {})) {
    const summary = entry?.summary;
    if (!summary) continue;
    const cases = (summary.passed || 0) + (summary.failed || 0);
    if (cases === 0) continue;
    runs += cases;
    if (Number.isFinite(summary.wallTimeMs)) wallMs += summary.wallTimeMs;
    else if (report.benchmarkKind === "external") wallMs += (summary.totalTimeMs || 0) / concurrency;
    else wallMs += summary.totalTimeMs || 0;
  }

  if (runs === 0 || wallMs <= 0) {
    return { msPerRun: DEFAULT_MS_PER_RUN[kind] || DEFAULT_MS_PER_RUN.rag, source: "типовий темп (у звіті немає часу)" };
  }

  const msPerRun = Math.round(wallMs / runs);
  const source = `останній звіт ${newest.name}`;
  estimateCache.set(kind, { file: newest.name, mtimeMs: newest.mtimeMs, msPerRun, source });
  return { msPerRun, source };
}

/**
 * План прогону для панелі: осі, режими, кількість прогонів і оцінка часу.
 * Нічого не запускає і нічого не змінює — читання.
 *
 * @param {Object} params - `{kind, axes}`; `axes` — перекриття з інтерфейсу.
 * @returns {Promise<Object>}
 */
export async function planBenchmark({ kind = "rag", axes = null } = {}) {
  if (!BENCHMARK_KINDS.includes(kind)) {
    throw new Error(`Невідомий kind «${kind}». Дозволені: ${BENCHMARK_KINDS.join(", ")}.`);
  }

  const caseCount = await caseCountFor(kind);
  const benchmark = config.rag.benchmark || {};
  // Осі перевіряються тим самим кодом, що й у прогоні: помилку в полі форми
  // людина бачить одразу, а не через годину після старту.
  const plan = resolveBenchmarkPlan({
    benchmark,
    overrides: axes,
    caseCount,
    extra: { chatModel: config.ollama.chatModel, embedModel: config.embedModelName },
  });

  const { msPerRun, source } = await estimateMsPerRun(kind);

  return {
    kind,
    axes: plan.axes,
    // Осі з конфіга окремо: панель показує, що саме успадковано, а що задано руками.
    configAxes: resolveBenchmarkPlan({ benchmark, overrides: null, caseCount }).axes,
    modeNames: plan.modes.map((mode) => mode.name),
    modeCount: plan.modes.length,
    caseCount,
    totalRuns: plan.totalRuns,
    maxModes: plan.maxModes,
    blocked: plan.exceeded,
    blockedReason: plan.limitMessage,
    lines: plan.lines,
    estimate: {
      msPerRun,
      totalMs: plan.totalRuns * msPerRun,
      concurrency: Number(config.rag.testConcurrency) || 1,
      source,
    },
  };
}
