/**
 * Файл: src/tests/language.js
 * Опис: Мовна розбивка метрик бенчмарку.
 *
 * Навіщо. Документація в базі україномовна, але частина тестових запитів
 * написана англійською — і частина з них проходить. Це не дрібниця, а окремий
 * результат: крослінгвальний пошук поверх україномовного корпусу. Щоб його
 * можна було показати цифрами, кожен кейс несе явну мову, а підсумок кожного
 * режиму рахує pass rate окремо по мовах.
 *
 * ЧОМУ МОВ ТРИ, А НЕ ДВІ. Категорія `neutral` — це запити, які не належать
 * жодній мові: назви брендів («Photoshop»), навмисне безглуздя («asdfasdf
 * qwerty», «івапівпавіп»), суто символьні й форматні токени («pdf»). Якби вони
 * лягли в англійську статистику, метрика англійської була б зіпсована кейсами,
 * які взагалі не про мову.
 *
 * ЧОМУ МОВА ЗАДАНА ЯВНО, А НЕ ВИЗНАЧАЄТЬСЯ В МОМЕНТ ПРОГОНУ. Запит із двох
 * слів визначається ненадійно, а метрика диплому не має залежати від евристики.
 * Перевірено на franc-min: «Photoshop» → eng, «asdfasdf qwerty» → eng,
 * «івапівпавіп» → ukr, «pdf» → eng — чотири помилки з чотирьох саме там, де
 * правильна відповідь `neutral`. Тому автовизначення тут — ЛИШЕ запобіжник для
 * нових кейсів без поля, і кожне вгадане значення позначається в звіті
 * (`languageSource: "auto"`), а їх кількість виводиться окремим рядком.
 */

import { franc } from "franc-min";
import { mean, min, max, standardDeviation } from "simple-statistics";
import pc from "picocolors";

/** Порядок мов у всіх таблицях і підсумках. */
export const LANGUAGES = ["uk", "en", "neutral"];

/** Підписи для терміналу. */
export const LANGUAGE_LABELS = {
  uk: "українські",
  en: "англійські",
  neutral: "нейтральні",
};

/** Синоніми, які можуть трапитись у датасетах, — до канонічного коду. */
const ALIASES = {
  uk: "uk",
  ua: "uk",
  ukr: "uk",
  "uk-ua": "uk",
  en: "en",
  eng: "en",
  "en-us": "en",
  neutral: "neutral",
  none: "neutral",
  mixed: "neutral",
};

/** Приводить явне значення поля до канонічного коду; невідоме — null. */
export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  return ALIASES[value.trim().toLowerCase()] || null;
}

/**
 * Запобіжник для кейсів БЕЗ явного поля. Свідомо обмежений двома мовами
 * корпусу: усе, чого franc-min не впізнав, чесніше віднести до нейтральних,
 * ніж приписати до однієї з двох метрик, які ми й вимірюємо.
 * @returns {"uk"|"en"|"neutral"}
 */
export function detectLanguage(query) {
  const text = typeof query === "string" ? query.trim() : "";
  if (!text) return "neutral";
  const code = franc(text, { only: ["ukr", "eng"], minLength: 1 });
  if (code === "ukr") return "uk";
  if (code === "eng") return "en";
  return "neutral";
}

/**
 * Мова одного кейса. Явне поле має пріоритет завжди.
 * @param {Object} testCase - кейс із `language` (або без нього)
 * @returns {{language: string, languageSource: "explicit"|"auto"}}
 */
export function resolveCaseLanguage(testCase) {
  const explicit = normalizeLanguage(testCase?.language);
  if (explicit) return { language: explicit, languageSource: "explicit" };
  return { language: detectLanguage(testCase?.query), languageSource: "auto" };
}

/**
 * Лічильник кейсів по мовах для ОДНОГО режиму. Тримає числа, а не результати:
 * потоковий запис звіту не має сенсу, якщо метрики знову збирають масив.
 */
