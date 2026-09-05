/**
 * Модуль 2.1 з боку користувача: чи готова система до роботи.
 *
 * Один `bootstrap.check` при відкритті вікна — і далі лише на вимогу. Викликати
 * його на кожен запит не можна: метод питає Ollama по HTTP, і платити за це
 * кожним пошуком безглуздо. Форма відповіді — docs/contracts/rpc.md.
 *
 * Метод не кидає винятків через відсутню Ollama чи модель — це нормальні стани
 * з `ready: false` і списком `actions`. Виняток означає інше: не піднявся сам
 * міст до sidecar, і тоді ми чекаємо на з'єднання і питаємо ще раз.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { bootstrapCheck, rpc, onProgress, onStatus, sidecarStatus, newRef } from "../ipc";

/** Як часто перепитувати, поки бекенд піднімається. */
const RETRY_MS = 1500;
/**
 * Скільки чекати на бекенд, перш ніж називати це поломкою. Зібраний застосунок
 * стартує node, той вантажить нативні модулі й піднімає WebSocket — це секунди,
 * і показувати в цей час «немає зв'язку» означає лякати людину справністю.
 */
const STARTUP_GRACE_MS = 25000;

/** Текст помилки без стека. */
function errorText(error) {
  if (typeof error === "string") return error;
  return String(error?.message ?? error ?? "");
}

/** Чи підключений міст до sidecar. Питаємо Rust, а не вгадуємо по тексту помилки. */
async function bridgeConnected() {
  try {
    return Boolean((await sidecarStatus())?.connected);
  } catch {
    return false;
  }
}

export function useReadiness() {
  // starting — бекенд ще піднімається; checking — питаємо; ready — можна
  // працювати; blocked — ready:false; failed — виклик не вдався і чекати вже
  // немарно (минув STARTUP_GRACE_MS або міст підключений, а метод усе одно впав).
  const [phase, setPhase] = useState("starting");
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  // Стан завантаження моделі: {model, msg, pct, error}. null — нічого не тягнемо.
  const [pull, setPull] = useState(null);

  const inFlightRef = useRef(false);
  const startedAtRef = useRef(Date.now());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // Мітка активного pullModel. Прогрес чужих операцій приходить у те саме
  // вікно, тож беремо лише свій (див. правило про `ref` у контракті).
  const pullRefRef = useRef(null);

  const check = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("checking");
    setError(null);
    try {
      const result = await bootstrapCheck();
      setReport(result);
      setPhase(result?.ready ? "ready" : "blocked");
    } catch (caught) {
      // Різниця принципова: якщо мосту ще немає — це запуск, а не поломка.
      // Якщо міст є, а метод усе одно впав — це справжня помилка, її й показуємо.
      const connected = await bridgeConnected();
      const waitedTooLong = Date.now() - startedAtRef.current > STARTUP_GRACE_MS;
      setError(errorText(caught));
      setPhase(connected || waitedTooLong ? "failed" : "starting");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // Поки бекенд піднімається — перепитуємо самі. Людині не треба тиснути
  // «Перевірити ще раз» лише тому, що вона відкрила вікно на секунду раніше.
  useEffect(() => {
    if (phase !== "starting") return undefined;
    const timer = setInterval(() => check(), RETRY_MS);
    return () => clearInterval(timer);
  }, [phase, check]);

  // Міст піднімається не миттєво: перша перевірка може впасти на «sidecar не
  // підключений». Щойно з'єднання з'явилось — питаємо ще раз, самі. Повторні
  // перепідключення (sidecar --watch) перевірку не смикають: вона потрібна
  // лише тим, хто відповіді ще не отримав.
  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    const subscription = onStatus((status) => {
      const waiting = phaseRef.current === "failed" || phaseRef.current === "starting";
      if (status?.connected && waiting) check();
    });
    subscription
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [check]);

  // Прогрес завантаження моделі: `ollama pull` тягне гігабайти, і людина мусить
  // бачити відсотки, а не застиглий екран.
  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    const subscription = onProgress((payload) => {
      if (!payload || !pullRefRef.current || payload.ref !== pullRefRef.current) return;
      setPull((prev) =>
        prev
          ? {
              ...prev,
              msg: typeof payload.msg === "string" ? payload.msg : prev.msg,
              pct: typeof payload.pct === "number" ? payload.pct : null,
            }
          : prev,
      );
    });
    subscription
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  /** Завантажити модель і одразу перепитати готовність. */
  const pullModel = useCallback(
    async (model) => {
      if (!model || pullRefRef.current) return;
      const ref = newRef("gate-pull");
      pullRefRef.current = ref;
      setPull({ model, msg: `Завантаження ${model}…`, pct: null, error: null });
      try {
        await rpc("bootstrap.pullModel", { model }, ref);
        pullRefRef.current = null;
        setPull(null);
        await check();
      } catch (caught) {
        pullRefRef.current = null;
        setPull({ model, msg: null, pct: null, error: errorText(caught) });
      }
    },
    [check],
  );

  return { phase, report, error, pull, check, pullModel };
}
