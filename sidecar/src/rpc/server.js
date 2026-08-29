/**
 * Файл: src/rpc/server.js
 * Опис: WebSocket RPC-сервер sidecar — точка входу backend.
 *       Реалізує протокол з docs/contracts/rpc.md: auth-фрейм, запити,
 *       повідомлення progress і рівно одну фінальну відповідь на кожен id.
 *
 * Sidecar не знає про Tauri: запускається окремо (`npm run rpc:dev`) і
 * приймає будь-якого WebSocket-клієнта на localhost.
 *
 * Діагностика. Усе, що тут відбувається, паралельно лягає у файловий журнал
 * `sidecar/logs/sidecar.N.log` (див. services/logger.service.js): старт із
 * версією Node і межами пам'яті, початок і кінець кожного виклику з
 * тривалістю, розриви з'єднань, зрізи пам'яті і причина завершення процесу.
 * Раніше все це жило лише в stdout і зникало разом зі скролом термінала —
 * через що смерть sidecar 26.08 лишилась нерозгаданою.
 */

import { WebSocketServer } from "ws";
import { config } from "../config/config.js";
import { db } from "../services/db.service.js";
import { logger } from "../services/logger.service.js";
import { methods, jobs } from "./methods.js";

/** Коди закриття з'єднання (4000+ — застосункові, за RFC 6455). */
const CLOSE_AUTH_REQUIRED = 4001;
const CLOSE_BAD_TOKEN = 4003;

/** Автентифіковані сокети — через них ідуть попередження про пам'ять. */
const clients = new Set();

/** Безпечно відправляє JSON-об'єкт, якщо сокет ще живий. */
function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.error("[rpc] Не вдалося відправити повідомлення:", error.message);
    logger.event("warn", "rpc.send.error", { error: error.message }, "Не вдалося відправити кадр");
  }
}

/**
 * Чи є помилка наслідком скасування (AbortController).
 * Скасування — намір користувача, а не збій, тому такий випадок ніколи
 * не має доїжджати до клієнта у вигляді кадру `error`.
 */
