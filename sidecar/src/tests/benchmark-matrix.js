/**
 * Файл: src/tests/benchmark-matrix.js
 * Опис: Матриця режимів RAG-бенчмарку + зведення її результатів.
 *
 * Навіщо. Раніше 12 режимів були зашиті трьома масивами в test-rag.js, тож
 * будь-який точковий експеримент вимагав правки коду. Тепер осі описані
 * в `config/pipeline.config.json` → `rag.benchmark.axes`, і матриця — це
 * повний добуток їхніх значень. Щоб зафіксувати вісь, лишають у ній одне
 * значення; щоб варіювати — додають кілька.
 *
 * Повний добуток усіх п'яти осей — 3 × 2 × 2 × 3 × N seed-ів = 36N режимів
 * по 26 кейсів, і прогнати таке цілком неможливо. Тому:
 *   1) кількість прогонів рахується ДО старту (див. describeMatrix);
 *   2) є запобіжник `maxModes`, який не дає випадково запустити всю матрицю.
 *
 * Тут же — дві речі, заради яких осі й додавались:
 *   - summarizeSeedGroups(): розкид pass rate по seed-ах (min/max/σ), бо без
 *     нього «XML не впливає» не відрізнити від «одному зразку не пощастило»;
 *   - compareAxisPairs(): підрахунок побайтово однакових відповідей LLM між
 *     режимами, що відрізняються рівно однією віссю. Якщо 26 з 26 збіглися —
 *     вісь інертна, і статистика вже не потрібна.
 */

import { mean, min, max, standardDeviation } from "simple-statistics";
import { SEARCH_MODES } from "../modules/rag/engine.js";
import { SYSTEM_PROMPT_MODES } from "../modules/rag/prompts.js";

/**
 * Осі за замовчуванням = поведінка до появи конфігурованої матриці:
 * 3 × 2 × 2 = 12 режимів, systemPrompt "system", seed 42.
 * Потрібні, щоб старий конфіг (без блока `benchmark`) далі давав ті самі
 * 12 режимів і старі звіти лишались порівнюваними.
 */
export const DEFAULT_AXES = Object.freeze({
  search: ["vector", "fts", "hybrid"],
  xml: [false, true],
  reorder: [false, true],
  systemPrompt: ["system"],
  seed: [42],
});

/** Порядок осей у назвах, підрахунках і порівняннях. Один на весь модуль. */
export const AXIS_NAMES = ["search", "xml", "reorder", "systemPrompt", "seed"];

/** Легасі-значення осей: доки вісь стоїть на ньому, її не згадують у назві режиму. */
const LEGACY_VALUE = { systemPrompt: "system", seed: 42 };

/** Приводить значення осі до масиву: в конфізі дозволено і скаляр, і список. */
function toList(value, fallback) {
  if (value === undefined) return [...fallback];
  const list = Array.isArray(value) ? value : [value];
  return list;
}

