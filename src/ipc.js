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
export const jobCancel = (id) => rpc("job.cancel", { id });

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

/** Підписка на зміну стану з'єднання з sidecar. */
export const onStatus = (handler) =>
  listen("sidecar://status", (event) => handler(event.payload));
