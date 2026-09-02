/**
 * Читання статусу готовності моделей з відповіді `db.stats`.
 *
 * Бекенд саме зараз розширює `db.stats` (див. docs/improvements.md: «UI: немає
 * видимого статусу готовності моделей»), тому формат може відрізнятися від
 * очікуваного. Правило тут одне: читаємо ЗАХИЩЕНО і показуємо лише те, що
 * реально прийшло. Немає поля — пишемо «невідомо», а не вигадуємо нуль:
 * нуль означав би «нічого не векторизовано», і це була б брехня.
 *
 * Стара відповідь `{appsCount, chunksCount}` теж валідна — тоді секція просто
 * каже, що статусу моделей ще немає.
 */

/** Можливі назви контейнера зі списком моделей. Перший знайдений виграє. */
const CONTAINER_KEYS = ["models", "embedModels", "byModel", "vectorization", "perModel"];

/**
 * Псевдоніми полів усередині запису однієї моделі. Фактичний формат бекенда —
 * {model, column, columnExists, isCurrent, vectorizedApps, notVectorizedApps,
 *  ready, lancedb:{path, exists, sizeMb, ...}} — але читаємо ширше, бо формат
 * дописувався паралельно з панеллю.
 */
const NAME_KEYS = ["model", "name", "modelName", "embedModel", "id"];
const DONE_KEYS = ["vectorizedApps", "vectorized", "appsVectorized", "done", "count"];
const TOTAL_KEYS = ["total", "totalApps", "appsTotal", "appsCount", "of"];
const TABLE_KEYS = ["tableExists", "hasTable", "vectorTable", "lancedbExists", "exists"];
const CHUNK_KEYS = ["chunks", "chunksCount", "vectors", "rows"];

/** Перше поле з переліку, яке справді є в об'єкті (null не вважається значенням). */
function pick(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Число або undefined — рядок «12» теж приймаємо, бо SQLite іноді віддає рядки. */
function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Булеве значення лише тоді, коли воно справді булеве (або 0/1). */
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  return undefined;
}

/**
 * Один запис моделі. `entry` може бути об'єктом, числом (кількість чанків —
 * так віддає `perModel` у pipeline.fullSync) або рядком «done».
 */
function readEntry(name, entry, fallbackTotal) {
  const object = entry && typeof entry === "object" ? entry : null;

  const vectorized = toNumber(pick(object, DONE_KEYS));
  const total = toNumber(pick(object, TOTAL_KEYS)) ?? fallbackTotal;
  const chunks = object
    ? toNumber(pick(object, CHUNK_KEYS))
    : toNumber(entry); // perModel: {model: 1234}

  // Векторна база: або пласке поле, або вкладений об'єкт lancedb.
  const nested = object && object.lancedb && typeof object.lancedb === "object" ? object.lancedb : null;
  const tableExists = toBoolean(pick(object, TABLE_KEYS)) ?? toBoolean(pick(nested, TABLE_KEYS));
  const tableSize = nested ? nested.sizeMb : undefined;
  const tablePath = nested ? nested.path : undefined;
  const sourceTypes =
    nested && nested.sourceTypes && typeof nested.sourceTypes === "object"
      ? nested.sourceTypes
      : undefined;

  // Готовність, порахована самим бекендом. Є — довіряємо, немає — рахуємо самі.
  const explicitReady = object && typeof object.ready === "boolean" ? object.ready : undefined;

  return {
    name,
    vectorized,
    total,
    tableExists,
    tableSize,
    tablePath,
    sourceTypes,
    chunks,
    explicitReady,
    isCurrent: object && typeof object.isCurrent === "boolean" ? object.isCurrent : undefined,
    // Чи маємо взагалі про що говорити, крім назви.
    known: [vectorized, total, tableExists, chunks, explicitReady].some((value) => value !== undefined),
    raw: entry,
  };
}

/**
 * Готовність моделі:
 *   ready    — векторної бази немає сумнівів і векторизовано все, що є;
 *   partial  — щось зроблено, але не все;
 *   missing  — нічого не зроблено або бази немає;
 *   unknown  — бекенд не дав жодного числа.
 */
export function readiness(model) {
  // Векторної бази немає — модель непридатна, хай навіть прапорці в SQLite стоять
  // (docs/improvements.md: очистка lancedb не скидає vectorized_*).
  if (model.tableExists === false) return "missing";
  if (model.vectorized === undefined && model.chunks === undefined) {
    return model.explicitReady === true ? "ready" : "unknown";
  }
  if (model.explicitReady === true) return "ready";
  const done = model.vectorized ?? model.chunks ?? 0;
  if (done <= 0) return "missing";
  if (model.vectorized !== undefined && model.total !== undefined) {
    return model.vectorized >= model.total ? "ready" : "partial";
  }
  return model.tableExists === true ? "ready" : "unknown";
}

/**
 * Розбір відповіді db.stats.
 * Повертає {models, containerKey, appsCount, chunksCount, hasModelData}.
 * `containerKey` потрібен секції, щоб не дублювати ті самі дані ще й у
 * загальному списку полів.
 */
export function readModelStats(stats) {
  const empty = { models: [], containerKey: null, appsCount: undefined, chunksCount: undefined, hasModelData: false };
  if (!stats || typeof stats !== "object") return empty;

  const appsCount = toNumber(stats.appsCount);
  const chunksCount = toNumber(stats.chunksCount);

  let containerKey = null;
  let container;
  for (const key of CONTAINER_KEYS) {
    const value = stats[key];
    if (Array.isArray(value) ? value.length > 0 : value && typeof value === "object") {
      containerKey = key;
      container = value;
      break;
    }
  }
  if (!containerKey) return { ...empty, appsCount, chunksCount };

  const models = Array.isArray(container)
    ? container
        .map((entry) => {
          const name = pick(entry, NAME_KEYS);
          // Технічна колонка SQLite без назви моделі не є окремою векторною базою.
          if (!name) return null;
          return readEntry(String(name), entry, appsCount);
        })
        .filter(Boolean)
    : Object.entries(container).map(([name, entry]) => readEntry(name, entry, appsCount));

  return {
    models,
    containerKey,
    appsCount,
    chunksCount,
    hasModelData: models.length > 0,
  };
}
