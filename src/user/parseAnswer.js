/**
 * Нормалізація відповіді методу `query` (sidecar → processQuery).
 *
 * Форма, яку реально повертає sidecar/src/modules/rag/engine.js:
 *
 *  1) Ранній вихід «нічого не знайшлось у базі» (relevantChunks порожній):
 *     { response, contextApps: [], executionTimeMs, recommendedApp: "NOT_FOUND", retrievalStats }
 *     — БЕЗ полів alternativeApps, rawLlmOutput, ollamaMetrics.
 *
 *  2) Звичайний вихід:
 *     { response, rawLlmOutput, recommendedApp, alternativeApps, contextApps,
 *       executionTimeMs, ollamaMetrics, retrievalStats }
 *
 * `recommendedApp` — це або назва програми, або один із маркерів:
 * "NOT_FOUND", "INVALID_QUERY", "Не визначено".
 * `response` — Markdown-рядок; при вдалому збігу він склеєний так:
 *     **<Назва програми>**
 *
 *     <пояснення LLM>
 *
 *     **📄 Повна стаття довідки (<App> - <Title>):**
 *
 *     <повний текст статті>
 *
 * `alternativeApps` — ЛИШЕ масив назв (рядків), без описів і без кроків.
 */

export const MARK_NOT_FOUND = "NOT_FOUND";
export const MARK_INVALID = "INVALID_QUERY";
export const MARK_UNKNOWN = "Не визначено";

// Заголовок секції з повною статтею довідки. Емодзі не вимагаємо — раптом
// на бекенді його приберуть; тримаємось за текст.
const DOC_HEADING = /^\s*\*\*[^\n*]*Повна стаття довідки\s*\((.+)\)\s*:?\s*\*\*\s*$/m;

// Технічний тег, яким LLM позначає джерело. Движок прибирає його лише тоді,
// коли зміг зіставити номер із документом; в решті випадків тег доїжджає до нас.
const SOURCE_TAG = /\[\s*SOURCE_ID:\s*\d+\s*\]/gi;

/** Прибирає перший рядок виду **Назва програми**, який движок додає сам. */
function stripLeadingAppHeading(text, appName) {
  const trimmed = text.replace(/^\s+/, "");
  const first = trimmed.split("\n", 1)[0];
  const bold = first.match(/^\*\*(.+)\*\*\s*$/);
  if (bold && (!appName || bold[1].trim() === String(appName).trim())) {
    return trimmed.slice(first.length).replace(/^\s+/, "");
  }
  return trimmed;
}

/** Розділяє тіло відповіді на пояснення та повний текст статті довідки. */
function splitReasonAndSteps(body) {
  const match = body.match(DOC_HEADING);
  if (!match || match.index === undefined) {
    return { reason: body.trim(), steps: "", docTitle: "" };
  }
  return {
    reason: body.slice(0, match.index).trim(),
    steps: body.slice(match.index + match[0].length).trim(),
    docTitle: match[1].trim(),
  };
}

/** Прибирає дублі та маркери зі списку назв програм. */
function cleanAppList(list, exclude) {
  if (!Array.isArray(list)) return [];
  const skip = new Set([exclude, MARK_NOT_FOUND, MARK_INVALID, MARK_UNKNOWN].filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || skip.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * @param {object} result — сирий result методу `query`.
 * @returns {{kind: "match"|"empty"|"invalid"|"uncertain", appName: string,
 *            reason: string, steps: string, docTitle: string, message: string,
 *            alternatives: string[], contextApps: string[], elapsedMs: number}}
 */
export function normalizeAnswer(result) {
  const safe = result && typeof result === "object" ? result : {};
  const response = (typeof safe.response === "string" ? safe.response : "").replace(SOURCE_TAG, "");
  const recommended = typeof safe.recommendedApp === "string" ? safe.recommendedApp.trim() : "";
  const contextApps = cleanAppList(safe.contextApps, null);
  const elapsedMs = Number.isFinite(safe.executionTimeMs) ? safe.executionTimeMs : 0;

  const base = {
    appName: "",
    reason: "",
    steps: "",
    docTitle: "",
    message: response.trim(),
    alternatives: [],
    contextApps,
    elapsedMs,
  };

  if (!recommended || recommended === MARK_NOT_FOUND) {
    // Нічого не знайшлось. alternativeApps тут містив би «найкращі з поганих»
    // збігів — свідомо їх не показуємо як відповідь.
    return { ...base, kind: "empty" };
  }
  if (recommended === MARK_INVALID) {
    return { ...base, kind: "invalid" };
  }

  const body = stripLeadingAppHeading(response, recommended);
  const { reason, steps, docTitle } = splitReasonAndSteps(body);

  if (recommended === MARK_UNKNOWN) {
    // Движок не зміг зіставити відповідь LLM із документом (SOURCE_ID поза
    // межами списку). Показуємо текст, але не видаємо його за рекомендацію.
    return { ...base, kind: "uncertain", message: body.trim() || response.trim() };
  }

  return {
    ...base,
    kind: "match",
    appName: recommended,
    reason,
    steps,
    docTitle,
    message: "",
    alternatives: cleanAppList(safe.alternativeApps, recommended),
  };
}
