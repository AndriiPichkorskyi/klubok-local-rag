/**
 * Стан пошуку: запуск, живий прогрес, скасування, людські помилки.
 * З бекендом говоримо ВИКЛЮЧНО через src/ipc.js.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { query as rpcQuery, jobCancel, onProgress, newRef } from "../ipc";
import { normalizeAnswer } from "./parseAnswer";

/** Перетворює технічну помилку на пояснення для людини. Стек не показуємо. */
export function humanizeError(error) {
  const raw =
    typeof error === "string" ? error : error?.message ? String(error.message) : String(error ?? "");
  const text = raw.toLowerCase();

  if (/ollama|11434|econnrefused|fetch failed|failed to fetch/.test(text)) {
    return {
      title: "Схоже, Ollama не запущена",
      hint:
        "Пошук працює локально через Ollama. Відкрийте Термінал, виконайте «ollama serve» " +
        "і спробуйте ще раз. Якщо Ollama встановлена, але моделі немає — завантажте її в режимі розробника (⌘D).",
    };
  }
  if (/не підключен|канал до sidecar|з'єднання розірвано|з.єднання/.test(text)) {
    return {
      title: "Немає зв'язку з бекендом",
      hint:
        "Внизу вікна показано стан підключення. Якщо там «немає зв'язку» — перезапустіть застосунок " +
        "(npm run app) або сам sidecar (npm run sidecar:dev).",
    };
  }
  if (/час очікування|timeout/.test(text)) {
    return {
      title: "Бекенд не відповів вчасно",
      hint:
        "Модель могла надто довго думати або зависнути. Спробуйте ще раз; якщо повторюється — " +
        "перевірте, чи працює Ollama, і чи не завантажена система іншими задачами.",
    };
  }
  if (/lancedb|database|таблиц|table|no such/.test(text)) {
    return {
      title: "База знань ще не готова",
      hint:
        "Схоже, індекс програм порожній або пошкоджений. Запустіть повну синхронізацію " +
        "в режимі розробника (⌘D → повний цикл) і поверніться сюди.",
    };
  }
  return {
    title: "Пошук не вдався",
    hint: raw.trim()
      ? `Бекенд повідомив: ${raw.trim()}. Спробуйте ще раз або перезапустіть застосунок.`
      : "Спробуйте ще раз або перезапустіть застосунок.",
  };
}

const IDLE_PROGRESS = { msg: "", pct: null };

export function useSearch() {
  const [phase, setPhase] = useState("idle"); // idle | searching | done | error
  const [progress, setProgress] = useState(IDLE_PROGRESS);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);
  const [askedText, setAskedText] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);

  // Лічильник запусків: результат «застарілого» запиту ігноруємо.
  const runRef = useRef(0);
  const activeRef = useRef(false);
  // id задачі на бекенді. Rust генерує його сам і фронтенду не повертає —
  // єдине місце, де ми його бачимо, це кадри progress зі своєю міткою.
  const jobIdRef = useRef(null);
  // Наша мітка виклику. Прогрес чужих операцій (наприклад, векторизації,
  // запущеної в панелі розробника) приходить у те саме вікно і має бути відкинутий.
  const clientRefRef = useRef(null);
  const startedAtRef = useRef(0);

  // Живий прогрес. Підписка одна на весь час життя компонента.
  useEffect(() => {
    const sub = onProgress((payload) => {
      if (!activeRef.current || !payload) return;
      // Беремо лише свій прогрес. Без цієї перевірки паралельна операція
      // в панелі розробника переписувала б рядок стану вікна пошуку.
      if (!clientRefRef.current || payload.ref !== clientRefRef.current) return;
      if (typeof payload.id === "number") jobIdRef.current = payload.id;
      setProgress({
        msg: typeof payload.msg === "string" ? payload.msg : "",
        pct: typeof payload.pct === "number" ? payload.pct : null,
      });
    });
    return () => {
      sub.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // Секундомір: під час довгого пошуку людина має бачити, що час іде.
  useEffect(() => {
    if (phase !== "searching") return undefined;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
    return () => clearInterval(timer);
  }, [phase]);

  const run = useCallback((text) => {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;

    const runId = ++runRef.current;
    activeRef.current = true;
    jobIdRef.current = null;
    clientRefRef.current = newRef("query");
    startedAtRef.current = Date.now();

    setAskedText(trimmed);
    setAnswer(null);
    setError(null);
    setElapsedMs(0);
    setProgress({ msg: "Готуємо пошук…", pct: null });
    setPhase("searching");

    rpcQuery(trimmed, {}, clientRefRef.current)
      .then((result) => {
        if (runRef.current !== runId) return; // запит скасовано або замінено новим
        activeRef.current = false;
        setAnswer(normalizeAnswer(result));
        setProgress(IDLE_PROGRESS);
        setPhase("done");
      })
      .catch((err) => {
        if (runRef.current !== runId) return;
        activeRef.current = false;
        setError(humanizeError(err));
        setProgress(IDLE_PROGRESS);
        setPhase("error");
      });
  }, []);

  /** Скасування: відв'язуємось від результату і просимо бекенд зупинитись. */
  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    runRef.current += 1;
    activeRef.current = false;
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    if (typeof jobId === "number") jobCancel(jobId).catch(() => {});
    setProgress(IDLE_PROGRESS);
    setPhase("idle");
  }, []);

  const reset = useCallback(() => {
    runRef.current += 1;
    activeRef.current = false;
    jobIdRef.current = null;
    setPhase("idle");
    setAnswer(null);
    setError(null);
    setAskedText("");
    setElapsedMs(0);
    setProgress(IDLE_PROGRESS);
  }, []);

  return { phase, progress, answer, error, askedText, elapsedMs, run, cancel, reset };
}
