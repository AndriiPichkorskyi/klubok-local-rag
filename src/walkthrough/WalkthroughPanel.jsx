/**
 * Вікно підказки. Людина в цю мить дивиться в ІНШУ програму, а не сюди,
 * тому все підпорядковано трьом речам:
 *   1) поточний крок читається за секунду і краєм ока — він тут найбільший;
 *   2) видно, де ми в послідовності, — інакше незрозуміло, скільки ще терпіти;
 *   3) під час очікування зору попередній крок ЛИШАЄТЬСЯ на екрані, а внизу
 *      йде смужка з часом і кнопкою «Скасувати»: порожнеча читалась би як зависання.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWalkthrough } from "./useWalkthrough";
import { describeState } from "./states";
import DebugPanel from "./DebugPanel";
import { DRAG_REGION, NO_DRAG } from "./windowPosition";
import "./walkthrough.css";

/** Чи розгорнуто режим розробника — пам'ятаємо між сесіями, як і положення. */
const DEBUG_OPEN_KEY = "walkthrough.debugOpen";
/** Те саме для списку кроків довідки: звичка людини переживає сесію. */
const PLAN_OPEN_KEY = "walkthrough.planOpen";

function readDebugOpen() {
  try {
    return localStorage.getItem(DEBUG_OPEN_KEY) === "1";
  } catch {
    return false; // сховища немає — за замовчуванням згорнуто
  }
}

