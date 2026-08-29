/**
 * Вікно підказки. Людина в цю мить дивиться в ІНШУ програму, а не сюди,
 * тому все підпорядковано трьом речам:
 *   1) поточний крок читається за секунду і краєм ока — він тут найбільший;
 *   2) видно, де ми в послідовності, — інакше незрозуміло, скільки ще терпіти;
 *   3) під час очікування зору попередній крок ЛИШАЄТЬСЯ на екрані, а внизу
 *      йде смужка з часом і кнопкою «Скасувати»: порожнеча читалась би як зависання.
 */
import { useEffect, useMemo } from "react";
import { useWalkthrough } from "./useWalkthrough";
import { describeState } from "./states";
import "./walkthrough.css";

/** «12,3 с» — кома, бо інтерфейс український. */
const seconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1).replace(".", ",")} с`;

/** Після цього часу очікування додаємо пояснення, чому так довго. */
const LONG_WAIT_MS = 8000;

/**
 * Номер кроку для людини. Контракт не каже, з нуля чи з одиниці рахує бекенд,
 * тому показ витримує обидва варіанти: нуль читаємо як перший крок.
 */
function humanStep(stepIndex) {
  const n = Number.isFinite(stepIndex) ? stepIndex : 0;
  return n <= 0 ? 1 : n;
}

/** Смужка послідовності: скільки позаду, скільки лишилось. */
function StepTrack({ stepIndex, totalSteps }) {
  const current = humanStep(stepIndex);
  const total = Number.isFinite(totalSteps) && totalSteps > 0 ? totalSteps : null;

  if (!total) {
    // Плану немає — чесно кажемо «крок N», не вигадуючи знаменника.
    return (
      <div className="wt-track" aria-label={`Крок ${current}`}>
        <span className="wt-track-label">Крок {current}</span>
        <span className="wt-track-open" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className="wt-track"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={Math.min(current, total)}
      aria-label={`Крок ${current} з ${total}`}
    >
      <span className="wt-track-label">
        Крок {Math.min(current, total)} з {total}
      </span>
      <span className="wt-track-bar">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className="wt-seg" data-done={i < current ? "true" : "false"} />
        ))}
      </span>
    </div>
  );
}

/** Рядок очікування: час іде, видно що саме робимо, є вихід. */
function WaitStrip({ text, progressMsg, elapsedMs, timeoutSec, model, onCancel }) {
  const long = elapsedMs >= LONG_WAIT_MS;
  return (
    <div className="wt-wait" aria-live="polite">
      <div className="wt-wait-row">
        <span className="wt-wait-text">{progressMsg || text}</span>
        <span className="wt-wait-time">{seconds(elapsedMs)}</span>
      </div>
      <div className="wt-bar" aria-hidden="true">
        <div className="wt-bar-fill" />
      </div>
      {long ? (
        <p className="wt-wait-why">
          {model ? `Модель ${model} ` : "Модель зору "}
          дивиться на знімок локально. Це нормально: буває до {timeoutSec} с.
        </p>
      ) : null}
      <button type="button" className="wt-btn wt-btn-quiet" onClick={onCancel}>
        Скасувати
      </button>
    </div>
  );
}

/** Помилка або нереалізована частина — словами, з дією, а не порожній екран. */
function FailureView({ error, onRetry, onClose }) {
  return (
    <div className="wt-failure" role="alert">
      <h1 className="wt-title">{error.title}</h1>
      <p className="wt-hint">{error.hint}</p>
      {error.detail ? <p className="wt-detail">{error.detail}</p> : null}
      <div className="wt-actions">
        <button type="button" className="wt-btn wt-btn-main" onClick={onRetry}>
          Спробувати ще раз
        </button>
        <button type="button" className="wt-btn wt-btn-quiet" onClick={onClose}>
          Закрити
        </button>
      </div>
    </div>
  );
}

export default function WalkthroughPanel({ request, embedded = false, onClose }) {
  const wt = useWalkthrough(request);
  const { phase, step, error, config } = wt;

  // Сесія починається сама: вікно відкрили саме заради неї.
  useEffect(() => {
    if (request) wt.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.appId]);

  const descriptor = useMemo(() => (step ? describeState(step.state) : null), [step]);
  const appName = wt.session?.appName || request?.appName || "";
  const busy = phase === "busy";

  const close = () => {
    wt.finish();
    onClose?.();
  };

  if (!request) {
    return (
      <section className={embedded ? "wt wt-embedded" : "wt"}>
        <div className="wt-failure">
          <h1 className="wt-title">Немає що показувати</h1>
          <p className="wt-hint">
            Вікно підказки відкрилося без завдання. Поверніться в пошук і натисніть
            «Показати як» біля потрібної програми.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={embedded ? "wt wt-embedded" : "wt"}
      data-tone={descriptor ? descriptor.tone : "go"}
      data-phase={phase}
      data-state={step?.state || ""}
      aria-label="Покрокова підказка"
    >
      <header className="wt-head">
        <span className="wt-app" title={appName}>
          {appName || "Підказка"}
        </span>
        {step?.source === "plan" ? <span className="wt-chip">за планом</span> : null}
        <button
          type="button"
          className="wt-close"
          aria-label="Завершити підказку"
          onClick={close}
        >
          ✕
        </button>
      </header>

      {step ? <StepTrack stepIndex={step.stepIndex} totalSteps={step.totalSteps} /> : null}

      {phase === "error" && error ? (
        <FailureView error={error} onRetry={() => (wt.session ? wt.retry() : wt.start())} onClose={close} />
      ) : null}

      {phase === "finished" ? (
        <div className="wt-failure">
          <h1 className="wt-title">Підказку завершено</h1>
          <p className="wt-hint">Знімки екрана цієї сесії бекенд прибрав.</p>
        </div>
      ) : null}

      {phase !== "error" && phase !== "finished" ? (
        <div className="wt-body">
          {/* Під час очікування попередній крок навмисно лишається видимим,
              лише притлумленим: людина бачить, що вікно живе, а не зависло. */}
          {step && descriptor ? (
            <div className="wt-step" data-dim={busy ? "true" : "false"}>
              {descriptor.title ? <h1 className="wt-title">{descriptor.title}</h1> : null}
              <p className="wt-instruction">{step.instruction || "Крок без опису."}</p>
              {step.target?.label ? (
                <p className="wt-target">Шукайте: {step.target.label}</p>
              ) : null}
              {descriptor.hint ? <p className="wt-hint">{descriptor.hint}</p> : null}
              {step.state === "wrong_window" && wt.frontmost ? (
                <p className="wt-hint">Зараз попереду: {wt.frontmost}.</p>
              ) : null}
            </div>
          ) : null}

          {!step && !busy ? <p className="wt-hint">Готуємо підказку…</p> : null}
          {wt.note ? <p className="wt-note">{wt.note}</p> : null}

          {busy ? (
            <WaitStrip
              text={wt.busyText}
              progressMsg={wt.progress.msg}
              elapsedMs={wt.elapsedMs}
              timeoutSec={config.visionTimeoutSec}
              model={config.visionModel}
              onCancel={wt.cancel}
            />
          ) : (
            <div className="wt-actions">
              {descriptor ? (
                <button
                  type="button"
                  className="wt-btn wt-btn-main"
                  onClick={() => wt.runAction(descriptor.primary.action)}
                >
                  {descriptor.primary.label}
                </button>
              ) : null}
              {wt.note && !step ? (
                <button type="button" className="wt-btn wt-btn-quiet" onClick={() => wt.start()}>
                  Спробувати ще раз
                </button>
              ) : null}
            </div>
          )}

          {/* Головний спосіб урятувати сесію, коли модель показала не те.
              Тому він на видноті, а не сховано в меню. */}
          {descriptor?.showStuck && !busy ? (
            <button type="button" className="wt-btn wt-btn-stuck" onClick={wt.stuck}>
              Я не бачу цієї кнопки
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