function isAbortError(error) {
  if (!error) return false;
  return (
    error.name === "AbortError" ||
    error.code === "ABORT_ERR" ||
    error.code === "ERR_CANCELED" ||
    error.name === "CanceledError"
  );
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
    logger.event(
      "warn",
      "rpc.bad_request",
      { reason: "id не ціле число", method },
      "Некоректний запит",
    );
    send(ws, { id: null, error: { message: "Поле `id` мусить бути цілим числом.", stack: null } });
    return;
  }
  if (jobs.has(id)) {
    logger.event("warn", "rpc.duplicate_id", { id, method }, `Запит з id=${id} уже виконується`);
    send(ws, { id, error: { message: `Запит з id=${id} уже виконується.`, stack: null } });
    return;
  }

  const handler = methods[method];
  if (typeof handler !== "function") {
    logger.event("warn", "rpc.unknown_method", { id, method }, `Невідомий метод «${method}»`);
    send(ws, { id, error: { message: `Невідомий метод «${method}».`, stack: null } });
    return;
  }

  // Один AbortController на активний id — його смикає job.cancel.
  const controller = new AbortController();
  const job = { id, method, startedAt: Date.now(), cancelled: false, controller };
  jobs.set(id, job);

  // Ключі params, а не значення: у журналі не місце текстам запитів користувача,
  // але знати, з чим саме викликали метод, необхідно.
  logger.event(
    "info",
    "rpc.call.start",
    { id, method, paramKeys: Object.keys(params || {}), memory: logger.memorySnapshot() },
    `Початок виклику ${method} (id=${id})`,
  );

  // Контекст методу: прогрес — це існуючий колбек onProgress пайплайна,
  // signal — сигнал скасування для довгих операцій.
  const ctx = {
    id,
    job,
    signal: controller.signal,
    onProgress(msg, pct = null) {
      send(ws, { type: "progress", id, msg: String(msg), pct: pct ?? null });
    },
  };

  try {
    // Довгі методи не блокують сервер: обробник асинхронний, цикл подій
    // лишається вільним, тому ping відповідає навіть під час векторизації.
    const result = await handler(params || {}, ctx);
    logger.event(
      "info",
      "rpc.call.end",
      {
        id,
        method,
        status: "ok",
        durationMs: Date.now() - job.startedAt,
        memory: logger.memorySnapshot(),
      },
      `Кінець виклику ${method} (id=${id})`,
    );
    send(ws, { id, result: result === undefined ? null : result });
  } catch (error) {
    // Скасована задача завершується результатом зі станом «скасовано»:
    // в інтерфейсі це не червона помилка, а свідома дія користувача.
    if (job.cancelled && isAbortError(error)) {
      console.log(`[rpc] Метод ${method} (id=${id}) скасовано користувачем.`);
      logger.event(
        "info",
        "rpc.call.end",
        { id, method, status: "cancelled", durationMs: Date.now() - job.startedAt },
        `Виклик ${method} (id=${id}) скасовано користувачем`,
      );
      send(ws, {
        id,
        result: {
          cancelled: true,
          method,
          reason: "Скасовано користувачем через job.cancel.",
          durationMs: Date.now() - job.startedAt,
        },
      });
    } else {
      console.error(`[rpc] Помилка методу ${method} (id=${id}):`, error?.message || error);
      logger.event(
        "error",
        "rpc.call.end",
        {
          id,
          method,
          status: "error",
          durationMs: Date.now() - job.startedAt,
          error: toErrorPayload(error),
          memory: logger.memorySnapshot(),
        },
        `Помилка методу ${method} (id=${id}): ${error?.message || error}`,
      );
      send(ws, { id, error: toErrorPayload(error) });
    }
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
      logger.event(
        "warn",
        "rpc.auth.failed",
        { reason: "перший кадр не JSON" },
        "Розрив: очікувався auth-фрейм",
      );
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
      logger.event(
        "warn",
        "rpc.auth.failed",
        { reason: "перший кадр не auth" },
        "Розрив: перший кадр не auth",
      );
      ws.close(CLOSE_AUTH_REQUIRED, "Перший фрейм мусить бути auth");
      return;
    }
    if (message.token !== config.rpc.token) {
      console.warn("[rpc] Невірний токен — закриваємо з'єднання.");
      logger.event(
        "warn",
        "rpc.auth.failed",
        { reason: "невірний токен" },
        "Розрив: невірний токен",
      );
      ws.close(CLOSE_BAD_TOKEN, "Невірний токен");
      return;
    }
    state.authed = true;
    clients.add(ws);
    console.log("[rpc] Клієнт автентифікований.");
    logger.event("info", "rpc.auth.ok", { peer: state.peer }, "Клієнт автентифікований");
    send(ws, { type: "auth", ok: true });
    return;
  }

  // Після auth усе інше — це запити. Промахи не валять з'єднання.
  handleRequest(ws, message).catch((error) => {
    console.error("[rpc] Непередбачена помилка диспетчера:", error);
    logger.event(
      "error",
      "rpc.dispatcher.error",
      { error: toErrorPayload(error) },
      "Непередбачена помилка диспетчера",
    );
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
  console.log(`  Журнал:   ${logger.currentLogPath}`);
  console.log("──────────────────────────────────────────────");
  logger.event(
    "info",
    "rpc.listening",
    { host, port, methods: Object.keys(methods).length, embedModel: config.embedModelName },
    `RPC-сервер слухає ws://${host}:${port}`,
  );
}

async function main() {
  // Журнал піднімаємо ПЕРШИМ: якщо процес помре вже на db.init(), у файлі
  // все одно лишиться рядок про старт і про те, де саме він застряг.
  await logger.init();
  logger.installProcessHandlers({ role: "rpc" });
  logger.logProcessStart({
    role: "rpc",
    rpcPort: config.rpc.port,
    embedModel: config.embedModelName,
  });

  // Пульс має бачити, що саме виконувалось у мить смерті процесу.
  logger.setInflightProvider(() =>
    [...jobs.values()].map((job) => ({
      id: job.id,
      method: job.method,
      runningMs: Date.now() - job.startedAt,
      cancelled: job.cancelled,
    })),
  );
  logger.startMemoryWatch();

  // Попередження про пам'ять доїжджає в інтерфейс як звичайний прогрес
  // активної задачі — щоб людина побачила його ДО падіння, а не після.
  logger.onMemoryWarning((text) => {
    for (const job of jobs.values()) {
      for (const ws of clients) send(ws, { type: "progress", id: job.id, msg: text, pct: null });
    }
  });

  logger.event("info", "db.init.start", {}, "Ініціалізація баз даних");
  await db.init();
  logger.event("info", "db.init.done", { memory: logger.memorySnapshot() }, "Бази даних готові");

  const wss = new WebSocketServer({ host: config.rpc.host, port: config.rpc.port });

  wss.on("connection", (ws, req) => {
    const peer = req.socket.remoteAddress;
    const state = { authed: false, peer };
    console.log(`[rpc] Нове з'єднання з ${peer}`);
    logger.event("info", "rpc.connection.open", { peer }, `Нове з'єднання з ${peer}`);

    ws.on("message", (raw) => {
      try {
        handleMessage(ws, state, raw);
      } catch (error) {
        console.error("[rpc] Помилка обробки повідомлення:", error);
        logger.event(
          "error",
          "rpc.message.error",
          { error: toErrorPayload(error) },
          "Помилка обробки повідомлення",
        );
      }
    });
    ws.on("error", (error) => {
      console.error("[rpc] Помилка сокета:", error.message);
      logger.event(
        "error",
        "rpc.socket.error",
        { peer, error: error.message },
        `Помилка сокета: ${error.message}`,
      );
    });
    ws.on("close", (code, reason) => {
      clients.delete(ws);
      console.log(`[rpc] З'єднання закрито (код ${code}).`);
      logger.event(
        "info",
        "rpc.connection.close",
        { peer, code, reason: reason?.toString?.() || "", activeJobs: jobs.size },
        `З'єднання закрито (код ${code})`,
      );
    });
  });

  wss.on("error", (error) => {
    console.error("[rpc] Помилка сервера:", error.message);
    logger.event(
      "error",
      "rpc.server.error",
      { error: error.message },
      `Помилка сервера: ${error.message}`,
    );
  });
  wss.on("listening", printStartupBanner);

  const shutdown = () => {
    console.log("\n[rpc] Зупинка сервера...");
    logger.event(
      "info",
      "rpc.shutdown",
      { activeJobs: jobs.size, inflight: logger._inflight() },
      "Зупинка сервера",
    );
    logger.stopMemoryWatch();
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Процес не має падати ніколи: логуємо і працюємо далі.
// Самі обробники uncaughtException/unhandledRejection ставить
// logger.installProcessHandlers() — там вони ще й пишуть у файл разом зі
// списком того, що виконувалось у цю мить.

main().catch(async (error) => {
  console.error("[rpc] Критична помилка старту:", error);
  try {
    await logger.init();
    logger.event(
      "fatal",
      "rpc.start.failed",
      { error: toErrorPayload(error) },
      `Критична помилка старту: ${error?.message}`,
    );
    logger.flush();
  } catch {
    /* якщо не вдалось навіть це — лишається stdout */
  }
  process.exit(1);
});