export function createLanguageTally() {
  const buckets = {};
  for (const language of LANGUAGES) {
    buckets[language] = { cases: 0, passed: 0, failed: 0, guessed: 0 };
  }
  return {
    /** @param {string} language @param {boolean} isSuccess @param {boolean} guessed */
    add(language, isSuccess, guessed = false) {
      const bucket = buckets[language] || buckets.neutral;
      bucket.cases += 1;
      if (isSuccess) bucket.passed += 1;
      else bucket.failed += 1;
      if (guessed) bucket.guessed += 1;
    },
    /** Підсумок режиму: {uk:{cases,passed,failed,passRate,guessed}, …}. */
    snapshot() {
      const out = {};
      for (const language of LANGUAGES) {
        const b = buckets[language];
        out[language] = {
          ...b,
          // Нуль кейсів — це не 0% успішності, а відсутність вимірювання.
          passRate: b.cases > 0 ? Math.round((b.passed / b.cases) * 100) : null,
        };
      }
      return out;
    },
  };
}

/** Розрив між мовами в одному режимі, у процентних пунктах. null = нема що порівнювати. */
export function languageGap(byLanguage) {
  const uk = byLanguage?.uk;
  const en = byLanguage?.en;
  if (!uk || !en || uk.passRate === null || en.passRate === null) return null;
  return uk.passRate - en.passRate;
}

/** Складає два набори лічильників (для сум по всіх режимах). */
function addInto(target, source) {
  for (const language of LANGUAGES) {
    const s = source?.[language];
    if (!s) continue;
    target[language].cases += s.cases;
    target[language].passed += s.passed;
    target[language].failed += s.failed;
    target[language].guessed += s.guessed || 0;
  }
}

/**
 * Зведення по всіх режимах: чи тримається мовний розрив стабільно і чи
 * залежить він від режиму пошуку.
 *
 * @param {Array} modes - режими з buildModes() (потрібне поле `search`)
 * @param {Object} summaryByMode - {назва режиму: {byLanguage: {...}}}
 * @returns {Object}
 */
export function summarizeLanguages(modes, summaryByMode, guessedCases = null) {
  const empty = () => {
    const o = {};
    for (const language of LANGUAGES) o[language] = { cases: 0, passed: 0, failed: 0, guessed: 0 };
    return o;
  };

  const totals = empty();
  const byMode = {};
  const bySearchAxis = {};
  const gaps = [];

  for (const mode of modes) {
    const byLanguage = summaryByMode[mode.name]?.byLanguage;
    if (!byLanguage) continue;

    addInto(totals, byLanguage);
    const gap = languageGap(byLanguage);
    byMode[mode.name] = { search: mode.search, byLanguage, gap };
    if (gap !== null) gaps.push(gap);

    if (!bySearchAxis[mode.search]) {
      bySearchAxis[mode.search] = { modes: 0, counts: empty() };
    }
    bySearchAxis[mode.search].modes += 1;
    addInto(bySearchAxis[mode.search].counts, byLanguage);
  }

  const withRates = (counts) => {
    const out = {};
    for (const language of LANGUAGES) {
      const c = counts[language];
      out[language] = { ...c, passRate: c.cases > 0 ? Math.round((c.passed / c.cases) * 100) : null };
    }
    return out;
  };

  const totalsWithRates = withRates(totals);

  const searchAxis = {};
  for (const [search, entry] of Object.entries(bySearchAxis)) {
    const byLanguage = withRates(entry.counts);
    searchAxis[search] = { modes: entry.modes, byLanguage, gap: languageGap(byLanguage) };
  }

  // Розрив «стабільний» — коли він майже не рухається між режимами.
  // Поріг у 5 п.п. — це один кейс із 26 у RAG-бенчмарку (3.8 п.п.), тобто
  // менше за роздільну здатність набору; ширший розкид уже про режим.
  const STABLE_SPREAD_PP = 5;
  const gapStats =
    gaps.length > 0
      ? {
          values: gaps,
          mean: mean(gaps),
          min: min(gaps),
          max: max(gaps),
          stdev: gaps.length > 1 ? standardDeviation(gaps) : 0,
          spread: max(gaps) - min(gaps),
          stable: max(gaps) - min(gaps) <= STABLE_SPREAD_PP,
        }
      : null;

  return {
    // Кількість вгаданих мов рахується по УНІКАЛЬНИХ кейсах, а не по прогонах:
    // інакше вона множилася б на кількість режимів.
    guessedCases:
      typeof guessedCases === "number"
        ? guessedCases
        : LANGUAGES.reduce((sum, l) => sum + totals[l].guessed, 0),
    totals: totalsWithRates,
    byMode,
    bySearchAxis: searchAxis,
    gap: gapStats,
  };
}