function writeDebugOpen(open) {
  try {
    localStorage.setItem(DEBUG_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* нема де запам'ятати — переживемо */
  }
}

/** Список кроків у ручному режимі розгорнутий за замовчуванням: він і є суть
    цього режиму — весь шлях видно одразу, а не по рядку крізь замкову шпарину. */
function readPlanOpen() {
  try {
    return localStorage.getItem(PLAN_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writePlanOpen(open) {
  try {
    localStorage.setItem(PLAN_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* те саме: без сховища просто не запам'ятається */
  }
}

/** «12,3 с» — кома, бо інтерфейс український. */
const seconds = (ms, language) => new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.max(0, ms) / 1000);

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
function StepTrack({ stepIndex, totalSteps, planIndex }) {
  const { t } = useTranslation();
  // У ручному режимі позиція в списку довідки чесніша за наскрізний лічильник:
  // після перемикання посеред сесії `stepIndex` уже великий, а список читається
  // з першого пункту, і «крок 7 з 3» не сказало б людині нічого.
  const current = Number.isFinite(planIndex) ? planIndex + 1 : humanStep(stepIndex);
  const total = Number.isFinite(totalSteps) && totalSteps > 0 ? totalSteps : null;

  if (!total) {
    // Плану немає — чесно кажемо «крок N», не вигадуючи знаменника.
    return (
      <div className="wt-track" aria-label={t("walkthrough.step", { current })}>
        <span className="wt-track-label">{t("walkthrough.step", { current })}</span>
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
      aria-label={t("walkthrough.stepOf", { current, total })}
    >
      <span className="wt-track-label">
        {t("walkthrough.stepOf", { current: Math.min(current, total), total })}
      </span>
      <span className="wt-track-bar">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className="wt-seg" data-done={i < current ? "true" : "false"} />
        ))}
      </span>
    </div>
  );
}

/**
 * Стрілки по кроках навколо смужки послідовності.
 *
 * Назад — коли є куди: пройдений крок завжди можна перечитати. Уперед — лише
 * там, де наступний крок УЖЕ існує: у ручному режимі це наступний пункт
 * відомого списку, у режимі зору — лише те, що вже показували. Порожня
 * стрілка вимкнена, а не схована: так видно, що межа є, і де саме вона.
 */
function StepArrows({ children, canBack, canForward, forwardTitle, onGo, index }) {
  const { t } = useTranslation();
  return (
    <div className="wt-trackrow">
      <button
        type="button"
        className="wt-nav-btn"
        disabled={!canBack}
        title={t("walkthrough.previousStep")}
        aria-label={t("walkthrough.previousStep")}
        onClick={() => onGo(index - 1)}
      >
        ‹
      </button>
      {children}
      <button
        type="button"
        className="wt-nav-btn"
        disabled={!canForward}
        title={forwardTitle}
        aria-label={t("walkthrough.nextStep")}
        onClick={() => onGo(index + 1)}
      >
        ›
      </button>
    </div>
  );
}

/**
 * Весь список кроків із довідки. У ручному режимі він відомий наперед цілком,
 * і ховати його немає підстав: людина бачить, скільки лишилось, і може
 * повернутись до будь-якого пункту одним натисканням — без знімка, без моделі
 * і без нового рядка в історії сесії.
 */
function PlanList({ steps, index, passed, open, busy, onToggle, onGo }) {
  const { t } = useTranslation();
  return (
    <div className="wt-plan">
      <button
        type="button"
        className="wt-plan-toggle"
        aria-expanded={open}
        aria-controls="wt-plan-list"
        onClick={onToggle}
      >
        {open ? `${t("walkthrough.allSteps")} ▾` : `${t("walkthrough.allSteps")} ▸ (${steps.length})`}
      </button>
      {open ? (
        <ol className="wt-plan-list" id="wt-plan-list">
          {steps.map((text, i) => (
            <li key={`${i}-${text}`}>
              <button
                type="button"
                className="wt-plan-item"
                data-at={i === index ? "true" : "false"}
                data-done={i < passed ? "true" : "false"}
                aria-current={i === index ? "step" : undefined}
                disabled={busy}
                onClick={() => onGo(i)}
              >
                <span className="wt-plan-num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="wt-plan-text">{text}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Рядок очікування: час іде, видно що саме робимо, є вихід. */
function WaitStrip({ text, progressMsg, elapsedMs, timeoutSec, model, onCancel }) {
  const { t, i18n } = useTranslation();
  const long = elapsedMs >= LONG_WAIT_MS;
  return (
    <div className="wt-wait" aria-live="polite">
      <div className="wt-wait-row">
        <span className="wt-wait-text">{progressMsg || text}</span>
        <span className="wt-wait-time">{t("common.seconds", { value: seconds(elapsedMs, i18n.language) })}</span>
      </div>
      <div className="wt-bar" aria-hidden="true">
        <div className="wt-bar-fill" />
      </div>
      {long ? (
        <p className="wt-wait-why">
          {t("walkthrough.localVisionWait", { model: model || (i18n.language.startsWith("uk") ? "зору" : "vision"), seconds: timeoutSec })}
        </p>
      ) : null}
      <button type="button" className="wt-btn wt-btn-quiet" onClick={onCancel}>
        {t("common.cancel")}
      </button>
    </div>
  );
}

/** Помилка або нереалізована частина — словами, з дією, а не порожній екран. */
function FailureView({ error, onRetry, onClose }) {
  const { t } = useTranslation();
  return (
    <div className="wt-failure" role="alert">
      <h1 className="wt-title">{error.title}</h1>
      <p className="wt-hint">{error.hint}</p>
      {error.detail ? <details className="wt-detail"><summary>{t("common.technicalDetails")}</summary><p>{error.detail}</p></details> : null}
      <div className="wt-actions">
        <button type="button" className="wt-btn wt-btn-main" onClick={onRetry}>
          {t("common.retry")}
        </button>
        <button type="button" className="wt-btn wt-btn-quiet" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

export default function WalkthroughPanel({ request, embedded = false, onClose }) {
  const { t } = useTranslation();
  const [debugOpen, setDebugOpen] = useState(readDebugOpen);
  const [planOpen, setPlanOpen] = useState(readPlanOpen);
  // Перемикач «сире» вмикає не лише панель: із ним кожен крок просить у бекенда
  // блок діагностики явно (`debug: true`), і конфіг для цього чіпати не треба.
  const wt = useWalkthrough(request, { debug: debugOpen });
  const { phase, error, config } = wt;

  // Смуга заголовка тягне вікно. Атрибут ставимо лише в окремому вікні: у
  // вбудованому вигляді ця ж панель поїхала б разом із головним вікном.
  const dragProps = embedded
    ? {}
    : { "data-tauri-drag-region": DRAG_REGION, title: t("walkthrough.drag") };

  // Сесія починається сама: вікно відкрили саме заради неї.
  useEffect(() => {
    if (request) wt.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.appId]);

  /**
   * Крок, який зараз на екрані: живий або той, який людина гортає назад.
   * Живий крок лишається окремо (`wt.step`) — на ньому тримаються діагностика
   * й історія, і перегляд пройденого їх не чіпає.
   */
  const shown = wt.shownStep;
  const descriptor = useMemo(() => (shown ? describeState(shown.state, t) : null), [shown, t]);
  const appName = wt.session?.appName || request?.appName || "";
  const busy = phase === "busy";
  /** Ручний режим: кроки зі списку довідки, зір не задіяний узагалі. */
  const manual = wt.stepSource === "plan";
  /** Що модель відповіла про ПОПЕРЕДНІЙ крок. null — її про це не питали. */
  const progress = shown?.progress || null;
  /** Список кроків довідки: у ручному режимі відомий наперед і цілком. */
  const plan = manual && Array.isArray(wt.session?.planned) ? wt.session.planned : [];
  /**
   * Уперед можна лише туди, де крок УЖЕ є: у ручному режимі це наступний
   * пункт списку, у режимі зору — тільки те, що вже показували. Наступного
   * кроку зору ще не існує, і кнопка «вперед» його не вигадає.
   */
  const planCount = plan.length || (Number.isFinite(shown?.totalSteps) ? shown.totalSteps : 0);
  const canForward = wt.canForward || (manual && wt.cursor + 1 < planCount);

  const close = () => {
    wt.finish();
    onClose?.();
  };

  const togglePlan = () => {
    setPlanOpen((open) => {
      writePlanOpen(!open);
      return !open;
    });
  };

  const toggleDebug = () => {
    setDebugOpen((open) => {
      writeDebugOpen(!open);
      return !open;
    });
  };

  if (!request) {
    return (
      <section className={embedded ? "wt wt-embedded" : "wt"}>
        <header className="wt-head" {...dragProps}>
          {embedded ? null : <span className="wt-grip" aria-hidden="true" />}
          <span className="wt-app">{t("walkthrough.hint")}</span>
        </header>
        <div className="wt-failure">
          <h1 className="wt-title">{t("walkthrough.emptyTitle")}</h1>
          <p className="wt-hint">{t("walkthrough.emptyText")}</p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={embedded ? "wt wt-embedded" : "wt"}
      data-tone={descriptor ? descriptor.tone : "go"}
      data-phase={phase}
      data-state={shown?.state || ""}
      aria-label={t("walkthrough.emptyTitle")}
    >
      {/* Смуга заголовка: за неї вікно тягнеться (data-tauri-drag-region).
          Кнопки на ній лишаються натискними — скрипт Tauri сам не тягне вікно
          за клікабельні елементи, а ми ще й вимикаємо перетягування явно. */}
      <header className="wt-head" {...dragProps}>
        {embedded ? null : <span className="wt-grip" aria-hidden="true" />}
        <span className="wt-app" title={appName}>
          {appName || t("walkthrough.hint")}
        </span>
        {/* Перемикач режиму САМЕ ТУТ, а не лише в конфізі: коли зір застряг,
            перемикатись треба посеред сесії, а не перезапускати її з правкою
            файла. Пройдені кроки при цьому лишаються — сесія на бекенді та сама. */}
        <button
          type="button"
          className="wt-mode"
          data-mode={manual ? "plan" : "vision"}
          data-tauri-drag-region={NO_DRAG}
          aria-pressed={manual}
          disabled={busy || !wt.session}
          title={
            manual
              ? t("walkthrough.modePlanTitle")
              : t("walkthrough.modeVisionTitle")
          }
          onClick={() => wt.switchMode(manual ? "vision" : "plan")}
        >
          {manual ? t("walkthrough.modePlan") : t("walkthrough.modeVision")}
        </button>
        <button
          type="button"
          className="wt-dev"
          data-tauri-drag-region={NO_DRAG}
          aria-expanded={debugOpen}
          aria-controls="wt-debug"
          title="Режим розробника: сирі дані кроку"
          onClick={toggleDebug}
        >
          {debugOpen ? "сире ▾" : "сире ▸"}
        </button>
        <button
          type="button"
          className="wt-close"
          data-tauri-drag-region={NO_DRAG}
          aria-label={t("walkthrough.finishGuide")}
          onClick={close}
        >
          ✕
        </button>
      </header>

      {/* Смужка послідовності зі стрілками обабіч: крок ліворуч — назад,
          праворуч — уперед. Перехід між уже показаними кроками нічого не
          коштує: ні знімка, ні звернення до бекенда, ні рядка в історії. */}
      {shown ? (
        <StepArrows
          index={wt.cursor}
          canBack={wt.canBack && !busy}
          canForward={canForward && !busy}
          forwardTitle={
            manual
              ? t("walkthrough.nextPlan")
              : t("walkthrough.nextKnown")
          }
          onGo={wt.goToStep}
        >
          <StepTrack
            stepIndex={shown.stepIndex}
            totalSteps={shown.totalSteps}
            planIndex={shown.planIndex}
          />
        </StepArrows>
      ) : null}

      {phase === "error" && error ? (
        <FailureView error={error} onRetry={() => (wt.session ? wt.retry() : wt.start())} onClose={close} />
      ) : null}

      {phase === "finished" ? (
        <div className="wt-failure">
          <h1 className="wt-title">{t("walkthrough.finishedTitle")}</h1>
          <p className="wt-hint">{t("walkthrough.finishedText")}</p>
        </div>
      ) : null}

      {phase !== "error" && phase !== "finished" ? (
        <div className="wt-body">
          {/* Під час очікування попередній крок навмисно лишається видимим,
              лише притлумленим: людина бачить, що вікно живе, а не зависло. */}
          {shown && descriptor ? (
            <div className="wt-step" data-dim={busy ? "true" : "false"}>
              {descriptor.title ? <h1 className="wt-title">{descriptor.title}</h1> : null}
              <p className="wt-instruction">{shown.instruction || t("walkthrough.noInstruction")}</p>
              {shown.target?.label ? (
                <p className="wt-target">{t("walkthrough.lookFor", { target: shown.target.label })}</p>
              ) : null}
              {/* Ручний режим бере це з довідки: орієнтир замість рамки, бо
                  на екран у цьому режимі ніхто не дивиться. */}
              {shown.expect ? <p className="wt-expect">{t("walkthrough.expect", { expect: shown.expect })}</p> : null}
              {descriptor.hint ? <p className="wt-hint">{descriptor.hint}</p> : null}
              {/* Пряма відповідь моделі на пряме питання про попередній крок.
                  Показуємо лише «не бачу виконання»: підтверджене просування і
                  так видно з того, що інструкція змінилась. */}
              {progress?.done === false ? (
                <p className="wt-progress" data-done="false">
                  {t("walkthrough.previousNotDone", { detail: progress.note ? `: ${progress.note}` : "." })}
                </p>
              ) : null}
              {shown.state === "wrong_window" && wt.frontmost ? (
                <p className="wt-hint">{t("walkthrough.frontmost", { app: wt.frontmost })}</p>
              ) : null}
            </div>
          ) : null}

          {/* Перегляд пройденого — окремий стан вікна, і про нього треба
              сказати прямо: інакше здається, що сесія поїхала назад. Вона не
              поїхала: крок сесії лишився там, де був. */}
          {wt.reviewing ? (
            <p className="wt-review">
              {t("walkthrough.reviewing")}
            </p>
          ) : null}

          {!shown && !busy ? <p className="wt-hint">{t("walkthrough.preparing")}</p> : null}
          {wt.note ? <p className="wt-note">{wt.note}</p> : null}

          {/* Скільки разів вікно ходило до зору. У ручному режимі — нуль, і це
              головне число цього шляху, тому воно на видноті, а не в діагностиці. */}
          {manual ? (
            <p className="wt-mode-note">
              {wt.visionCalls > 0
                ? t("walkthrough.manualUsed", { count: wt.visionCalls })
                : t("walkthrough.manualNone")}
            </p>
          ) : null}

          {busy ? (
            <WaitStrip
              text={wt.busyText}
              progressMsg={wt.progress.msg}
              elapsedMs={wt.elapsedMs}
              timeoutSec={config.visionTimeoutSec}
              model={config.visionModel}
              onCancel={wt.cancel}
            />
          ) : wt.reviewing && !manual ? (
            /* Режим зору: з пройденого кроку нікуди вести — знімок має
               відповідати тому, що зараз на екрані. Тому єдина дія — назад
               до поточного кроку. */
            <div className="wt-actions">
              <button type="button" className="wt-btn wt-btn-main" onClick={wt.backToCurrent}>
                {t("walkthrough.backCurrent")}
              </button>
            </div>
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
              {/* Останнє слово людини. Вона дивиться на свій екран, а модель —
                  на знімок 1280 пікселів завширшки: коли вони розходяться,
                  права людина, і сесія рухається за нею. У ручному режимі
                  кнопки немає — там кожне «далі» і є підтвердженням. */}
              {descriptor?.showConfirm && !manual && !wt.reviewing ? (
                <button
                  type="button"
                  className="wt-btn wt-btn-confirm"
                  title={t("walkthrough.confirmTitle")}
                  onClick={wt.confirmDone}
                >
                  {t("walkthrough.confirm")}
                </button>
              ) : null}
              {/* Ручний режим: «Далі» веде списком, тож із перегляду можна не
                  йти пішки, а повернутись до поточного кроку одним рухом. */}
              {wt.reviewing ? (
                <button type="button" className="wt-btn wt-btn-quiet" onClick={wt.backToCurrent}>
                  {t("walkthrough.current")}
                </button>
              ) : null}
              {wt.note && !shown ? (
                <button type="button" className="wt-btn wt-btn-quiet" onClick={() => wt.start()}>
                  {t("common.retry")}
                </button>
              ) : null}
            </div>
          )}

          {/* Головний спосіб урятувати сесію, коли модель показала не те.
              Тому він на видноті, а не сховано в меню. */}
          {descriptor?.showStuck && !busy && !manual && !wt.reviewing ? (
            <button type="button" className="wt-btn wt-btn-stuck" onClick={wt.stuck}>
              {t("walkthrough.stuck")}
            </button>
          ) : null}
          {/* Весь шлях одразу — головне, чого бракувало ручному режимові:
              список кроків відомий наперед, і тримати його від людини не було
              підстав. Натискання на пункт — перехід без знімка і без моделі. */}
          {manual && plan.length > 0 ? (
            <PlanList
              steps={plan}
              index={wt.cursor}
              passed={wt.track.length}
              open={planOpen}
              busy={busy}
              onToggle={togglePlan}
              onGo={wt.goToStep}
            />
          ) : null}
        </div>
      ) : null}

      {/* Поза гілками фаз навмисно: сирі дані потрібні саме тоді, коли крок
          не вийшов, і після завершення сесії — щоб було що прочитати. */}
      {debugOpen ? (
        <div id="wt-debug">
          <DebugPanel
            history={wt.history}
            config={{ ...config, stepSource: wt.stepSource }}
            request={request}
            asked
          />
        </div>
      ) : null}
    </section>
  );
}
