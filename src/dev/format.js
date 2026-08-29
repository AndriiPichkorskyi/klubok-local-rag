/**
 * Дрібні форматери панелі розробника.
 * Логіка форматування часу повторює sidecar/src/cli/utils.js (formatExecutionTime),
 * щоб числа в панелі збігалися з тим, що друкує CLI.
 */

/** Час виконання: до секунди — мілісекунди, далі — секунди з двома знаками. */
export function formatExecutionTime(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Розмір файлу у звичних одиницях. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Час доби для журналу: 14:03:07. */
export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString("uk-UA", { hour12: false });
}

/** Дата й час зі звіту або з mtime файлу. */
export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("uk-UA");
}

/**
 * Текст помилки. Tauri віддає Err(String), тож у catch може прилетіти рядок,
 * а не Error — інакше повідомлення губиться і в інтерфейсі порожньо.
 */
export function errorText(error) {
  if (error == null) return "Невідома помилка.";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Ключі, значення яких не варто показувати відкритим текстом. */
const SECRET_KEYS = /^(token|secret|password|apikey|api_key)$/i;

/** Глибока копія об'єкта з маскуванням секретів (config.get віддає rpc.token). */
export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "••••••••" : maskSecrets(item);
    }
    return out;
  }
  return value;
}

/** Короткий підсумок результату методу для рядка журналу. */
export function summarizeResult(result) {
  if (result === undefined || result === null) return "готово";
  if (typeof result === "boolean") return result ? "true" : "false";
  if (typeof result !== "object") return String(result);

  // Вкладені об'єкти розгортаємо на один рівень. Раніше вони просто відкидались,
  // і найважливіше поле pipeline.fullSync — perModel, тобто «що сталося з кожною
  // моделлю» — ніколи не доходило до екрана. Саме через це користувач двічі
  // не міг зрозуміти, чому друга модель лишилась невекторизованою.
  const parts = [];
  for (const [key, item] of Object.entries(result)) {
    if (item === null || typeof item !== "object") {
      parts.push(`${key}=${item}`);
    } else if (Array.isArray(item)) {
      parts.push(`${key}=${formatArray(item)}`);
    } else {
      const inner = Object.entries(item).map(([k, v]) => `${k}: ${formatLeaf(v)}`);
      parts.push(`${key}={${inner.length === 0 ? "порожньо" : inner.join("; ")}}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "готово";
}

/**
 * Масив у рядок. Масив об'єктів НЕ склеюємо через join: він давав "[object Object]".
 * Якщо в елементів є впізнавана назва — показуємо перші кілька, інакше лише кількість.
 */
function formatArray(items) {
  if (items.length === 0) return "[порожньо]";
  if (items.every((item) => item === null || typeof item !== "object")) {
    return `[${items.join(", ")}]`;
  }
  const named = items
    .map((item) => item?.name ?? item?.id ?? item?.model ?? item?.title)
    .filter((value) => typeof value === "string");
  if (named.length === items.length) {
    const head = named.slice(0, 3).join(", ");
    return items.length > 3 ? `[${items.length}: ${head}, …]` : `[${head}]`;
  }
  return `[${items.length} елементів]`;
}

/** Значення другого рівня. Глибше не розгортаємо — це рядок статусу, не дамп. */
function formatLeaf(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : "{…}";
  return String(value);
}
