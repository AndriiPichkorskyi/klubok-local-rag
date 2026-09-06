/**
 * Стан пошуку: запуск, живий прогрес, скасування, людські помилки.
 * З бекендом говоримо ВИКЛЮЧНО через src/ipc.js.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { query as rpcQuery, jobCancel, onProgress, newRef } from "../ipc";
import { normalizeLanguage } from "../i18n";
import { normalizeAnswer } from "./parseAnswer";

/** Перетворює технічну помилку на пояснення для людини. Стек не показуємо. */
export function humanizeError(error, t) {
  const raw =
    typeof error === "string" ? error : error?.message ? String(error.message) : String(error ?? "");
  const text = raw.toLowerCase();

  if (/ollama|11434|econnrefused|fetch failed|failed to fetch/.test(text)) {
    return {
      title: t("error.ollamaTitle"),
      hint: t("error.ollamaHint"),
    };
  }
  if (/не підключен|канал до sidecar|з'єднання розірвано|з.єднання/.test(text)) {
    return {
      title: t("error.backendTitle"),
      hint: t("error.backendHint"),
    };
  }
  if (/час очікування|timeout/.test(text)) {
    return {
      title: t("error.timeoutTitle"),
      hint: t("error.timeoutHint"),
    };
  }
  if (/lancedb|database|таблиц|table|no such/.test(text)) {
    return {
      title: t("error.databaseTitle"),
      hint: t("error.databaseHint"),
    };
  }
  return {
    title: t("error.searchFailed"),
    hint: raw.trim()
      ? t("error.backendSaid", { message: raw.trim() })
      : t("error.genericHint"),
  };
}

const IDLE_PROGRESS = { msg: "", pct: null };

export function useSearch() {
  const { i18n } = useTranslation();
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
    setProgress({ msg: "", pct: null });
    setPhase("searching");

    const language = normalizeLanguage(i18n.language) || "en";
    rpcQuery(trimmed, { language }, clientRefRef.current)
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
        setError(err);
        setProgress(IDLE_PROGRESS);
        setPhase("error");
      });
  }, [i18n.language]);

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
