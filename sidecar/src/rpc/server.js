/**
 * Файл: src/rpc/server.js
 * Опис: WebSocket RPC-сервер sidecar — точка входу backend.
 *       Реалізує протокол з docs/contracts/rpc.md: auth-фрейм, запити,
 *       повідомлення progress і рівно одну фінальну відповідь на кожен id.
 *
 * Sidecar не знає про Tauri: запускається окремо (`npm run rpc:dev`) і
 * приймає будь-якого WebSocket-клієнта на localhost.
 */

import { WebSocketServer } from "ws";
import { config } from "../config/config.js";
import { db } from "../services/db.service.js";
import { methods, jobs } from "./methods.js";

/** Коди закриття з'єднання (4000+ — застосункові, за RFC 6455). */
const CLOSE_AUTH_REQUIRED = 4001;
const CLOSE_BAD_TOKEN = 4003;

/** Безпечно відправляє JSON-об'єкт, якщо сокет ще живий. */
function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error("[rpc] Не вдалося відправити повідомлення:", error.message);
  }
}

/** Приводить будь-яку помилку до форми {message, stack} з контракту. */
function toErrorPayload(error) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error), stack: null };
}

/**
 * Виконує один запит. Ніколи не кидає назовні: будь-яка помилка
 * перетворюється на {id, error} — процес падати не має права.
 */
async function handleRequest(ws, request) {
  const { id, method, params } = request;

  if (!Number.isInteger(id)) {
    send(ws, { id: null, error: { message: "Поле `id` мусить бути цілим числом.", stack: null } });
    return;
  }
  if (jobs.has(id)) {
    send(ws, { id, error: { message: `Запит з id=${id} уже виконується.`, stack: null } });
    return;
  }

  const handler = methods[method];
  if (typeof handler !== "function") {
    send(ws, { id, error: { message: `Невідомий метод «${method}».`, stack: null } });
    return;
  }

  const job = { id, method, startedAt: Date.now(), cancelled: false };
  jobs.set(id, job);

  // Контекст методу: прогрес — це існуючий колбек onProgress пайплайна.
  const ctx = {
    id,
    job,
    onProgress(msg, pct = null) {
      send(ws, { type: "progress", id, msg: String(msg), pct: pct ?? null });
    },
  };

  try {
    // Довгі методи не блокують сервер: обробник асинхронний, цикл подій
    // лишається вільним, тому ping відповідає навіть під час векторизації.
    const result = await handler(params || {}, ctx);
    send(ws, { id, result: result === undefined ? null : result });
  } catch (error) {
    console.error(`[rpc] Помилка методу ${method} (id=${id}):`, error?.message || error);
    send(ws, { id, error: toErrorPayload(error) });
  } finally {
    jobs.delete(id);
  }
}

/** Обробка вхідного фрейму з урахуванням стану автентифікації. */
function handleMessage(ws, state, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    if (!state.authed) {
      ws.close(CLOSE_AUTH_REQUIRED, "Очікувався auth-фрейм");
      return;
    }
    send(ws, { id: null, error: { message: "Повідомлення не є валідним JSON.", stack: null } });
    return;
  }

  if (!message || typeof message !== "object") {
    send(ws, { id: null, error: { message: "Повідомлення мусить бути об'єктом.", stack: null } });
    return;
  }

  // Перший фрейм від клієнта — обов'язково auth.
  if (!state.authed) {
    if (message.type !== "auth") {
      console.warn("[rpc] Перший фрейм не auth — закриваємо з'єднання.");
      ws.close(CLOSE_AUTH_REQUIRED, "Перший фрейм мусить бути auth");
      return;
    }
    if (message.token !== config.rpc.token) {
      console.warn("[rpc] Невірний токен — закриваємо з'єднання.");
      ws.close(CLOSE_BAD_TOKEN, "Невірний токен");
      return;
    }
    state.authed = true;
    console.log("[rpc] Клієнт автентифікований.");
    send(ws, { type: "auth", ok: true });
    return;
  }

  // Після auth усе інше — це запити. Промахи не валять з'єднання.
  handleRequest(ws, message).catch((error) => {
    console.error("[rpc] Непередбачена помилка диспетчера:", error);
  });
}

/** Друкує розробнику, що і де слухає. */
function printStartupBanner() {
  const { host, port } = config.rpc;
  console.log("──────────────────────────────────────────────");
  console.log(" Sidecar RPC-сервер запущено");
  console.log(`  Адреса:   ws://${host}:${port}`);
  console.log(`  Порт:     ${port}`);
  console.log(`  Конфіг:   ${config.paths.configPath}`);
  console.log(`  SQLite:   ${config.db.sqlitePath}`);
  console.log(`  LanceDB:  ${config.db.lancedbPath}`);
  console.log(`  Модель:   ${config.embedModelName}`);
  console.log(`  Методів:  ${Object.keys(methods).length}`);
  console.log("──────────────────────────────────────────────");
}

async function main() {
  // Бази ініціалізуємо один раз при старті, як це робить CLI.
  await db.init();

  const wss = new WebSocketServer({ host: config.rpc.host, port: config.rpc.port });

  wss.on("connection", (ws, req) => {
    const state = { authed: false };
    console.log(`[rpc] Нове з'єднання з ${req.socket.remoteAddress}`);

    ws.on("message", (raw) => {
      try {
        handleMessage(ws, state, raw);
      } catch (error) {
        console.error("[rpc] Помилка обробки повідомлення:", error);
      }
    });
    ws.on("error", (error) => console.error("[rpc] Помилка сокета:", error.message));
    ws.on("close", (code) => console.log(`[rpc] З'єднання закрито (код ${code}).`));
  });

  wss.on("error", (error) => console.error("[rpc] Помилка сервера:", error.message));
  wss.on("listening", printStartupBanner);

  const shutdown = () => {
    console.log("\n[rpc] Зупинка сервера...");
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Процес не має падати ніколи: логуємо і працюємо далі.
process.on("uncaughtException", (error) => {
  console.error("[rpc] uncaughtException:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[rpc] unhandledRejection:", reason);
});

main().catch((error) => {
  console.error("[rpc] Критична помилка старту:", error);
  process.exit(1);
});
