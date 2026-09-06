/**
 * Ядро панелі: реєстр операцій + спільний журнал прогресу.
 *
 * Головне правило проєкта — інтерфейс не блокується. Тому жодна операція не
 * чекається синхронно: run() лише стартує проміс і одразу повертає керування,
 * а стан операції (прогрес, результат, помилка) живе в React-стані.
 *
 * Прогрес зіставляється з операцією ЛИШЕ за міткою `ref` (див. docs/contracts/rpc.md):
 * кожен запуск генерує власний newRef(), передає його третім аргументом у rpc(),
 * і Rust повертає цю мітку в кожній події `sidecar://progress`. Ніяких здогадок
 * за порядком чи за `id` — інакше паралельний запит зі Spotlight крав би прогрес.
 *
 * run() ДОДАТКОВО повертає проміс з підсумком {ok, result, error, cancelled}.
 * Він потрібен послідовному прогону (useFullRun.js), щоб чекати кінця кроку і
 * не починати наступний. Кнопки, яким підсумок не потрібен, просто його ігнорують.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onProgress, newRef, jobCancel, testsPause, testsResume } from "../ipc";
import { errorText, summarizeResult } from "./format";
import { dt } from "./i18n";

/**
 * Скільки рядків журналу тримаємо в пам'яті.
 *
 * Реальний випадок: під час багатогодинної векторизації дочірній процес слав
 * ~12 повідомлень на секунду — за ніч це сотні тисяч записів у стані React.
 * Джерело флуду прибрали з боку бекенда, але панель мусить бути стійкою й сама.
 */
const LOG_LIMIT = 2000;

/**
 * Запас понад ліміт: підрізаємо не на кожному рядку, а раз на LOG_SLACK рядків.
 * Інакше при дванадцяти повідомленнях на секунду кожне з них коштувало б
 * повного проходу масивом.
 */
const LOG_SLACK = 200;

/**
 * Рівні, які обрізання НЕ викидає. Сенс обмеження — не втратити те, заради чого
 * журнал і читають: старт операції, її завершення, скасування і помилку.
 * Тисячі рядків `progress` між ними цінності не мають — зрізаємо саме їх.
 */
const PINNED_LEVELS = new Set(["start", "done", "error", "info"]);

/**
 * Обрізання журналу. Найстаріші рядки прогресу викидаємо з БУДЬ-ЯКОГО місця
 * масиву, а не лише з голови: саме так помилка, після якої пройшла тисяча
 * рядків векторизації, лишається видимою. Якщо самих лише важливих рядків
 * назбиралось більше за ліміт — зрізаємо найстаріші з них, іншого виходу немає.
 * Повертає новий масив і кількість зрізаного (її показує журнал, щоб не
 * вдавати, ніби нічого не було).
 */
function trimLog(entries) {
  if (entries.length <= LOG_LIMIT) return { entries, dropped: 0 };

  let toDrop = entries.length - LOG_LIMIT;
  const kept = [];
  for (const entry of entries) {
    if (toDrop > 0 && !PINNED_LEVELS.has(entry.level)) {
      toDrop -= 1;
      continue;
    }
    kept.push(entry);
  }

  const dropped = entries.length - kept.length;
  if (kept.length <= LOG_LIMIT) return { entries: kept, dropped };

  const extra = kept.length - LOG_LIMIT;
  return { entries: kept.slice(extra), dropped: dropped + extra };
}

/** Текст помилки, який видає перерване виконання. Потрібен, щоб відрізнити зупинку від збою. */
const CANCEL_TEXT = /скасов|зупинен|cancel|abort/i;

