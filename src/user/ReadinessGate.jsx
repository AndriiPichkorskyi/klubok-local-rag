/**
 * Екран «система ще не готова» (модуль 2.1 з боку користувача).
 *
 * Показуємо рівно те, що віддав `bootstrap.check`: список `actions` — це і є
 * інструкція, складена бекендом. Вигадувати свої формулювання тут не можна,
 * інакше два джерела правди розійдуться.
 *
 * Кнопка «Все одно спробувати» існує навмисно: якщо сама перевірка не вдалася
 * (немає зв'язку з sidecar), людина не мусить лишатися замкненою на цьому екрані.
 */
import { humanizeError } from "./useSearch";

/** Смужка завантаження моделі: відсотки або «біжуча», коли їх немає. */
function PullBar({ pull }) {
  if (!pull) return null;
  const hasPct = typeof pull.pct === "number" && pull.pct >= 0 && pull.pct <= 100;

  if (pull.error) {
    return <p className="sp-note">Не вдалося завантажити {pull.model}: {pull.error}</p>;
  }

  return (
    <div className="sp-progress" aria-live="polite">
      <div className="sp-progress-row">
        <span className="sp-progress-msg">{pull.msg || `Завантаження ${pull.model}…`}</span>
        <span className="sp-progress-time">{hasPct ? `${Math.round(pull.pct)}%` : ""}</span>
      </div>
      <div className="sp-bar" role="progressbar" aria-label="Завантаження моделі">
        <div
          className={hasPct ? "sp-bar-fill" : "sp-bar-fill is-indeterminate"}
          style={hasPct ? { width: `${pull.pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

export default function ReadinessGate({ phase, report, error, pull, onRecheck, onPull, onDismiss }) {
  if (phase === "starting" || phase === "checking") {
    return (
      <section className="sp-progress" aria-live="polite">
        <div className="sp-progress-row">
          <span className="sp-progress-msg">
            {phase === "starting" ? "Запускаємо бекенд…" : "Перевіряємо, чи все на місці…"}
          </span>
        </div>
        <div className="sp-bar" role="progressbar" aria-label="Перевірка оточення">
          <div className="sp-bar-fill is-indeterminate" />
        </div>
        {phase === "starting" ? (
          <span className="sp-note">Перший запуск після встановлення буває повільнішим.</span>
        ) : null}
      </section>
    );
  }

  // Перевірка не відбулася взагалі — це поломка мосту, а не відсутня модель.
  if (phase === "failed") {
    const human = humanizeError(error);
    return (
      <section className="sp-error" role="alert">
        <h2>{human.title}</h2>
        <p>{human.hint}</p>
        <div className="sp-progress-actions">
          <button type="button" className="btn-primary" onClick={onRecheck}>
            Перевірити ще раз
          </button>
          <button type="button" className="btn-text" onClick={onDismiss}>
            Все одно спробувати
          </button>
        </div>
      </section>
    );
  }

  const missingRequired = report?.models?.missingRequired || [];
  const missingOptional = report?.models?.missingOptional || [];
  const busy = Boolean(pull && !pull.error);

  return (
    <section className="sp-error" role="alert">
      <h2>Система ще не готова</h2>

      {report?.actions?.length ? (
        <ul>
          {report.actions.map((action, index) => (
            <li key={index}>{action}</li>
          ))}
        </ul>
      ) : (
        <p>Бекенд не пояснив причину. Спробуйте перевірити ще раз.</p>
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
              Завантажити {model}
            </button>
          ))}
          {missingOptional.map((model) => (
            <button key={model} type="button" disabled={busy} onClick={() => onPull(model)}>
              Завантажити {model} (необов'язково)
            </button>
          ))}
        </div>
      ) : null}

      <div className="sp-progress-actions">
        <button type="button" disabled={busy} onClick={onRecheck}>
          Перевірити ще раз
        </button>
        <button type="button" className="btn-text" disabled={busy} onClick={onDismiss}>
          Все одно спробувати
        </button>
      </div>

      <p className="sp-note">
        Перевірку робить модуль первинної ініціалізації: ОС, Ollama і моделі.
        Режим розробника (⌘D) показує ту саму перевірку в подробицях.
      </p>
    </section>
  );
}
