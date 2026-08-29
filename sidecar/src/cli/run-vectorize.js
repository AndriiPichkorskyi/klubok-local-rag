import { runVectorize, runVectorizeIntents } from "../modules/indexer/pipeline.js";
import { config } from "../config/config.js";
import { db } from "../services/db.service.js";
import * as p from "@clack/prompts";
import pc from "picocolors";

/** Інтервал між рядками прогресу, коли вивід іде в трубу, а не в термінал. */
const PIPED_PROGRESS_INTERVAL_MS = 2000;

/**
 * Обирає спосіб звітування за тим, куди дивиться stdout.
 * TTY — живий спінер @clack; труба — рідкісні звичайні рядки без ANSI.
 */
function createReporter(isTty) {
  if (isTty) {
    const spinner = p.spinner();
    return {
      start: (msg) => spinner.start(pc.cyan(msg)),
      message: (msg) => spinner.message(msg),
      stop: (msg) => spinner.stop(msg),
    };
  }
  let lastPrintedAt = 0;
  return {
    start: (msg) => console.log(msg),
    message: (msg) => {
      const now = Date.now();
      if (now - lastPrintedAt < PIPED_PROGRESS_INTERVAL_MS) return;
      lastPrintedAt = now;
      console.log(msg);
    },
    stop: (msg) => console.log(msg),
  };
}

async function main() {
  await db.init();

  // Процес запускають і з термінала, і з RPC-сервера (pipeline.fullSync для
  // «чужої» моделі). Скасування зверху приходить сигналом SIGTERM, тому
  // перетворюємо його на AbortSignal: цикл виходить чисто, а не гине посеред
  // запису в базу. Без цього процес переживав би скасування — спінер @clack
  // ставить власний обробник SIGTERM і поглинає його.
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Отримано сигнал зупинки."));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // Спінер @clack перемальовує рядок керуючими послідовностями ANSI і крутить
  // кадри ◒◐◓◑ приблизно 12 разів на секунду. У терміналі це доречно, але коли
  // процес запущено з pipeline.fullSync, його stdout — труба, і кожен кадр
  // перетворюється на окреме RPC-повідомлення. За багатогодинну векторизацію це
  // сотні тисяч подій, які засмічують журнал і дарма навантажують інтерфейс.
  // Тому інтерактивний спінер лише для справжнього термінала.
  const s = createReporter(process.stdout.isTTY);
  s.start(`Векторизація для моделі: ${config.embedModelName}`);
  
  try {
    // Один замок на весь скрипт: між векторизацією документації і намірами
    // нікому не можна вклинитися в ту саму LanceDB-таблицю і chunks_fts.
    // Якщо процес запущено з pipeline.fullSync, замок уже тримає батько —
    // тоді цей виклик успадкує його, а не візьме другий.
    const intents = await db.withWriteLock("cli/run-vectorize.js", async () => {
      await runVectorize(msg => s.message(msg), controller.signal);
      // Наміри належать моделі так само, як і документація: у цього процесу
      // власна LanceDB-таблиця, і без цього виклику вона лишалась би без
      // INTENT-чанків, а Document Expansion працював би лише для однієї моделі.
      return await runVectorizeIntents(msg => s.message(msg), controller.signal);
    });
    if (controller.signal.aborted) {
      s.stop(`⏹ Скасовано векторизацію для: ${config.embedModelName}`);
      return;
    }
    s.stop(`✅ Завершено векторизацію для: ${config.embedModelName} (наміри: ${intents})`);
  } catch (err) {
    // Зайнята база — не збій скрипта, а зрозуміла відмова: показуємо саме
    // повідомлення, без стека, і виходимо окремим кодом.
    if (err && err.code === "PIPELINE_LOCKED") {
      s.stop(`⛔ Базу зараз змінює інший процес`);
      console.error(pc.yellow(err.message));
      process.exit(2);
    }
    s.stop(`❌ Помилка векторизації для: ${config.embedModelName}`);
    console.error(err);
    process.exit(1);
  }
}

main().catch(console.error);
