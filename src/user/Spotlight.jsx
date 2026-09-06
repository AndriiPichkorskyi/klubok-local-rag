/**
 * Ask Klubok: людина формулює намір, а наявний RAG-потік знаходить локальний
 * інструмент. Цей компонент змінює тільки подачу, не спосіб обробки запиту.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Sparkles } from "lucide-react";
import { useSearch } from "./useSearch";
import ProgressPanel from "./ProgressPanel";
import ResultView from "./ResultView";
import ErrorView from "./ErrorView";
import ReadinessGate from "./ReadinessGate";
import { useReadiness } from "./useReadiness";
import klubokImage from "../assets/klubok_transparent.png";
import "./spotlight.css";

export default function Spotlight() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [visiblePhase, setVisiblePhase] = useState("idle");
  const inputRef = useRef(null);
  const { phase, progress, answer, error, askedText, run, cancel, reset } = useSearch();
  const readiness = useReadiness();
  const [gateDismissed, setGateDismissed] = useState(false);
  const gateOpen = !gateDismissed && readiness.phase !== "ready";

  const itemCount = useMemo(() => {
    if (visiblePhase !== "done" || !answer || answer.kind !== "match") return 0;
    return 1 + answer.alternatives.length;
  }, [answer, visiblePhase]);

  const startSearch = useCallback(
    (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return;
      setText(trimmed);
      setSelectedIndex(-1);
      setVisiblePhase("searching");
      run(trimmed);
    },
    [run],
  );

  const clearAll = useCallback(() => {
    setText("");
    setSelectedIndex(-1);
    setVisiblePhase("idle");
    reset();
    inputRef.current?.focus();
  }, [reset]);

  const handlerRef = useRef(null);
  handlerRef.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (visiblePhase === "searching") {
        if (phase === "searching") cancel();
        else if (phase !== "done") setVisiblePhase("idle");
      }
      else if (selectedIndex >= 0) setSelectedIndex(-1);
      else clearAll();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (visiblePhase === "searching") return;
      startSearch(text);
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && itemCount > 0) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((current) => Math.max(-1, Math.min(itemCount - 1, current + delta)));
    }
  };

  useEffect(() => {
    const onKeyDown = (event) => handlerRef.current?.(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => inputRef.current?.focus(), []);

  // Успішна відповідь чекає, доки клубок завершить весь маршрут. Помилку не маскуємо.
  useEffect(() => {
    if (phase === "idle") setVisiblePhase("idle");
    if (phase === "error") setVisiblePhase("error");
    if (phase === "searching") setVisiblePhase("searching");
  }, [phase]);

  const finishPresentation = useCallback(() => {
    if (phase === "done") setVisiblePhase("done");
  }, [phase]);

  const cancelPresentation = useCallback(() => {
    if (phase === "searching") {
      cancel();
      setVisiblePhase("idle");
      return;
    }
  }, [cancel, phase]);

  if (gateOpen) {
    return (
      <main className="ask-page is-gated">
        <ReadinessGate
          phase={readiness.phase}
          report={readiness.report}
          error={readiness.error}
          pull={readiness.pull}
          vectors={readiness.vectors}
          build={readiness.build}
          onRecheck={readiness.check}
          onPull={readiness.pullModel}
          onDismiss={() => setGateDismissed(true)}
          onBuildVectors={readiness.buildVectors}
          onCancelBuild={readiness.cancelBuild}
          onSkipVectors={readiness.skipVectors}
        />
      </main>
    );
  }

  return (
    <main className="ask-page" data-phase={visiblePhase}>
      <header className="ask-header">
        <div>
          <span className="eyebrow">{t("ask.eyebrow")}</span>
          <h1>{t("ask.title")}</h1>
        </div>
        <span className="ask-privacy"><span /> {t("ask.privacy")}</span>
      </header>

      <section className="ask-composer" aria-label={t("ask.region")}>
        <Sparkles size={20} strokeWidth={1.7} aria-hidden="true" />
        <input
          ref={inputRef}
          className="ask-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={t("ask.inputLabel")}
          placeholder={t("ask.placeholder")}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSelectedIndex(-1);
          }}
        />
        <button
          type="button"
          className="ask-submit"
          aria-label={t("ask.submit")}
          disabled={!text.trim() || visiblePhase === "searching"}
          onClick={() => startSearch(text)}
        >
          <ArrowUp size={20} strokeWidth={2.2} />
        </button>
      </section>

      {visiblePhase === "idle" ? (
        <section className="ask-welcome">
          <div className="ask-yarn" aria-hidden="true">
            <img src={klubokImage} alt="" />
          </div>
          <h2>{t("ask.welcomeTitle")}</h2>
          <p>{t("ask.welcomeText")}</p>
          <div className="ask-examples" aria-label={t("ask.examplesLabel")}>
            {t("ask.examples", { returnObjects: true }).map((example) => (
              <button type="button" key={example} onClick={() => startSearch(example)}>
                {example}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {visiblePhase === "searching" ? (
        <ProgressPanel
          query={askedText}
          msg={progress.msg}
          complete={phase === "done"}
          onComplete={finishPresentation}
          onCancel={cancelPresentation}
        />
      ) : null}

      {visiblePhase === "error" ? (
        <div className="sp-result">
          <ErrorView error={error} onRetry={() => startSearch(askedText || text)} />
        </div>
      ) : null}

      {visiblePhase === "done" ? (
        <ResultView
          answer={answer}
          askedText={askedText}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
        />
      ) : null}
    </main>
  );
}