export function useDevRuntime() {
  const [ops, setOps] = useState({});
  // Журнал і лічильник зрізаних рядків — один стан: вони змінюються в одному
  // й тому ж оновленні, і роз'їхатись не повинні.
  const [log, setLog] = useState({ entries: [], dropped: 0 });
  const [, setTick] = useState(0);

  // Синхронне дзеркало ops: перевіряти дубль запуску по стану React пізно —
  // setState асинхронний, а два кліки поспіль ідуть в одному кадрі.
  const opsRef = useRef({});
  const seqRef = useRef(0);

  // ref (наша мітка) → ключ операції. Єдиний спосіб зв'язати подію з кнопкою.
  const refToKeyRef = useRef(new Map());

  const appendLog = useCallback((entry) => {
    // seq і час рахуємо ЗА МЕЖАМИ оновлювача: він має лишатися чистою функцією,
    // інакше повторний виклик (React у режимі перевірок) зсував би нумерацію.
    const line = { seq: (seqRef.current += 1), ts: Date.now(), ...entry };
    setLog((prev) => {
      const entries = prev.entries.concat(line);
      if (entries.length <= LOG_LIMIT + LOG_SLACK) return { entries, dropped: prev.dropped };
      const trimmed = trimLog(entries);
      return { entries: trimmed.entries, dropped: prev.dropped + trimmed.dropped };
    });
  }, []);

  const clearLog = useCallback(() => setLog({ entries: [], dropped: 0 }), []);

  /** Записати рядок у спільний журнал поза контекстом операції. */
  const note = useCallback(
    (source, text, level = "info") => appendLog({ source, text, level }),
    [appendLog],
  );

  const patchOp = useCallback((key, patch) => {
    opsRef.current = { ...opsRef.current, [key]: { ...opsRef.current[key], ...patch } };
    setOps((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);

  /**
   * Запуск операції. У fn приходить `ref` — його треба передати третім
   * аргументом у rpc(), інакше прогрес не прив'яжеться до кнопки.
   * Повторний запуск того самого ключа, поки він виконується, ігнорується —
   * дві однакові операції одночасно заборонені.
   */
  const run = useCallback(
    (key, label, fn) => {
      if (opsRef.current[key]?.running) {
        return Promise.resolve({ ok: false, skipped: true, result: undefined, error: null, cancelled: false });
      }

      const startedAt = Date.now();
      const ref = newRef(key);
      refToKeyRef.current.set(ref, key);

      patchOp(key, {
        label,
        running: true,
        status: "running",
        startedAt,
        finishedAt: null,
        durationMs: null,
        pct: null,
        msg: null,
        result: undefined,
        error: null,
        ref,
        // Серверний id дізнаємось із першої події прогресу — job.cancel приймає саме його.
        rpcId: null,
        // Стан зупинки: чи просили, чи підтвердив бекенд, і що він відповів.
        cancelRequested: false,
        cancelAck: false,
        cancelReason: null,
        cancelling: false,
        cancelledText: null,
        paused: false,
        pausing: false,
        resuming: false,
        testConcurrency: null,
        controlReason: null,
      });
      appendLog({ source: label, text: dt("runtime.start"), level: "start" });

      const finish = (patch, logText, level) => {
        refToKeyRef.current.delete(ref);
        patchOp(key, {
          running: false,
          cancelling: false,
          paused: false,
          pausing: false,
          resuming: false,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          pct: null,
          msg: null,
          ...patch,
        });
        appendLog({ source: label, text: logText, level });
      };

      return Promise.resolve()
        .then(() => fn(ref))
        .then((result) => {
          // Скасована задача повертається УСПІШНИМ результатом з полем
          // cancelled:true і тим, що встигло зробитися (sidecar/src/rpc/server.js
          // і методи pipeline.*). Це не «готово» — і виглядати має інакше.
          const stopped = Boolean(result && typeof result === "object" && result.cancelled === true);
          finish(
            { result, error: null, status: stopped ? "cancelled" : "done" },
            `${dt(stopped ? "runtime.stopped" : "runtime.done")} · ${summarizeResult(result)}`,
            stopped ? "info" : "done",
          );
          return { ok: true, result, error: null, cancelled: stopped };
        })
        .catch((error) => {
          const text = errorText(error);
          const op = opsRef.current[key] || {};
          // Зупинено користувачем ≠ впало саме. Другим вважаємо лише те, чого
          // ми не просили: або бекенд підтвердив скасування, або сам так і сказав.
          const cancelled = Boolean(op.cancelRequested) && (Boolean(op.cancelAck) || CANCEL_TEXT.test(text));
          finish(
            cancelled
              ? { result: undefined, error: null, status: "cancelled", cancelledText: text }
              : { result: undefined, error: text, status: "error" },
            cancelled ? `${dt("runtime.stopped")}: ${text}` : dt("runtime.error", { error: text }),
            cancelled ? "info" : "error",
          );
          return { ok: false, result: undefined, error: text, cancelled };
        });
    },
    [appendLog, patchOp],
  );

  /**
   * Зупинка операції. `job.cancel` приймає СЕРВЕРНИЙ id, а не нашу мітку ref,
   * тож id беремо з першої події прогресу (docs/notes/phase3.md — чинний баг).
   * Поки події не було, зупиняти нічого: чесно кажемо про це, а не мовчимо.
   * Відповідь `cancelled:false` теж показуємо як є — бекенд поки що не вміє
   * переривати пайплайн, і вигадувати за нього успіх не можна.
   */
  const cancelOp = useCallback(
    async (key) => {
      const op = opsRef.current[key];
      if (!op?.running) return { cancelled: false, reason: dt("runtime.alreadyStopped") };

      const source = op.label || key;
      patchOp(key, { cancelRequested: true, cancelling: true });

      if (typeof op.rpcId !== "number") {
        const reason = dt("runtime.noServerId");
        patchOp(key, { cancelling: false, cancelAck: false, cancelReason: reason });
        appendLog({ source, text: dt("runtime.stopFailed", { reason }), level: "error" });
        return { cancelled: false, reason };
      }

      try {
        const result = await jobCancel(op.rpcId);
        const ack = Boolean(result?.cancelled);
        const reason = result?.reason || (ack ? "" : dt("runtime.cancelNotConfirmed"));
        patchOp(key, { cancelling: false, cancelAck: ack, cancelReason: reason });
        appendLog({
          source,
          text: ack
            ? dt("runtime.cancelAccepted", { id: op.rpcId })
            : dt("runtime.stopFailedId", { id: op.rpcId, reason }),
          level: ack ? "info" : "error",
        });
        return { cancelled: ack, reason };
      } catch (error) {
        const reason = errorText(error);
        patchOp(key, { cancelling: false, cancelAck: false, cancelReason: reason });
        appendLog({ source, text: dt("runtime.cancelCrashed", { reason }), level: "error" });
        return { cancelled: false, reason };
      }
    },
    [appendLog, patchOp],
  );

  /** Ставить тестову чергу на паузу; уже активні запити можуть завершитись. */
  const pauseOp = useCallback(
    async (key) => {
      const op = opsRef.current[key];
      if (!op?.running) return { paused: false, reason: dt("runtime.alreadyStopped") };
      if (typeof op.rpcId !== "number") {
        const reason = dt("runtime.noServerId");
        patchOp(key, { pausing: false, controlReason: reason });
        return { paused: false, reason };
      }

      patchOp(key, { pausing: true, controlReason: null });
      try {
        const result = await testsPause(op.rpcId);
        const paused = Boolean(result?.paused);
        patchOp(key, {
          paused,
          pausing: false,
          testConcurrency: result?.concurrency ?? op.testConcurrency,
          controlReason: paused ? null : dt("runtime.pauseNotConfirmed"),
        });
        appendLog({
          source: op.label || key,
          text: paused
            ? dt("runtime.pauseAccepted", { active: result?.active || 0, queued: result?.queued || 0 })
            : dt("runtime.pauseNotConfirmed"),
          level: paused ? "info" : "error",
        });
        return result;
      } catch (error) {
        const reason = errorText(error);
        patchOp(key, { pausing: false, controlReason: reason });
        appendLog({ source: op.label || key, text: dt("runtime.pauseFailed", { reason }), level: "error" });
        return { paused: false, reason };
      }
    },
    [appendLog, patchOp],
  );

  /** Продовжує тестову чергу з обраною паралельністю. */
  const resumeOp = useCallback(
    async (key, concurrency) => {
      const op = opsRef.current[key];
      if (!op?.running) return { paused: false, reason: dt("runtime.alreadyStopped") };
      if (typeof op.rpcId !== "number") {
        return { paused: true, reason: dt("runtime.serverIdUnknown") };
      }

      patchOp(key, { resuming: true, controlReason: null });
      try {
        const result = await testsResume(op.rpcId, concurrency);
        patchOp(key, {
          paused: Boolean(result?.paused),
          resuming: false,
          testConcurrency: result?.concurrency ?? concurrency,
          controlReason: null,
        });
        appendLog({
          source: op.label || key,
          text: dt("runtime.resumed", { count: result?.concurrency ?? concurrency }),
          level: "info",
        });
        return result;
      } catch (error) {
        const reason = errorText(error);
        patchOp(key, { resuming: false, controlReason: reason });
        appendLog({ source: op.label || key, text: dt("runtime.resumeFailed", { reason }), level: "error" });
        return { paused: true, reason };
      }
    },
    [appendLog, patchOp],
  );

  // Підписка на прогрес довгих операцій. Відписка — обов'язково в cleanup.
  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    const subscription = onProgress((payload) => {
      const { id, msg, pct, ref } = payload || {};
      const key = ref ? refToKeyRef.current.get(ref) : undefined;

      // Чужий або відсутній ref (наприклад, пошук користувача зі Spotlight):
      // у спільний журнал пишемо, до кнопок панелі не чіпляємо.
      if (key === undefined) {
        appendLog({ source: `rpc #${id ?? "?"}`, text: msg ?? "", level: "progress", pct });
        return;
      }

      const op = opsRef.current[key];
      if (op?.running) {
        patchOp(key, {
          msg: msg ?? null,
          pct: typeof pct === "number" ? pct : null,
          rpcId: op.rpcId ?? (typeof id === "number" ? id : null),
        });
      }
      appendLog({ source: op?.label || key, text: msg ?? "", level: "progress", pct });
    });

    subscription
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        appendLog({
          source: "ipc",
          text: dt("runtime.subscribeFailed", { error: errorText(error) }),
          level: "error",
        });
      });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [appendLog, patchOp]);

  const anyRunning = useMemo(() => Object.values(ops).some((op) => op?.running), [ops]);

  // Поки щось виконується — перемальовуємо раз на секунду, щоб оживити лічильник часу.
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const runningCount = useMemo(
    () => Object.values(ops).filter((op) => op?.running).length,
    [ops],
  );

  return {
    ops,
    run,
    cancelOp,
    pauseOp,
    resumeOp,
    note,
    anyRunning,
    runningCount,
    logEntries: log.entries,
    logDropped: log.dropped,
    clearLog,
  };
}

/** Стан однієї операції з безпечними значеннями за замовчуванням. */
export function opState(ops, key) {
  return (
    ops[key] || {
      running: false,
      status: "idle",
      pct: null,
      msg: null,
      error: null,
      result: undefined,
      cancelRequested: false,
      cancelAck: false,
      cancelReason: null,
      cancelling: false,
      cancelledText: null,
      paused: false,
      pausing: false,
      resuming: false,
      testConcurrency: null,
      controlReason: null,
    }
  );
}
