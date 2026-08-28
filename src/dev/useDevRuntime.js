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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onProgress, newRef } from "../ipc";
import { errorText, summarizeResult } from "./format";

/** Скільки рядків журналу тримаємо в пам'яті (векторизація сипле тисячами). */
const LOG_LIMIT = 500;

export function useDevRuntime() {
  const [ops, setOps] = useState({});
  const [logEntries, setLogEntries] = useState([]);
  const [, setTick] = useState(0);

  // Синхронне дзеркало ops: перевіряти дубль запуску по стану React пізно —
  // setState асинхронний, а два кліки поспіль ідуть в одному кадрі.
  const opsRef = useRef({});
  const seqRef = useRef(0);

  // ref (наша мітка) → ключ операції. Єдиний спосіб зв'язати подію з кнопкою.
  const refToKeyRef = useRef(new Map());

  const appendLog = useCallback((entry) => {
    setLogEntries((prev) => {
      const next = prev.concat({ seq: (seqRef.current += 1), ts: Date.now(), ...entry });
      return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
    });
  }, []);

  const clearLog = useCallback(() => setLogEntries([]), []);

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
      if (opsRef.current[key]?.running) return;

      const startedAt = Date.now();
      const ref = newRef(key);
      refToKeyRef.current.set(ref, key);

      patchOp(key, {
        label,
        running: true,
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
      });
      appendLog({ source: label, text: "старт", level: "start" });

      const finish = (patch, logText, level) => {
        refToKeyRef.current.delete(ref);
        patchOp(key, {
          running: false,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          pct: null,
          msg: null,
          ...patch,
        });
        appendLog({ source: label, text: logText, level });
      };

      Promise.resolve()
        .then(() => fn(ref))
        .then((result) =>
          finish({ result, error: null }, `готово · ${summarizeResult(result)}`, "done"),
        )
        .catch((error) => {
          const text = errorText(error);
          finish({ result: undefined, error: text }, `помилка: ${text}`, "error");
        });
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
          text: `не вдалося підписатись на прогрес: ${errorText(error)}`,
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

  return { ops, run, note, anyRunning, runningCount, logEntries, clearLog };
}

/** Стан однієї операції з безпечними значеннями за замовчуванням. */
export function opState(ops, key) {
  return ops[key] || { running: false, pct: null, msg: null, error: null, result: undefined };
}
