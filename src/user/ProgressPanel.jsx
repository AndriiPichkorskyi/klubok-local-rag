/**
 * Живий прогрес пошуку. Пошук триває секунди, іноді десятки секунд —
 * людина мусить бачити поточний крок, час і мати кнопку скасування.
 */

/** Форматує мілісекунди як «12,3 с». */
function formatSeconds(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1).replace(".", ",")} с`;
}

export default function ProgressPanel({ msg, pct, elapsedMs, onCancel }) {
  const hasPct = typeof pct === "number" && pct >= 0 && pct <= 100;

  return (
    <section className="sp-progress" aria-live="polite">
      <div className="sp-progress-row">
        <span className="sp-progress-msg">{msg || "Шукаємо…"}</span>
        <span className="sp-progress-time">{formatSeconds(elapsedMs)}</span>
      </div>

      <div
        className="sp-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasPct ? Math.round(pct) : undefined}
        aria-label="Хід пошуку"
      >
        <div
          className={hasPct ? "sp-bar-fill" : "sp-bar-fill is-indeterminate"}
          style={hasPct ? { width: `${pct}%` } : undefined}
        />
      </div>

      <div className="sp-progress-actions">
        <button type="button" onClick={onCancel}>
          Скасувати (Esc)
        </button>
        <span className="sp-note">
          Модель працює локально, перший запит після запуску буває повільним.
        </span>
      </div>
    </section>
  );
}