/** Перетворює значення seed на число або null (null = не надсилати seed). */
function normalizeSeed(value) {
  if (value === null || value === "none" || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Некоректний seed «${value}» у rag.benchmark.axes.seed. Дозволені: число або null.`);
  }
  return num;
}

/**
 * Читає й перевіряє осі з конфіга.
 * @param {Object} benchmarkConfig - `config.rag.benchmark` (може бути undefined).
 * @returns {{search: string[], xml: boolean[], reorder: boolean[],
 *            systemPrompt: string[], seed: (number|null)[]}}
 */
export function resolveAxes(benchmarkConfig = {}) {
  const raw = benchmarkConfig?.axes || {};

  const axes = {
    search: toList(raw.search, DEFAULT_AXES.search).map(String),
    xml: toList(raw.xml, DEFAULT_AXES.xml).map(Boolean),
    reorder: toList(raw.reorder, DEFAULT_AXES.reorder).map(Boolean),
    systemPrompt: toList(raw.systemPrompt, DEFAULT_AXES.systemPrompt).map(String),
    seed: toList(raw.seed, DEFAULT_AXES.seed).map(normalizeSeed),
  };

  for (const [name, list] of Object.entries(axes)) {
    if (list.length === 0) {
      throw new Error(`Вісь «${name}» у rag.benchmark.axes порожня. Потрібне хоча б одне значення.`);
    }
    // Дублі в осі — це подвійний прогін того самого режиму з тією ж назвою:
    // звіт мовчки втратив би один із них.
    const unique = new Set(list.map((v) => String(v)));
    if (unique.size !== list.length) {
      throw new Error(`Вісь «${name}» у rag.benchmark.axes містить повтори: ${JSON.stringify(list)}.`);
    }
  }

  const badSearch = axes.search.find((v) => !SEARCH_MODES.includes(v));
  if (badSearch) {
    throw new Error(`Невідомий searchMode «${badSearch}». Дозволені: ${SEARCH_MODES.join(", ")}.`);
  }
  const badSystem = axes.systemPrompt.find((v) => !SYSTEM_PROMPT_MODES.includes(v));
  if (badSystem) {
    throw new Error(
      `Невідомий systemPrompt «${badSystem}». Дозволені: ${SYSTEM_PROMPT_MODES.join(", ")}.`,
    );
  }

  return axes;
}

/** Людське написання значення осі для назви режиму. */
function labelOf(axis, value) {
  if (axis === "seed") return value === null ? "none" : String(value);
  return String(value);
}

/**
 * Будує список режимів — повний добуток осей.
 *
 * Назва режиму лишається старою (`hybrid+XML+Reorder`), доки нові осі стоять
 * на легасі-значеннях і не варіюються. Щойно вісь варіює або відходить від
 * дефолта — вона з'являється в назві суфіксом `|sp=…` / `|seed=…`. Так
 * типовий конфіг дає рівно ті самі 12 назв, що й раніше.
 *
 * @param {Object} axes - результат resolveAxes()
 * @param {Object} extra - незмінні для всього прогону параметри (temperature, models)
 * @returns {Array<Object>} режими з полями {name, groupName, params}
 */
export function buildModes(axes, extra = {}) {
  const showSp = axes.systemPrompt.length > 1 || axes.systemPrompt[0] !== LEGACY_VALUE.systemPrompt;
  const showSeed = axes.seed.length > 1 || axes.seed[0] !== LEGACY_VALUE.seed;

  const modes = [];
  for (const search of axes.search) {
    for (const xml of axes.xml) {
      for (const reorder of axes.reorder) {
        for (const systemPrompt of axes.systemPrompt) {
          for (const seed of axes.seed) {
            const base = `${search}${xml ? "+XML" : ""}${reorder ? "+Reorder" : ""}`;
            // groupName не містить seed: саме по ньому групуються повтори
            // того самого режиму на різних зернах.
            const groupName = base + (showSp ? `|sp=${systemPrompt}` : "");
            const name = groupName + (showSeed ? `|seed=${labelOf("seed", seed)}` : "");
            modes.push({
              name,
              groupName,
              search,
              xml,
              reorder,
              systemPrompt,
              seed,
              // Повний набір параметрів, яким режим отримано: звіт має
              // лишатися самодостатнім і через місяць.
              params: {
                search,
                xml,
                reorder,
                systemPrompt,
                seed,
                temperature: extra.temperature ?? null,
                chatModel: extra.chatModel ?? null,
                embedModel: extra.embedModel ?? null,
              },
            });
          }
        }
      }
    }
  }
  return modes;
}

/**
 * Текстовий опис матриці для консолі та прогресу. Друкується ДО прогону,
 * щоб людина побачила масштаб перш ніж піти спати.
 *
 * @param {Object} axes
 * @param {Array} modes
 * @param {number} caseCount - кількість тестових кейсів
 * @returns {{lines: string[], totalRuns: number, seedRepeats: number}}
 */
export function describeMatrix(axes, modes, caseCount) {
  const totalRuns = modes.length * caseCount;
  const groups = new Set(modes.map((m) => m.groupName));
  const seedRepeats = axes.seed.length;

  const lines = [];
  lines.push("Матриця режимів (rag.benchmark.axes):");
  for (const axis of AXIS_NAMES) {
    const values = axes[axis].map((v) => labelOf(axis, v)).join(", ");
    const pinned = axes[axis].length === 1 ? " (зафіксовано)" : ` (${axes[axis].length} значення)`;
    lines.push(`  ${axis.padEnd(13)} = [${values}]${pinned}`);
  }
  lines.push(
    `Разом: ${modes.length} режимів (${groups.size} унікальних × ${seedRepeats} seed) × ` +
      `${caseCount} кейсів = ${totalRuns} прогонів LLM.`,
  );
  return { lines, totalRuns, seedRepeats };
}

/**
 * Розкид pass rate по seed-ах усередині кожної групи режимів.
 * Середнє без розкиду в дипломі нічого не доводить, тому рахуємо ще
 * min/max/σ. σ — популяційне (у нас на руках УСІ прогони групи, а не вибірка).
 *
 * @param {Array} modes - режими з buildModes()
 * @param {Object} summaryByMode - {назва режиму: {passRate, passed, ...}}
 * @returns {Object} {назва групи: {...}}
 */
export function summarizeSeedGroups(modes, summaryByMode) {
  const groups = {};
  for (const mode of modes) {
    const summary = summaryByMode[mode.name];
    if (!summary) continue;
    if (!groups[mode.groupName]) {
      groups[mode.groupName] = { modeNames: [], seeds: [], passRates: [] };
    }
    groups[mode.groupName].modeNames.push(mode.name);
    groups[mode.groupName].seeds.push(mode.seed);
    groups[mode.groupName].passRates.push(summary.passRate);
  }

  const out = {};
  for (const [groupName, g] of Object.entries(groups)) {
    const values = g.passRates;
    out[groupName] = {
      runs: values.length,
      seeds: g.seeds,
      modeNames: g.modeNames,
      passRate: {
        values,
        mean: mean(values),
        min: min(values),
        max: max(values),
        // Один прогін — розкиду немає за визначенням, і 0 тут чесніше за NaN.
        stdev: values.length > 1 ? standardDeviation(values) : 0,
        spread: max(values) - min(values),
      },
    };
  }
  return out;
}

/** Чи відрізняються два режими рівно однією віссю; повертає назву осі або null. */
function differingAxis(a, b) {
  const diff = AXIS_NAMES.filter((axis) => String(a[axis]) !== String(b[axis]));
  return diff.length === 1 ? diff[0] : null;
}

/**
 * Порівняння сирих відповідей LLM між режимами, що відрізняються рівно
 * однією віссю. Побайтово однаковий вивід — найпереконливіше свідчення
 * інертності осі: 26 із 26 закривають питання без будь-якої статистики.
 *
 * @param {Array} modes - режими з buildModes()
 * @param {Map<string, Map<string, string>>} hashesByMode - режим → (запит → hash)
 * @returns {Array<Object>} по парі на кожну порівнянну пару режимів
 */
export function compareAxisPairs(modes, hashesByMode) {
  const pairs = [];
  for (let i = 0; i < modes.length; i++) {
    for (let j = i + 1; j < modes.length; j++) {
      const axis = differingAxis(modes[i], modes[j]);
      if (!axis) continue;

      const left = hashesByMode.get(modes[i].name);
      const right = hashesByMode.get(modes[j].name);
      if (!left || !right) continue;

      let compared = 0;
      let identical = 0;
      for (const [query, hash] of left) {
        if (!right.has(query)) continue;
        compared += 1;
        if (right.get(query) === hash) identical += 1;
      }
      if (compared === 0) continue;

      pairs.push({
        axis,
        from: modes[i].name,
        to: modes[j].name,
        fromValue: labelOf(axis, modes[i][axis]),
        toValue: labelOf(axis, modes[j][axis]),
        cases: compared,
        identical,
        differing: compared - identical,
        identicalPct: Math.round((identical / compared) * 100),
      });
    }
  }
  // Найцікавіше зверху: спершу осі, які нічого не змінили.
  pairs.sort((a, b) => b.identicalPct - a.identicalPct || a.axis.localeCompare(b.axis));
  return pairs;
}

/** Зведення по осі: чи змінила вона хоч щось хоч десь. */
export function summarizeAxisImpact(pairs) {
  const byAxis = {};
  for (const pair of pairs) {
    if (!byAxis[pair.axis]) {
      byAxis[pair.axis] = { pairs: 0, cases: 0, identical: 0 };
    }
    byAxis[pair.axis].pairs += 1;
    byAxis[pair.axis].cases += pair.cases;
    byAxis[pair.axis].identical += pair.identical;
  }
  for (const stat of Object.values(byAxis)) {
    stat.identicalPct = stat.cases ? Math.round((stat.identical / stat.cases) * 100) : 0;
    // «Інертна» = ЖОДЕН кейс у ЖОДНІЙ парі не змінився побайтово.
    stat.inert = stat.identical === stat.cases;
  }
  return byAxis;
}
