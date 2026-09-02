/**
 * Кнопка однієї операції разом з її живим прогресом і кнопкою «Стоп».
 * Поки операція виконується — кнопка запуску неактивна (повторний запуск
 * заборонено), решта панелі при цьому лишається робочою.
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

/**
 * Кнопка зупинки. Стоїть поруч із кожною запущеною операцією.
 * Серверний id показуємо тут же: саме його приймає job.cancel, і поки першої
 * події прогресу не було — його немає, про що чесно й написано.
 */
export function StopButton({ op, onCancel, label = "Стоп" }) {
  if (!onCancel || !op?.running) return null;
  return (
    <div className="dp-stop-row">
      <button type="button" className="dp-danger dp-small" onClick={onCancel} disabled={Boolean(op.cancelling)}>
        {op.cancelling ? "Завершую…" : label}
      </button>
      <span className="dp-op-msg">
        {typeof op.rpcId === "number"
          ? `job.cancel · id ${op.rpcId}`
          : "серверний id ще невідомий"}
      </span>
    </div>
  );
}

/** Пауза тестів і продовження з кількістю потоків, обраною в інтерфейсі. */
export function TestPauseControls({ op, onPause, onResume, defaultConcurrency = 1 }) {
  if (!op?.running || !onPause || !onResume) return null;
  const normalConcurrency = Math.max(1, Number(defaultConcurrency ?? op.testConcurrency) || 1);

  if (!op.paused) {
    return (
      <div className="dp-stop-row">
        <button type="button" className="dp-small" onClick={onPause} disabled={Boolean(op.pausing)}>
          {op.pausing ? "Ставлю на паузу…" : "Пауза"}
        </button>
        <span className="dp-op-msg">активні запити спершу завершаться</span>
      </div>
    );
  }

  return (
    <div className="dp-stop-row">
      <button
        type="button"
        className="dp-small"
        onClick={() => onResume(normalConcurrency)}
        disabled={Boolean(op.resuming)}
      >
        {op.resuming ? "Продовжую…" : `Продовжити ×${normalConcurrency}`}
      </button>
      <span className="dp-op-msg">тести на паузі</span>
    </div>
  );
}

/** Підсумок спроби зупинки: бекенд може чесно відповісти, що не скасував. */
export function CancelNote({ op }) {
  if (!op?.cancelRequested || op.cancelling) return null;
  if (op.cancelAck) return <div className="dp-op-msg dp-warn">скасування прийнято бекендом</div>;
  return (
    <div className="dp-op-msg dp-err">
      зупинити не вдалося{op.cancelReason ? `: ${op.cancelReason}` : ""}
    </div>
  );
}

export default function OpButton({
  op,
  label,
  onClick,
  onCancel,
  onPause,
  onResume,
  stopLabel = "Стоп",
  defaultConcurrency = 1,
  danger = false,
  disabled = false,
  children,
}) {
  const running = Boolean(op?.running);
  const elapsed = running && op?.startedAt ? Date.now() - op.startedAt : null;
  const cancelled = !running && op?.status === "cancelled";

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
          <TestPauseControls
            op={op}
            onPause={onPause}
            onResume={onResume}
            defaultConcurrency={defaultConcurrency}
          />
          <StopButton op={op} onCancel={onCancel} label={stopLabel} />
          <CancelNote op={op} />
          {op.controlReason ? <div className="dp-op-msg dp-err">{op.controlReason}</div> : null}
        </>
      ) : null}

      {/* Зупинено користувачем і впало саме — різні речі й виглядають по-різному. */}
      {cancelled ? (
        <ErrorBox
          kind="info"
          text={`Зупинено користувачем${op.cancelledText ? ` · ${op.cancelledText}` : ""}`}
        />
      ) : null}

      {!running && op?.error ? <ErrorBox text={op.error} /> : null}

      {!running && !op?.error && !cancelled && op?.finishedAt ? (
        <div className="dp-op-msg dp-ok">
          завершено за {formatExecutionTime(op.durationMs)}
        </div>
      ) : null}

      {children}
    </div>
  );
}
