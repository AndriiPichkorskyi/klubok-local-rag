/**
 * Передача запиту сесії у вікно підказки.
 *
 * Вікно підказки — окрема сторінка (overlay.html), яку відкриває Rust командою
 * `overlay_show({})`. Параметрів вона за контрактом не приймає, тож що саме
 * показувати, вікно дізнається саме:
 *   1) з рядка запиту (?appId=…&goal=…) — якщо колись Rust почне його додавати;
 *   2) з localStorage — його поділяють вікна одного походження.
 * Обидва шляхи читаються однаково, тому вікно працює й тоді, і тоді.
 */

const KEY = "walkthrough.request";

/** Безпечний доступ: у вікні без сховища (або з вимкненим) не падаємо. */
function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const clean = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");

/** docId у базі — число (рядок web_documents), але з URL він приходить рядком. */
function cleanDocId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = clean(value);
  if (!text) return null;
  return /^\d+$/.test(text) ? Number(text) : text;
}

/** Нормалізує запит: без appId сесії не буває. */
export function normalizeRequest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const appId = clean(raw.appId);
  if (!appId) return null;
  return {
    appId,
    appName: clean(raw.appName) || appId,
    goal: clean(raw.goal),
    docId: cleanDocId(raw.docId),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

/** Кладе запит туди, звідки його візьме вікно підказки. */
export function putRequest(raw) {
  const request = normalizeRequest(raw);
  if (!request) return null;
  const store = storage();
  try {
    store?.setItem(KEY, JSON.stringify(request));
  } catch {
    /* сховище недоступне — лишається шлях через рядок запиту */
  }
  return request;
}

/** Читає запит: спершу рядок запиту вікна, потім сховище. */
export function readRequest(search = typeof location === "undefined" ? "" : location.search) {
  try {
    const params = new URLSearchParams(search || "");
    const fromUrl = normalizeRequest({
      appId: params.get("appId"),
      appName: params.get("appName"),
      goal: params.get("goal"),
      docId: params.get("docId"),
    });
    if (fromUrl) return fromUrl;
  } catch {
    /* поламаний рядок запиту не має ламати вікно */
  }
  const store = storage();
  try {
    const raw = store?.getItem(KEY);
    return raw ? normalizeRequest(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearRequest() {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* нема чого чистити */
  }
}

export const REQUEST_KEY = KEY;
