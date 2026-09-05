/**
 * Модуль 2.4.1 — головний інтерфейс користувача у стилі Spotlight.
 * Людина описує завдання своїми словами, ми шукаємо серед уже встановлених
 * програм ту, що це вміє, і показуємо кроки з її документації.
 *
 * Клавіатура: Enter — шукати, Esc — скасувати/очистити, ↑↓ — рух по результатах.
 * Інтерфейс не блокується: усе, що довге, живе в useSearch і показує прогрес.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "./useSearch";
import ProgressPanel from "./ProgressPanel";
import ResultView from "./ResultView";
import ErrorView from "./ErrorView";
import ReadinessGate from "./ReadinessGate";
import { useReadiness } from "./useReadiness";
import "./spotlight.css";

const EXAMPLES = [
  "як зробити запис екрана",
  "як записати звук з мікрофона",
  "як обрізати відео",
];

export default function Spotlight() {
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [openAlts, setOpenAlts] = useState(() => new Set());

  const inputRef = useRef(null);
  const { phase, progress, answer, error, askedText, elapsedMs, run, cancel, reset } = useSearch();

  // Модуль 2.1: поки оточення не готове, пошук показувати нема сенсу — він
  // однаково впаде, і людина побачить помилку RAG замість «запустіть Ollama».
  // Перевірку можна свідомо пропустити: false negative не мусить замикати вікно.
  const readiness = useReadiness();
  const [gateDismissed, setGateDismissed] = useState(false);
  const gateOpen = !gateDismissed && readiness.phase !== "ready";

  // Скільки елементів обходять стрілки: головна картка + альтернативи.
  const itemCount = useMemo(() => {
    if (phase !== "done" || !answer || answer.kind !== "match") return 0;
    return 1 + answer.alternatives.length;
  }, [phase, answer]);

  /** Запуск пошуку з очищенням стану попереднього результату. */
  const startSearch = useCallback(
    (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return;
      setSelectedIndex(-1);
      setStepsOpen(false);
      setOpenAlts(new Set());
      run(trimmed);
    },
    [run],
  );

  const toggleAlt = useCallback((name) => {
    setOpenAlts((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /** Перепитати про конкретну альтернативу — деталей по ній у відповіді немає. */
  const askAbout = useCallback(
    (appName) => {
      const base = askedText || text;
      const next = `${base} у ${appName}`.trim();
      setText(next);
      startSearch(next);
    },
    [askedText, text, startSearch],
  );

  /** Enter по вибраному елементу: розгорнути статтю або альтернативу. */
  const activateSelection = useCallback(() => {
    if (!answer || answer.kind !== "match") return;
    if (selectedIndex === 0) {
      setStepsOpen((v) => !v);
      return;
    }
    const name = answer.alternatives[selectedIndex - 1];
    if (name) toggleAlt(name);
  }, [answer, selectedIndex, toggleAlt]);

  const clearAll = useCallback(() => {
    setText("");
    setSelectedIndex(-1);
    setStepsOpen(false);
    setOpenAlts(new Set());
    reset();
    inputRef.current?.focus();
  }, [reset]);

  // Актуальний обробник клавіш тримаємо в ref, щоб слухач вішався один раз
  // і при цьому не бачив застарілого стану.
  const handlerRef = useRef(null);
  handlerRef.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return; // ⌘D та інше — не наше

    if (event.key === "Escape") {
      event.preventDefault();
      if (phase === "searching") cancel();
      else if (selectedIndex >= 0) setSelectedIndex(-1);
      else clearAll();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (selectedIndex >= 0) activateSelection();
      else startSearch(text);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (itemCount === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((prev) => {
        const next = prev + delta;
        if (next < 0) return -1; // вище першого — повертаємось у поле вводу
        if (next >= itemCount) return itemCount - 1;
        return next;
      });
      inputRef.current?.focus();
    }
  };

  useEffect(() => {
    const onKeyDown = (event) => handlerRef.current?.(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const isIdle = phase === "idle";

  return (
    <main className="sp-root" data-phase={phase}>
      <div className="sp-stage">
        {gateOpen ? (
          <ReadinessGate
            phase={readiness.phase}
            report={readiness.report}
            error={readiness.error}
            pull={readiness.pull}
            onRecheck={readiness.check}
            onPull={readiness.pullModel}
            onDismiss={() => setGateDismissed(true)}
          />
        ) : (
          <>
            <div className="sp-field">
              <input
                ref={inputRef}
                className="sp-input"
                type="text"
                autoFocus
                spellCheck={false}
                autoComplete="off"
                aria-label="Опишіть, що потрібно зробити"
                placeholder="Що потрібно зробити?"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setSelectedIndex(-1);
                }}
              />
            </div>

            {isIdle ? (
              <>
                <p className="sp-hint">
                  Опишіть завдання своїми словами — знайдемо програму, яка вже є на цьому Mac.
                  <br />
                  Наприклад:
                </p>
                <ul className="sp-examples">
                  {EXAMPLES.map((example) => (
                    <li key={example}>
                      <button
                        type="button"
                        className="sp-example"
                        onClick={() => {
                          setText(example);
                          startSearch(example);
                        }}
                      >
                        {example}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {phase === "searching" ? (
              <ProgressPanel
                msg={progress.msg}
                pct={progress.pct}
                elapsedMs={elapsedMs}
                onCancel={cancel}
              />
            ) : null}

            {phase === "error" ? (
              <div className="sp-result">
                <ErrorView error={error} onRetry={() => startSearch(askedText || text)} />
              </div>
            ) : null}

            {phase === "done" ? (
              <ResultView
                answer={answer}
                askedText={askedText}
                selectedIndex={selectedIndex}
                onSelect={setSelectedIndex}
                stepsOpen={stepsOpen}
                onToggleSteps={() => setStepsOpen((v) => !v)}
                openAlts={openAlts}
                onToggleAlt={toggleAlt}
                onAskAbout={askAbout}
              />
            ) : null}

            {phase === "done" && itemCount > 0 ? (
              <p className="sp-hint">
                <kbd>↑</kbd> <kbd>↓</kbd> — рух по результатах, <kbd>Enter</kbd> — розгорнути,{" "}
                <kbd>Esc</kbd> — очистити
              </p>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
