/**
 * Сирі дані кроку — те, що показує режим розробника у вікні підказки.
 *
 * Блок діагностики віддає бекенд (`config.walkthrough.debug`), і форма його
 * полів ще усталюється. Тому тут не одна назва на поле, а список синонімів:
 * коли sidecar назве поле інакше, вікно все одно покаже значення, а не порожньо.
 * Чого немає — того немає: вигадувати замінники не можна, це інструмент
 * налагодження, а не вітрина.
 *
 * Уся логіка файлу — чисті функції: їх видно в тестах без DOM.
 */

/** Де шукати сам блок діагностики у відповіді `walkthrough.step`. */
const DEBUG_KEYS = ["debug", "diagnostics", "diag"];

/** Синоніми полів блока. Перше знайдене виграє. */
const ALIASES = {
  raw: ["raw", "rawResponse", "rawText", "rawAnswer", "modelRaw", "completion", "response"],
  prompt: ["prompt", "visionPrompt", "promptText", "userPrompt", "request"],
  system: ["system", "systemPrompt"],
  model: ["model", "visionModel", "modelName"],
  imagePath: ["imagePath", "screenshotPath", "framePath", "path"],
  imageBytes: ["imageBytes", "bytes", "imageSize", "fileSize", "size"],
  sentWidth: ["sentWidth", "imageWidth", "width"],
  sentHeight: ["sentHeight", "imageHeight", "height"],
  durationMs: ["durationMs", "elapsedMs", "tookMs", "visionMs", "latencyMs"],
  stateSource: ["stateSource", "stateFrom", "stateOrigin", "decidedBy", "stateBy"],
  dropped: ["dropped", "rejected", "sanitized", "discarded", "ignored", "sanitizer"],
  sessionVisionCalls: ["sessionVisionCalls", "visionCallsTotal", "totalVisionCalls"],
};

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Блок діагностики з відповіді кроку або null, якщо бекенд його не прислав. */
export function debugBlock(step) {
  if (!isObject(step)) return null;
  for (const key of DEBUG_KEYS) {
    if (isObject(step[key])) return step[key];
  }
  return null;
}

/** Значення поля за списком синонімів. undefined = поля немає в жодному вигляді. */
export function pick(block, field) {
  if (!isObject(block)) return undefined;
  for (const name of ALIASES[field] || [field]) {
    const value = block[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** «1,2 МБ» — кома, бо інтерфейс український. */
export function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} Б`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0).replace(".", ",")} КБ`;
  return `${(kb / 1024).toFixed(1).replace(".", ",")} МБ`;
}

/** «12,3 с» для довгого і «840 мс» для короткого: секунди тут читабельніші. */
export function formatMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  return n < 1000 ? `${Math.round(n)} мс` : `${(n / 1000).toFixed(1).replace(".", ",")} с`;
}

/** Розмір кадру словами: «2880×1864 → 1280×828». */
export function formatFrame(capture, block) {
  const shot = isObject(capture) ? capture : {};
  const parts = [];
  if (Number.isFinite(shot.widthPx) && Number.isFinite(shot.heightPx)) {
    parts.push(`${shot.widthPx}×${shot.heightPx}`);
  }
  const sw = Number(pick(block, "sentWidth"));
  const sh = Number(pick(block, "sentHeight"));
  if (Number.isFinite(sw) && Number.isFinite(sh) && sw > 0 && sh > 0) parts.push(`${sw}×${sh}`);
  return parts.join(" → ");
}

/** Людські назви для значень `stateSource` від бекенда. */
const ORIGIN_TEXT = {
  frontmost: "детерміновано з frontmost (ОС)",
  os: "детерміновано з frontmost (ОС)",
  deterministic: "детерміновано з frontmost (ОС)",
  vision: "зором (vision-модель)",
  model: "зором (vision-модель)",
  plan: "з плану документації",
  fallback: "запасним шляхом, без зору",
};

/**
 * Як визначено стан кроку. Контракт вимагає, щоб `wrong_window` і
 * `app_not_started` бекенд виставляв сам із `frontmost`, а не питав зір, — тож
 * це перше, що автор має бачити. Коли бекенд мовчить, чесно кажемо, що це
 * здогад інтерфейсу, а не його відповідь.
 */
export function describeStateOrigin(entry) {
  const said = pick(entry?.debug, "stateSource");
  if (typeof said === "string" && said.trim()) {
    const key = said.trim().toLowerCase();
    return { text: ORIGIN_TEXT[key] || said.trim(), sure: true };
  }
  const state = entry?.step?.state;
  if (state === "wrong_window" || state === "app_not_started") {
    return {
      text: entry?.frontmostSent
        ? "схоже, детерміновано з frontmost — бекенд не сказав прямо"
        : "невідомо: frontmost не надсилався",
      sure: false,
    };
  }
  if (entry?.step?.source === "plan") return { text: "з плану документації (source: plan)", sure: false };
  if (entry?.step?.source === "vision") return { text: "зором (source: vision)", sure: false };
  return { text: "бекенд не повідомив", sure: false };
}

/** «що відкинула санітарія» — може прийти рядком, масивом або об'єктом. */
export function formatDropped(block) {
  const value = pick(block, "dropped");
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("\n");
  }
  return JSON.stringify(value, null, 2);
}