/** Один рядок «uk 88% (23/26)» для терміналу. */
function cell(entry) {
  if (!entry || entry.cases === 0) return "—";
  return `${entry.passRate}% (${entry.passed}/${entry.cases})`;
}

/**
 * Друкує мовні таблиці. Спільна для test-rag.js і test-external.js, щоб
 * вигляд розбивки не розходився між двома звітами.
 */
export function renderLanguageTables(breakdown) {
  if (!breakdown) return;

  console.log(pc.bold(`\n🌐 PASS RATE ЗА МОВОЮ ЗАПИТУ:`));
  console.log("-".repeat(101));
  console.log(
    pc.bold("Режим".padEnd(32)) +
      pc.bold("Українські".padEnd(20)) +
      pc.bold("Англійські".padEnd(20)) +
      pc.bold("Нейтральні".padEnd(20)) +
      pc.bold("Розрив uk−en"),
  );
  for (const [name, entry] of Object.entries(breakdown.byMode)) {
    console.log(
      name.padEnd(32) +
        cell(entry.byLanguage.uk).padEnd(20) +
        cell(entry.byLanguage.en).padEnd(20) +
        cell(entry.byLanguage.neutral).padEnd(20) +
        (entry.gap === null ? "—" : `${entry.gap > 0 ? "+" : ""}${entry.gap} п.п.`),
    );
  }
  console.log("-".repeat(101));
  console.log(
    "УСІ РЕЖИМИ".padEnd(32) +
      cell(breakdown.totals.uk).padEnd(20) +
      cell(breakdown.totals.en).padEnd(20) +
      cell(breakdown.totals.neutral).padEnd(20) +
      (languageGap(breakdown.totals) === null ? "—" : `${languageGap(breakdown.totals)} п.п.`),
  );

  if (breakdown.guessedCases > 0) {
    console.log(
      pc.yellow(
        `⚠️ ${breakdown.guessedCases} кейсів отримали мову АВТОВИЗНАЧЕННЯМ (franc-min), ` +
          `а не з явного поля. У звіті вони позначені languageSource: "auto".`,
      ),
    );
  }

  // Чи залежить розрив від режиму пошуку — головне питання цієї розбивки.
  const searchEntries = Object.entries(breakdown.bySearchAxis);
  if (searchEntries.length > 1) {
    console.log(pc.bold(`\n🔎 МОВНИЙ РОЗРИВ ЗА РЕЖИМОМ ПОШУКУ:`));
    console.log("-".repeat(101));
    console.log(
      pc.bold("Пошук".padEnd(14)) +
        pc.bold("Режимів".padEnd(10)) +
        pc.bold("Українські".padEnd(20)) +
        pc.bold("Англійські".padEnd(20)) +
        pc.bold("Розрив uk−en"),
    );
    for (const [search, entry] of searchEntries) {
      console.log(
        search.padEnd(14) +
          String(entry.modes).padEnd(10) +
          cell(entry.byLanguage.uk).padEnd(20) +
          cell(entry.byLanguage.en).padEnd(20) +
          (entry.gap === null ? "—" : `${entry.gap > 0 ? "+" : ""}${entry.gap} п.п.`),
      );
    }
    console.log("-".repeat(101));
  }

  if (breakdown.gap) {
    const g = breakdown.gap;
    console.log(
      g.stable
        ? pc.gray(
            `Розрив uk−en тримається стабільно: ${g.min}…${g.max} п.п. (σ ${g.stdev.toFixed(2)}) — режим на нього не впливає.`,
          )
        : pc.yellow(
            `Розрив uk−en ЗАЛЕЖИТЬ від режиму: ${g.min}…${g.max} п.п. (розкид ${g.spread} п.п., σ ${g.stdev.toFixed(2)}).`,
          ),
    );
  }
}
