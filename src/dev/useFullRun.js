/**
 * Оркестрація комбінованого прогону «пайплайн + тести».
 *
 * Послідовність будується і виконується ТУТ, у React: жодного нового методу на
 * бекенді немає — це по черзі викликані `pipeline.*` і `tests.*`
 * (docs/contracts/rpc.md). Кожен наступний крок стартує лише після успіху
 * попереднього; на першій же помилці прогін зупиняється, і видно, на чому саме.
 *
 * Прогін триває годину — і весь цей час панель лишається живою: цикл асинхронний,
 * кроки виконуються через звичайний run() з useDevRuntime, стан живе в React.
 *
 * «Стоп» перериває ВСЮ послідовність. Навіть якщо бекенд не вміє переривати
 * поточний крок (job.cancel → cancelled:false), наступні кроки не почнуться —
 * і в підсумку це видно як «зупинено користувачем», а не як помилка.
 */
import { useCallback, useRef, useState } from "react";
import { rpc } from "../ipc";

/** Крок плану, ще не запущений. */
const pendingEntry = (step) => ({ ...step, status: "pending", startedAt: null, finishedAt: null, durationMs: null, result: undefined, error: null });

export function useFullRun({ run, cancelOp, note, onFinished }) {
  const [entries, setEntries] = useState([]);
  const [state, setState] = useState("idle"); // idle | running | done | failed | cancelled
  const [startedAt, setStartedAt] = useState(null);
  const [finishedAt, setFinishedAt] = useState(null);
  const [stopping, setStopping] = useState(false);

  // Синхронні дзеркала: рішення «стартувати наступний крок?» приймається
  // всередині асинхронного циклу, куди стан React приходить із запізненням.
  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const activeKeyRef = useRef(null);

  const patchEntry = useCallback((key, patch) => {
    setEntries((prev) => prev.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  }, []);

  const start = useCallback(
    (plan) => {
      if (runningRef.current || !Array.isArray(plan) || plan.length === 0) return;

      runningRef.current = true;
      stopRef.current = false;
      activeKeyRef.current = null;
      setStopping(false);
      setEntries(plan.map(pendingEntry));
      setState("running");
      setStartedAt(Date.now());
      setFinishedAt(null);
      note?.("Повний прогін", `старт: ${plan.length} кроків поспіль`, "start");

      (async () => {
        let outcome = "done";
        let stoppedAt = null;

        for (const step of plan) {
          if (stopRef.current) {
            outcome = "cancelled";
            break;
          }

          activeKeyRef.current = step.key;
          const stepStartedAt = Date.now();
          patchEntry(step.key, { status: "running", startedAt: stepStartedAt });

          const finished = await run(step.key, `Прогін · ${step.label}`, (ref) =>
            rpc(step.method, step.params || {}, ref),
          );

          const durationMs = Date.now() - stepStartedAt;
          activeKeyRef.current = null;

          // Скасування приходить успішним результатом з cancelled:true —
          // крок при цьому «зупинено», а не «готово».
          if (finished.ok && finished.cancelled) {
            patchEntry(step.key, {
              status: "cancelled",
              finishedAt: Date.now(),
              durationMs,
              result: finished.result,
              error: null,
            });
            outcome = "cancelled";
            break;
          }

          if (finished.ok) {
            patchEntry(step.key, {
              status: "done",
              finishedAt: Date.now(),
              durationMs,
              result: finished.result,
              error: null,
            });
            // Користувач натиснув «Стоп», поки крок ще йшов, а бекенд його не перервав:
            // крок дійшов до кінця, але наступні не починаємо.
            if (stopRef.current) {
              outcome = "cancelled";
              break;
            }
            continue;
          }

          const cancelled = finished.cancelled || stopRef.current;
          patchEntry(step.key, {
            status: cancelled ? "cancelled" : "error",
            finishedAt: Date.now(),
            durationMs,
            error: finished.error,
          });
          outcome = cancelled ? "cancelled" : "failed";
          stoppedAt = step.label;
          break;
        }

        // Кроки, до яких не дійшли, чесно позначаємо «не виконувався».
        setEntries((prev) =>
          prev.map((entry) => (entry.status === "pending" ? { ...entry, status: "skipped" } : entry)),
        );

        setState(outcome);
        setFinishedAt(Date.now());
        setStopping(false);
        runningRef.current = false;
        note?.(
          "Повний прогін",
          outcome === "done"
            ? "завершено: усі кроки виконано"
            : outcome === "cancelled"
              ? "зупинено користувачем"
              : `зупинено помилкою на кроці «${stoppedAt}»`,
          outcome === "done" ? "done" : outcome === "cancelled" ? "info" : "error",
        );
        onFinished?.(outcome);
      })();
    },
    [note, onFinished, patchEntry, run],
  );

  /**
   * Зупинка всієї послідовності. Спершу піднімаємо прапорець (це гарантує, що
   * наступний крок не стартує в будь-якому разі), потім просимо бекенд перервати
   * поточний. Що саме відповів job.cancel — покаже сам крок.
   */
  const stop = useCallback(() => {
    if (!runningRef.current) return;
    stopRef.current = true;
    setStopping(true);
    const key = activeKeyRef.current;
    if (key) cancelOp?.(key);
  }, [cancelOp]);

  const running = state === "running";
  const totalMs = startedAt ? (finishedAt || Date.now()) - startedAt : null;

  return { entries, state, running, stopping, startedAt, finishedAt, totalMs, start, stop };
}
