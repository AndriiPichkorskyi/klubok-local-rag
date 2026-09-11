// Єдине місце, де фронтенд говорить з Rust. Компоненти не викликають invoke напряму.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Виклик будь-якого методу sidecar за контрактом docs/contracts/rpc.md.
 * Повертає `result`; у разі `error` кидає Error з повідомленням від Node.
 */
export function rpc(method, params = {}, clientRef = null) {
  return invoke("rpc_call", { method, params, clientRef });
}

/** Унікальна мітка виклику. Повертається в подіях прогресу як поле `ref`. */
let refCounter = 0;
export const newRef = (prefix = "op") => `${prefix}-${++refCounter}-${Date.now()}`;

// Іменовані обгортки для методів, якими користуємось найчастіше.
export const ping = () => rpc("ping");
export const bootstrapCheck = () => rpc("bootstrap.check");
export const configGet = () => rpc("config.get");
export const query = (text, options = {}, clientRef = null) =>
  rpc("query", { text, ...options }, clientRef);
export const dbStats = () => rpc("db.stats");
export const catalogApps = (params = {}) => rpc("catalog.apps", params);
export const catalogGuides = (params = {}) => rpc("catalog.guides", params);
export const catalogGuide = (id) => rpc("catalog.guide", { id });
export const catalogAppIcons = (paths) => rpc("catalog.appIcons", { paths });
export const jobCancel = (id) => rpc("job.cancel", { id });
export const testsPause = (id) => rpc("tests.pause", { id });
export const testsResume = (id, concurrency) =>
  rpc("tests.resume", concurrency == null ? { id } : { id, concurrency });

// Керування самим мостом.
export const sidecarStatus = () => invoke("sidecar_status");
export const sidecarRestart = () => invoke("sidecar_restart");

/**
 * Підписка на прогрес довгих операцій: {type:"progress", id, msg, pct, ref}.
 * Поле `ref` — мітка, передана у виклик rpc(). Фільтруй прогрес саме за нею,
 * а не за id: id генерує Rust, і фронтенд його не знає.
 * Повертає проміс з функцією відписки — виклич її в cleanup useEffect.
 */
export const onProgress = (handler) =>
  listen("sidecar://progress", (event) => handler(event.payload));

/**
 * Локальна шина «конфіг змінили».
 *
 * Панель розробника і вікно пошуку живуть в ОДНОМУ вікні, але нічого одне про
 * одного не знають. Коли в панелі перемикають модель чи режим пошуку, ворота
 * готовності мусять перевірити стан заново — інакше налаштування застосовується
 * лише після перезапуску вікна, а це не те, чого людина очікує від перемикача.
 *
 * Вікно walkthrough — окреме вікно ОС, і подія до нього не доходить; йому це й
 * не потрібно: воно читає конфіг через бекенд на кожну сесію.
 */
const CONFIG_CHANGED = "klubok:config-changed";

export const notifyConfigChanged = () => {
  window.dispatchEvent(new CustomEvent(CONFIG_CHANGED));
};

export const onConfigChanged = (handler) => {
  window.addEventListener(CONFIG_CHANGED, handler);
  return () => window.removeEventListener(CONFIG_CHANGED, handler);
};

/** Підписка на зміну стану з'єднання з sidecar. */
export const onStatus = (handler) =>
  listen("sidecar://status", (event) => handler(event.payload));
