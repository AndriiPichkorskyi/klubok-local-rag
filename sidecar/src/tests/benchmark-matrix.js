/**
 * Файл: src/tests/benchmark-matrix.js
 * Опис: Матриця режимів бенчмарку (RAG і EXTERNAL) + зведення її результатів.
 *
 * Навіщо. Раніше 12 режимів були зашиті трьома масивами в test-rag.js, тож
 * будь-який точковий експеримент вимагав правки коду. Тепер осі описані
 * в `config/pipeline.config.json` → `rag.benchmark.axes`, і матриця — це
 * повний добуток їхніх значень. Щоб зафіксувати вісь, лишають у ній одне
 * значення; щоб варіювати — додають кілька. Ті самі осі можна передати з
 * інтерфейсу (`tests.run({axes})`): те, чого в них немає, береться з конфіга.
 *
 * Повний добуток усіх шести осей — 3 × 2 × 2 × 3 × T × N seed = 36·T·N режимів,
 * і прогнати таке цілком неможливо. Тому:
 *   1) кількість прогонів рахується ДО старту (див. describeMatrix);
 *   2) є запобіжник `maxModes`, який не дає випадково запустити всю матрицю.
 *
 * ДВІ ОСІ, ДОДАНІ ПІСЛЯ НІЧНОГО ПРОГОНУ 36 РЕЖИМІВ (35 із 36 дали рівно 92%):
 *   - `temperature`. Досі вона була константою 0.1 і жодним експериментом не
 *     була, хоча вивід моделі при фіксованому seed уже змінювався в 44%
 *     випадків — тобто система недетермінована, і температура варта перевірки
 *     більше за XML-теги.
 *   - `seed: "random"`. Це НЕ ще одна точка поруч із 1, 2, 3: кожен кейс
 *     отримує власне випадкове зерно, тож режим міряє власну нестабільність
 *     системи, а не порівнює конкретні налаштування. Тому такий режим:
 *       * не потрапляє в `seedGroups` (там σ по ТОЧКАХ seed-осі),
 *       * не потрапляє в `compareAxisPairs` (порівнювати побайтово вивід із
 *         випадковим зерном проти фіксованого — доводити, що випадкове
 *         випадкове),
 *       * має власний блок `randomSeedRuns`, а фактичне зерно кожного кейса
 *         лежить у полі `seed` його результату — без цього прогін не відтворити.
 *
 * Тут же — дві речі, заради яких осі й додавались:
 *   - summarizeSeedGroups(): розкид pass rate по seed-ах (min/max/σ), бо без
 *     нього «XML не впливає» не відрізнити від «одному зразку не пощастило»;
 *   - compareAxisPairs(): підрахунок побайтово однакових відповідей LLM між
 *     режимами, що відрізняються рівно однією віссю. Якщо 26 з 26 збіглися —
 *     вісь інертна, і статистика вже не потрібна.
 */

import { randomInt } from "crypto";
import { mean, min, max, standardDeviation } from "simple-statistics";
import { SEARCH_MODES } from "../modules/rag/engine.js";
import { SYSTEM_PROMPT_MODES } from "../modules/rag/prompts.js";

/** Значення осі seed, за яким кожен кейс отримує власне випадкове зерно. */
export const RANDOM_SEED = "random";

/**
 * Осі за замовчуванням = поведінка до появи конфігурованої матриці:
 * 3 × 2 × 2 = 12 режимів, systemPrompt "system", seed 42, temperature 0.1.
 * Потрібні, щоб старий конфіг (без блока `benchmark`) далі давав ті самі
 * 12 режимів і старі звіти лишались порівнюваними.
 */
export const DEFAULT_AXES = Object.freeze({
  search: ["vector", "fts", "hybrid"],
  xml: [false, true],
  reorder: [false, true],
  systemPrompt: ["system"],
  seed: [42],
  temperature: [0.1],
});

/** Порядок осей у назвах, підрахунках і порівняннях. Один на весь модуль. */
export const AXIS_NAMES = ["search", "xml", "reorder", "systemPrompt", "seed", "temperature"];

/** Легасі-значення осей: доки вісь стоїть на ньому, її не згадують у назві режиму. */
const LEGACY_VALUE = { systemPrompt: "system", seed: 42, temperature: 0.1 };

/** Верхня межа температури. 2 — стеля api Ollama; більше — майже напевно друкарська помилка. */
const MAX_TEMPERATURE = 2;

/** Приводить значення осі до масиву: в конфізі дозволено і скаляр, і список. */
function toList(value, fallback) {
  if (value === undefined || value === null) return [...fallback];
  const list = Array.isArray(value) ? value : [value];
  return list;
}

