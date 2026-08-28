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
  const parts = Object.entries(result)
    .filter(([, item]) => item === null || typeof item !== "object")
    .map(([key, item]) => `${key}=${item}`);
  return parts.length > 0 ? parts.join(", ") : "готово";
}
