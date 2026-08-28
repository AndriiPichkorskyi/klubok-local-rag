/**
 * Спільний журнал прогресу: сюди пишуться повідомлення ВСІХ операцій панелі.
 * Автопрокрутка «липне» до низу, але вимикається, щойно розробник прокрутив угору,
 * щоб не висмикувати з-під очей потрібний рядок.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatClock } from "./format";

const LEVEL_CLASS = {
  error: "dp-err",
  done: "dp-ok",
  start: "dp-warn",
  info: "",
  progress: "muted",
};

export default function ProgressLog({ entries, onClear }) {
  const bodyRef = useRef(null);
  const [stick, setStick] = useState(true);

  // Слідкуємо, чи розробник сам не відкрутив журнал угору.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return undefined;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      setStick(distance < 24);
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!stick) return;
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, stick]);

  return (
    <div className="dp-log">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <span className="dp-section-title">Журнал прогресу</span>
        <span className="row">
          <span className="dp-badge">{entries.length}</span>
          {!stick ? (
            <button
              type="button"
              onClick={() => {
                setStick(true);
                const node = bodyRef.current;
                if (node) node.scrollTop = node.scrollHeight;
              }}
            >
              Вниз
            </button>
          ) : null}
          <button type="button" onClick={onClear} disabled={entries.length === 0}>
            Очистити
          </button>
        </span>
      </div>

      <div className="dp-log-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <div className="muted">Журнал порожній. Запустіть будь-яку операцію.</div>
        ) : (
          entries.map((entry) => (
            <div className="dp-log-line" key={entry.seq}>
              <span className="dp-log-time">{formatClock(entry.ts)}</span>
              <span className="dp-log-src">[{entry.source}]</span>
              <span className={LEVEL_CLASS[entry.level] || ""}>
                {typeof entry.pct === "number" ? `${entry.pct}% ` : ""}
                {entry.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