/** Перетворює значення seed на число, null (не надсилати seed) або RANDOM_SEED. */
function normalizeSeed(value) {
  if (value === null || value === "none" || value === "") return null;
  if (typeof value === "string" && value.trim().toLowerCase() === RANDOM_SEED) return RANDOM_SEED;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(
      `Некоректний seed «${value}» у осі seed. Дозволені: число, null або "${RANDOM_SEED}".`,
    );
  }
  return num;
}

/** Температура: число в межах 0..2. Рядок «0.7» з поля вводу теж приймаємо. */
function normalizeTemperature(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Некоректна temperature «${value}»: очікується число від 0 до ${MAX_TEMPERATURE}.`);
  }
  if (num < 0 || num > MAX_TEMPERATURE) {
    throw new Error(
      `temperature «${value}» поза межами 0..${MAX_TEMPERATURE}. Значення поза цим діапазоном ` +
        `Ollama або відкине, або перетворить генерацію на шум.`,
    );
  }
  return num;
}

/**
 * Булева вісь. `Boolean("false")` дорівнює true, тому рядки розбираємо явно:
 * значення з інтерфейсу приходить із поля форми, і мовчазна «істина» тут
 * коштувала б цілого нічного прогону не тієї матриці.
 */
function normalizeBool(value) {
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  throw new Error(`Некоректне булеве значення осі «${value}». Дозволені: true / false.`);
}

/**
 * Читає й перевіряє осі.
 *
 * @param {Object} benchmarkConfig - `config.rag.benchmark` (може бути undefined).
 * @param {Object|null} overrides - осі з інтерфейсу; КОЖНА задана вісь замінює
 *        конфіг цілком, незадані беруться з конфіга. Конфіг лишається джерелом
 *        за замовчуванням — інтерфейс лише перекриває окремі осі.
 * @returns {{search: string[], xml: boolean[], reorder: boolean[],
 *            systemPrompt: string[], seed: (number|null|"random")[],
 *            temperature: number[]}}
 */
export function resolveAxes(benchmarkConfig = {}, overrides = null) {
  const fromConfig = benchmarkConfig?.axes || {};
  const fromUi = overrides && typeof overrides === "object" ? overrides : {};

  const unknown = Object.keys(fromUi).filter((key) => !AXIS_NAMES.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Невідомі осі в params.axes: ${unknown.join(", ")}. Дозволені: ${AXIS_NAMES.join(", ")}.`,
    );
  }

  /** Джерело значень однієї осі: інтерфейс > конфіг > дефолт. */
  const pick = (axis) => (fromUi[axis] !== undefined ? fromUi[axis] : fromConfig[axis]);

  const axes = {
    search: toList(pick("search"), DEFAULT_AXES.search).map(String),
    xml: toList(pick("xml"), DEFAULT_AXES.xml).map(normalizeBool),
    reorder: toList(pick("reorder"), DEFAULT_AXES.reorder).map(normalizeBool),
    systemPrompt: toList(pick("systemPrompt"), DEFAULT_AXES.systemPrompt).map(String),
    seed: toList(pick("seed"), DEFAULT_AXES.seed).map(normalizeSeed),
    temperature: toList(pick("temperature"), DEFAULT_AXES.temperature).map(normalizeTemperature),
  };

  for (const [name, list] of Object.entries(axes)) {
    if (list.length === 0) {
      throw new Error(`Вісь «${name}» порожня. Потрібне хоча б одне значення.`);
    }
    // Дублі в осі — це подвійний прогін того самого режиму з тією ж назвою:
    // звіт мовчки втратив би один із них.
    const unique = new Set(list.map((v) => String(v)));
    if (unique.size !== list.length) {
      throw new Error(`Вісь «${name}» містить повтори: ${JSON.stringify(list)}.`);
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

/** Чи є режим прогоном на випадкових зернах (а не точкою seed-осі). */
export function isRandomSeedMode(mode) {
  return mode?.seed === RANDOM_SEED;
}

/**
 * Зерно для конкретного кейса. Для фіксованої осі — саме її значення,
 * для `seed: "random"` — нове випадкове число на КОЖЕН запит.
 * Використовуємо `crypto.randomInt` (Node), а не власну арифметику з Math.random.
 * @param {Object} mode - режим із buildModes()
 * @returns {number|null}
 */
export function nextSeedFor(mode) {
  if (!isRandomSeedMode(mode)) return mode.seed;
  // Верхня межа — 2^31-1: Ollama приймає seed як 32-бітне ціле зі знаком.
  return randomInt(1, 2 ** 31 - 1);
}

/**
 * Будує список режимів — повний добуток осей.
 *
 * Назва режиму лишається старою (`hybrid+XML+Reorder`), доки нові осі стоять
 * на легасі-значеннях і не варіюються. Щойно вісь варіює або відходить від
 * дефолта — вона з'являється в назві суфіксом `|sp=…` / `|t=…` / `|seed=…`. Так
 * типовий конфіг дає рівно ті самі 12 назв, що й раніше.
 *
 * @param {Object} axes - результат resolveAxes()
 * @param {Object} extra - незмінні для всього прогону параметри (моделі)
 * @returns {Array<Object>} режими з полями {name, groupName, params}
 */
export function buildModes(axes, extra = {}) {
  const showSp = axes.systemPrompt.length > 1 || axes.systemPrompt[0] !== LEGACY_VALUE.systemPrompt;
  const showSeed = axes.seed.length > 1 || axes.seed[0] !== LEGACY_VALUE.seed;
  const showTemp = axes.temperature.length > 1 || axes.temperature[0] !== LEGACY_VALUE.temperature;

  const modes = [];
  for (const search of axes.search) {
    for (const xml of axes.xml) {
      for (const reorder of axes.reorder) {
        for (const systemPrompt of axes.systemPrompt) {
          for (const temperature of axes.temperature) {
            for (const seed of axes.seed) {
              const base = `${search}${xml ? "+XML" : ""}${reorder ? "+Reorder" : ""}`;
              // groupName не містить seed: саме по ньому групуються повтори
              // того самого режиму на різних зернах.
              const groupName =
                base + (showSp ? `|sp=${systemPrompt}` : "") + (showTemp ? `|t=${temperature}` : "");
              const name = groupName + (showSeed ? `|seed=${labelOf("seed", seed)}` : "");
              const seedKind = seed === RANDOM_SEED ? "random" : "fixed";
              modes.push({
                name,
                groupName,
                search,
                xml,
                reorder,
                systemPrompt,
                seed,
                temperature,
                seedKind,
                // Повний набір параметрів, яким режим отримано: звіт має
                // лишатися самодостатнім і через місяць.
                params: {
                  search,
                  xml,
                  reorder,
                  systemPrompt,
                  seed,
                  temperature,
                  chatModel: extra.chatModel ?? null,
                  embedModel: extra.embedModel ?? null,
                  seedKind,
                },
              });
            }
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
 * @param {string} [title] - заголовок (у зовнішніх тестах кейсів інша кількість)
 * @returns {{lines: string[], totalRuns: number, seedRepeats: number}}
 */
export function describeMatrix(axes, modes, caseCount, title = "Матриця режимів (rag.benchmark.axes):") {
  const totalRuns = modes.length * caseCount;
  const groups = new Set(modes.map((m) => m.groupName));
  const seedRepeats = axes.seed.length;
  const randomModes = modes.filter(isRandomSeedMode).length;

  const lines = [];
  lines.push(title);
  for (const axis of AXIS_NAMES) {
    const values = axes[axis].map((v) => labelOf(axis, v)).join(", ");
    const pinned = axes[axis].length === 1 ? " (зафіксовано)" : ` (${axes[axis].length} значення)`;
    lines.push(`  ${axis.padEnd(13)} = [${values}]${pinned}`);
  }
  lines.push(
    `Разом: ${modes.length} режимів (${groups.size} унікальних × ${seedRepeats} seed) × ` +
      `${caseCount} кейсів = ${totalRuns} прогонів LLM.`,
  );
  if (randomModes > 0) {
    lines.push(
      `З них ${randomModes} режимів на ВИПАДКОВОМУ зерні: кожен кейс отримує власний seed, ` +
        `тож це вимір нестабільності системи, а не точка порівняння.`,
    );
  }
  return { lines, totalRuns, seedRepeats };
}

/**
 * Повний план прогону: осі, режими, масштаб і перевірка запобіжника.
 * Один на обидва тести (RAG і EXTERNAL) і на метод `tests.plan`, щоб числа
 * в інтерфейсі й числа прогону не рахувалися двома різними формулами.
 *
 * @param {Object} args
 * @param {Object} args.benchmark - config.rag.benchmark
 * @param {Object|null} args.overrides - осі з інтерфейсу
 * @param {number} args.caseCount - скільки кейсів у наборі
 * @param {Object} [args.extra] - моделі для params режиму
 * @param {string} [args.title] - заголовок опису матриці
 * @returns {{axes, modes, maxModes, exceeded, limitMessage, lines, totalRuns, seedRepeats, caseCount}}
 */
export function resolveBenchmarkPlan({ benchmark = {}, overrides = null, caseCount, extra = {}, title }) {
  const axes = resolveAxes(benchmark, overrides);
  const modes = buildModes(axes, extra);
  const maxModes = Number(benchmark?.maxModes) || 0;
  const exceeded = maxModes > 0 && modes.length > maxModes;
  const { lines, totalRuns, seedRepeats } = describeMatrix(axes, modes, caseCount, title);

  const limitMessage = exceeded
    ? `Матриця дає ${modes.length} режимів × ${caseCount} кейсів = ${totalRuns} прогонів LLM, ` +
      `а запобіжник rag.benchmark.maxModes = ${maxModes}. Прогін не почато. ` +
      `Звузьте осі (у панелі розробника або в config/pipeline.config.json) ` +
      `або свідомо підніміть maxModes.`
    : null;

  return { axes, modes, maxModes, exceeded, limitMessage, lines, totalRuns, seedRepeats, caseCount };
}

/** Кидає помилку, якщо план не проходить запобіжник. Викликається ДО першого запиту до LLM. */
export function assertModeLimit(plan) {
  if (plan.exceeded) throw new Error(plan.limitMessage);
  return plan;
}

/**
 * Розкид pass rate по seed-ах усередині кожної групи режимів.
 * Середнє без розкиду в дипломі нічого не доводить, тому рахуємо ще
 * min/max/σ. σ — популяційне (у нас на руках УСІ прогони групи, а не вибірка).
 *
 * Режими на випадковому зерні сюди НЕ входять: у них немає точки seed, яку
 * можна було б назвати, і їх усереднення жило б окремо (randomSeedRuns).
 *
 * @param {Array} modes - режими з buildModes()
 * @param {Object} summaryByMode - {назва режиму: {passRate, passed, ...}}
 * @returns {Object} {назва групи: {...}}
 */
export function summarizeSeedGroups(modes, summaryByMode) {
  const groups = {};
  for (const mode of modes) {
    if (isRandomSeedMode(mode)) continue;
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

/** Скільки зерен показувати у зведенні; решта лишається в результатах кейсів. */
const SEED_SAMPLE_LIMIT = 12;

/**
 * Зведення прогонів на ВИПАДКОВОМУ зерні.
 *
 * Чому окремим блоком, а не в seedGroups: усереднити pass rate по випадкових
 * зернах можна й треба (це і є оцінка власної нестабільності системи), але
 * назвати такий прогін «режимом» і поставити його поруч із seed=1 не можна —
 * його неможливо повторити, і його не з чим порівнювати побайтово.
 *
 * @param {Array} modes - режими з buildModes()
 * @param {Object} summaryByMode - підсумки режимів
 * @param {Map<string, Array<number>>} seedsByMode - режим → фактично використані зерна
 * @returns {Object|null} null, якщо випадкових режимів не було взагалі
 */
export function summarizeRandomSeedRuns(modes, summaryByMode, seedsByMode) {
  const randomModes = modes.filter(isRandomSeedMode);
  if (randomModes.length === 0) return null;

  const out = {};
  for (const mode of randomModes) {
    const summary = summaryByMode[mode.name];
    if (!summary) continue;
    const seeds = seedsByMode.get(mode.name) || [];
    const unique = new Set(seeds);
    out[mode.name] = {
      groupName: mode.groupName,
      cases: seeds.length,
      distinctSeeds: unique.size,
      // Повторене зерно на кількох кейсах — не помилка, але його варто бачити.
      repeatedSeeds: seeds.length - unique.size,
      seedSample: seeds.slice(0, SEED_SAMPLE_LIMIT),
      seedsTruncated: seeds.length > SEED_SAMPLE_LIMIT,
      passed: summary.passed,
      failed: summary.failed,
      passRate: summary.passRate,
    };
  }

  return {
    note:
      "Кожен кейс цих режимів отримав власне випадкове зерно, тому режим НЕ є точкою " +
      "порівняння: його pass rate — оцінка власної нестабільності системи, а не результат " +
      "конкретних налаштувань. Зерно кожного кейса лежить у полі `seed` його результату — " +
      "без нього прогін неможливо відтворити. У seedGroups і axisComparison такі режими " +
      "не входять навмисно.",
    modes: out,
  };
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
 * Режими на випадковому зерні в порівняння не беруться: їхній вивід
 * відрізняється за побудовою, і пара з ними не доводила б нічого.
 *
 * @param {Array} modes - режими з buildModes()
 * @param {Map<string, Map<string, string>>} hashesByMode - режим → (запит → hash)
 * @returns {Array<Object>} по парі на кожну порівнянну пару режимів
 */
export function compareAxisPairs(modes, hashesByMode) {
  const comparable = modes.filter((mode) => !isRandomSeedMode(mode));
  const pairs = [];
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const axis = differingAxis(comparable[i], comparable[j]);
      if (!axis) continue;

      const left = hashesByMode.get(comparable[i].name);
      const right = hashesByMode.get(comparable[j].name);
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
        from: comparable[i].name,
        to: comparable[j].name,
        fromValue: labelOf(axis, comparable[i][axis]),
        toValue: labelOf(axis, comparable[j][axis]),
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
