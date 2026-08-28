/**
 * Кнопка однієї операції разом з її живим прогресом.
 * Поки операція виконується — кнопка неактивна (повторний запуск заборонено),
 * решта панелі при цьому лишається робочою.
 */
import { formatExecutionTime } from "./format";

/** Смужка прогресу: відомий відсоток або «біжуча» смужка, якщо pct = null. */
export function ProgressBar({ pct }) {
  const known = typeof pct === "number" && Number.isFinite(pct);
  return (
    <div className="dp-bar">
      <div
        className={known ? "dp-bar-fill" : "dp-bar-fill dp-indeterminate"}
        style={known ? { width: `${Math.max(0, Math.min(100, pct))}%` } : undefined}
      />
    </div>
  );
}

/** Видима текстом помилка методу. У консоль нічого не ховаємо. */
export function ErrorBox({ text, kind = "error" }) {
  if (!text) return null;
  return (
    <div className={kind === "error" ? "dp-alert" : "dp-alert dp-alert-info"}>{text}</div>
  );
}

export default function OpButton({ op, label, onClick, danger = false, disabled = false, children }) {
  const running = Boolean(op?.running);
  const elapsed = running && op?.startedAt ? Date.now() - op.startedAt : null;

  return (
    <div className="dp-op">
      <button
        type="button"
        className={danger ? "dp-danger" : undefined}
        onClick={onClick}
        disabled={running || disabled}
        title={running ? "Операція вже виконується" : undefined}
      >
        {label}
        {running ? ` … ${formatExecutionTime(elapsed)}` : ""}
      </button>

      {running ? (
        <>
          <ProgressBar pct={op.pct} />
          <div className="dp-op-msg">
            {typeof op.pct === "number" ? `${op.pct}% · ` : ""}
            {op.msg || "виконується…"}
          </div>
        </>
      ) : null}

      {!running && op?.error ? <ErrorBox text={op.error} /> : null}

      {!running && !op?.error && op?.finishedAt ? (
        <div className="dp-op-msg dp-ok">
          завершено за {formatExecutionTime(op.durationMs)}
        </div>
      ) : null}

      {children}
    </div>
  );
}