let counter = 0;

/**
 * Один запис історії. Збирається на КОЖНОМУ кроці — і на вдалому, і на
 * невдалому: сесія, що впала на третьому кроці, розповідає більше за успішну.
 */
export function buildEntry({
  method = "walkthrough.step",
  step = null,
  capture = null,
  frontmost = null,
  frontmostSent = false,
  activation = null,
  clientMs = 0,
  activationDelayMs = null,
  error = null,
} = {}) {
  counter += 1;
  return {
    id: counter,
    at: Date.now(),
    method,
    step,
    capture,
    frontmost,
    frontmostSent,
    activation,
    clientMs,
    activationDelayMs,
    error,
    debug: debugBlock(step),
  };
}

/** Скидання лічильника — потрібне лише тестам, щоб id були передбачувані. */
export function resetCounter() {
  counter = 0;
}

/** Рядки «поле → значення» для щільної таблиці панелі. Порожні поля не показуємо. */
export function entryRows(entry) {
  if (!entry) return [];
  const block = entry.debug;
  const shot = isObject(entry.capture) ? entry.capture : {};
  const origin = describeStateOrigin(entry);
  const rows = [
    ["метод", entry.method],
    ["стан", entry.step?.state ?? "—"],
    ["як визначено стан", origin.sure ? origin.text : `${origin.text} (здогад вікна)`],
    ["source", entry.step?.source ?? ""],
    ["режим кроків", entry.step?.stepSource ?? ""],
    ["просування", progressText(entry)],
    // Скільки разів поспіль модель дає ту саму інструкцію. «1» — вперше, і
    // рядок не показуємо; від «2» це вже глухий кут, і його треба бачити.
    [
      "повтор інструкції",
      Number(entry.step?.repeated) > 1 ? `${entry.step.repeated}-й раз поспіль` : "",
    ],
    ["викликів зору за сесію", numberText(pick(block, "sessionVisionCalls"))],
    ["крок", Number.isFinite(entry.step?.stepIndex) ? String(entry.step.stepIndex) : ""],
    ["попереду була", entry.frontmost ? `${entry.frontmost.name || "?"} (${entry.frontmost.bundleId || "?"})` : "не питали"],
    ["frontmost надіслано", entry.frontmostSent ? "так" : "ні"],
    ["активація перед кадром", activationText(entry)],
    ["кадр", formatFrame(entry.capture, block)],
    ["шлях кадру", pick(block, "imagePath") || shot.path || ""],
    ["розмір файлу", formatBytes(pick(block, "imageBytes"))],
    ["режим знімка", shot.mode ? `${shot.mode}${shot.requestedMode && shot.requestedMode !== shot.mode ? ` (просили ${shot.requestedMode})` : ""}` : ""],
    ["тривалість, бекенд", formatMs(pick(block, "durationMs") ?? entry.step?.elapsedMs)],
    ["тривалість, вікно", formatMs(entry.clientMs)],
    ["модель", pick(block, "model") || ""],
    ["помилка", entry.error?.title ? `${entry.error.title}: ${entry.error.detail || entry.error.hint || ""}` : ""],
  ];
  return rows.filter(([, value]) => typeof value === "string" && value.trim() !== "");
}

/**
 * Просування вперед словами: на чию відповідь воно спиралось.
 *
 * Це головне питання цієї правки: раніше лічильник зсувався сам собою, і сесія
 * могла шість разів поспіль показати ту саму інструкцію. Тепер видно, хто саме
 * сказав «попередній крок виконано» — модель, людина, чи ніхто.
 */
function progressText(entry) {
  const progress = entry?.step?.progress;
  if (!progress || typeof progress !== "object") return "";
  const by = { vision: "за відповіддю моделі", user: "за словом користувача", none: "ніхто не питав" };
  const said =
    progress.done === true ? "попередній крок виконано" :
    progress.done === false ? "попередній крок НЕ виконано" :
    "про попередній крок невідомо";
  const note = typeof progress.note === "string" && progress.note ? ` — ${progress.note}` : "";
  return `${said} (${by[progress.by] || progress.by || "?"})${note}`;
}

/** Число як рядок; нуль теж показуємо — саме він і цікавий у ручному режимі. */
function numberText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
}

/** Рядок про активацію цільової програми перед знімком. */
function activationText(entry) {
  const act = entry?.activation;
  if (!act) return "";
  const delay = Number.isFinite(entry.activationDelayMs) ? `, пауза ${entry.activationDelayMs} мс` : "";
  if (act.ok === false) return `не вдалася: ${act.error || "без пояснення"}${delay}`;
  const what = act.alreadyRunning ? "виведено наперед" : "запущено";
  return `${what} «${act.appId || "?"}»${act.pid ? `, pid ${act.pid}` : ""}${delay}`;
}

/** Весь запис у JSON — те, що кладеться в буфер обміну кнопкою «Копіювати». */
export function entryJson(entry) {
  return JSON.stringify(entry, null, 2);
}

export function historyJson(history) {
  return JSON.stringify(Array.isArray(history) ? history : [], null, 2);
}
