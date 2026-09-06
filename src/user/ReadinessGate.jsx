/**
 * Екран «система ще не готова» (модуль 2.1 з боку користувача).
 *
 * Станів два, і вони різні. `blocked` — бракує оточення (ОС, Ollama, моделі), і
 * тут ми показуємо рівно те, що сказав бекенд. `novectors` — оточення в порядку,
 * але для обраної моделі ембедингу немає векторної бази; це не поломка, а вибір:
 * побудувати зараз або свідомо шукати за ключовими словами. Мовчки віддавати
 * FTS замість пошуку за змістом не можна — система виглядала б робочою.
 *
 * Показуємо рівно те, що віддав `bootstrap.check`: список `actions` — це і є
 * інструкція, складена бекендом. Вигадувати свої формулювання тут не можна,
 * інакше два джерела правди розійдуться.
 *
 * Кнопка «Все одно спробувати» існує навмисно: якщо сама перевірка не вдалася
 * (немає зв'язку з sidecar), людина не мусить лишатися замкненою на цьому екрані.
 */
import { humanizeError } from "./useSearch";
import { useTranslation } from "react-i18next";

/** Смужка завантаження моделі: відсотки або «біжуча», коли їх немає. */
function PullBar({ pull }) {
  const { t } = useTranslation();
  if (!pull) return null;
  const hasPct = typeof pull.pct === "number" && pull.pct >= 0 && pull.pct <= 100;

  if (pull.error) {
    return (
      <div className="sp-note">
        <p>{t("readiness.pullFailed", { model: pull.model })}</p>
        <details><summary>{t("common.technicalDetails")}</summary><p>{pull.error}</p></details>
      </div>
    );
  }

  return (
    <div className="sp-progress" aria-live="polite">
      <div className="sp-progress-row">
        <span className="sp-progress-msg">{t("readiness.pulling", { model: pull.model })}</span>
        <span className="sp-progress-time">{hasPct ? `${Math.round(pull.pct)}%` : ""}</span>
      </div>
      <div className="sp-bar" role="progressbar" aria-label={t("readiness.pullLabel")}>
        <div
          className={hasPct ? "sp-bar-fill" : "sp-bar-fill is-indeterminate"}
          style={hasPct ? { width: `${pull.pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

/** Смужка побудови векторної бази: та сама подача, що й у завантаження моделі. */
function BuildBar({ build, onCancel }) {
  const { t } = useTranslation();
  if (!build) return null;
  const hasPct = typeof build.pct === "number" && build.pct >= 0 && build.pct <= 100;

  if (build.error) {
    return (
      <div className="sp-note">
        <p>{t("readiness.vectorsFailed")}</p>
        <details>
          <summary>{t("common.technicalDetails")}</summary>
          <p>{build.error}</p>
        </details>
      </div>
    );
  }
  if (build.cancelled) return <p className="sp-note">{t("readiness.vectorsCancelled")}</p>;
  if (build.empty) return <p className="sp-note">{t("readiness.vectorsEmpty")}</p>;

  return (
    <div className="sp-progress" aria-live="polite">
      <div className="sp-progress-row">
        <span className="sp-progress-msg">{build.msg || t("readiness.vectorsBuilding")}</span>
        <span className="sp-progress-time">{hasPct ? `${Math.round(build.pct)}%` : ""}</span>
      </div>
      <div className="sp-bar" role="progressbar" aria-label={t("readiness.vectorsBuildLabel")}>
        <div
          className={hasPct ? "sp-bar-fill" : "sp-bar-fill is-indeterminate"}
          style={hasPct ? { width: `${build.pct}%` } : undefined}
        />
      </div>
      <div className="sp-progress-actions">
        <button type="button" onClick={onCancel}>
          {t("readiness.vectorsCancel")}
        </button>
      </div>
    </div>
  );
}

export default function ReadinessGate({
  phase,
  report,
  error,
  pull,
  vectors,
  build,
  onRecheck,
  onPull,
  onDismiss,
  onBuildVectors,
  onCancelBuild,
  onSkipVectors,
}) {
  const { t } = useTranslation();
  if (phase === "starting" || phase === "checking") {
    return (
      <section className="sp-progress" aria-live="polite">
        <div className="sp-progress-row">
          <span className="sp-progress-msg">
            {phase === "starting" ? t("readiness.starting") : t("readiness.checking")}
          </span>
        </div>
        <div className="sp-bar" role="progressbar" aria-label={t("readiness.environment")}>
          <div className="sp-bar-fill is-indeterminate" />
        </div>
        {phase === "starting" ? (
          <span className="sp-note">{t("readiness.startupNote")}</span>
        ) : null}
      </section>
    );
  }

  // Перевірка не відбулася взагалі — це поломка мосту, а не відсутня модель.
  if (phase === "failed") {
    const human = humanizeError(error, t);
    return (
      <section className="sp-error" role="alert">
        <h2>{human.title}</h2>
        <p>{human.hint}</p>
        <div className="sp-progress-actions">
          <button type="button" className="btn-primary" onClick={onRecheck}>
            {t("common.recheck")}
          </button>
          <button type="button" className="btn-text" onClick={onDismiss}>
            {t("readiness.dismiss")}
          </button>
        </div>
      </section>
    );
  }

  // Оточення готове, бракує лише векторів для обраної моделі.
  if (phase === "novectors") {
    const building = Boolean(build && !build.error && !build.cancelled && !build.empty);
    // Порожня база знань і відсутні вектори для однієї моделі — різні ситуації:
    // перша коштує годин і починається зі сканування програм, друга — лише
    // векторизації вже завантаженої довідки.
    const empty = vectors?.hasCorpus === false;
    // Перервана індексація — окремий випадок: база вже є, і мова не про
    // створення з нуля, а про продовження з місця зупинки.
    const partial = !empty && Boolean(vectors?.exists) && vectors?.complete === false;
    const model = vectors?.model || "";
    const counts = { model, done: vectors?.apps ?? 0, total: vectors?.appsTotal ?? 0 };
    const titleKey = empty
      ? "readiness.corpusTitle"
      : partial
        ? "readiness.vectorsPartialTitle"
        : "readiness.vectorsTitle";
    const bodyKey = empty
      ? "readiness.corpusBody"
      : partial
        ? "readiness.vectorsPartialBody"
        : "readiness.vectorsBody";
    return (
      <section className="sp-error" role="alert">
        <h2>{t(titleKey)}</h2>
        <p>{t(bodyKey, counts)}</p>

        <BuildBar build={build} onCancel={onCancelBuild} />

        <div className="sp-progress-actions">
          <button type="button" className="btn-primary" disabled={building} onClick={onBuildVectors}>
            {t(
              empty
                ? "readiness.corpusBuild"
                : partial
                  ? "readiness.vectorsResume"
                  : "readiness.vectorsBuild",
            )}
          </button>
          <button type="button" className="btn-text" disabled={building} onClick={onSkipVectors}>
            {t("readiness.vectorsSkip")}
          </button>
        </div>

        <p className="sp-note">
          {t(
            empty
              ? "readiness.corpusNote"
              : partial
                ? "readiness.vectorsPartialNote"
                : "readiness.vectorsNote",
          )}
        </p>
      </section>
    );
  }

  const missingRequired = report?.models?.missingRequired || [];
  const missingOptional = report?.models?.missingOptional || [];
  const busy = Boolean(pull && !pull.error);

  return (
    <section className="sp-error" role="alert">
      <h2>{t("readiness.title")}</h2>

      {report ? (
        <ul>
          {report?.platform?.supported === false ? <li>{t("readiness.platformUnsupported")}</li> : null}
          {report?.ollama?.isAvailable === false ? <li>{t("readiness.ollamaMissing")}</li> : null}
          {missingRequired.map((model) => <li key={`required-${model}`}>{t("readiness.requiredMissing", { model })}</li>)}
          {missingOptional.map((model) => <li key={`optional-${model}`}>{t("readiness.optionalMissing", { model })}</li>)}
        </ul>
      ) : (
        <p>{t("readiness.unexplained")}</p>
      )}

      <PullBar pull={pull} />

      {/* Модель можна дотягнути звідси: контракт дає для цього bootstrap.pullModel,
          і йти в термінал по «ollama pull» людині не треба. */}
      {report?.ollama?.isAvailable && (missingRequired.length || missingOptional.length) ? (
        <div className="sp-progress-actions">
          {missingRequired.map((model) => (
            <button
              key={model}
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => onPull(model)}
            >
              {t("readiness.pull", { model })}
            </button>
          ))}
          {missingOptional.map((model) => (
            <button key={model} type="button" disabled={busy} onClick={() => onPull(model)}>
              {t("readiness.pullOptional", { model })}
            </button>
          ))}
        </div>
      ) : null}

      <div className="sp-progress-actions">
        <button type="button" disabled={busy} onClick={onRecheck}>
          {t("common.recheck")}
        </button>
        <button type="button" className="btn-text" disabled={busy} onClick={onDismiss}>
          {t("readiness.dismiss")}
        </button>
      </div>

      <p className="sp-note">
        {t("readiness.note")}
      </p>
    </section>
  );
}
