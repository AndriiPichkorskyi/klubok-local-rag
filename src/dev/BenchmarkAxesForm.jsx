/**
 * Осі бенчмарку в панелі розробника.
 *
 * Навіщо. Досі кожен експеримент починався з правки `config/pipeline.config.json`
 * і перезапуску. Тут ті самі осі задаються полями, а незаданe береться з конфіга —
 * і, головне, поруч одразу видно ціну: скільки режимів, скільки запитів до LLM
 * і скільки це триватиме. Нічний прогін планують до запуску, а не після.
 *
 * Мінімалізм навмисний: жодних UI-бібліотек, лише прапорці, поле вводу і
 * змінні з ui.css / dev.css.
 *
 * Файл називається …Form, а не …Axes, навмисно: чиста логіка живе в
 * `benchmarkAxes.js`, а файлова система macOS не розрізняє регістр — два імені,
 * що відрізняються лише ним, збірник розв'язав би в один і той самий файл.
 */
import { AXIS_FIELDS, formatDurationLong, pluralize } from "./benchmarkAxes";
import { BENCHMARK_KINDS } from "./useBenchmarkAxes";

/** Один рядок ціни: «8 режимів × 153 кейси = 1224 прогони ≈ 1 год». */
function PlanRow({ kind, plan, planning }) {
  if (!plan) {
    return (
      <div className="row dp-plan-row" data-plan={kind.id}>
        <span className="dp-plan-name">{kind.label}</span>
        <span className="muted dp-small">{planning ? "рахуємо…" : "план ще не отримано"}</span>
      </div>
    );
  }

  const modesWord = pluralize(plan.modeCount, "режим", "режими", "режимів");
  const casesWord = pluralize(plan.caseCount, "кейс", "кейси", "кейсів");
  const runsWord = pluralize(plan.totalRuns, "прогін", "прогони", "прогонів");

  return (
    <>
      <div className="row dp-plan-row" data-plan={kind.id}>
        <span className="dp-plan-name">{kind.label}</span>
        <span className={plan.blocked ? "dp-err" : undefined}>
          {plan.modeCount} {modesWord} × {plan.caseCount} {casesWord} ={" "}
          <b>{plan.totalRuns}</b> {runsWord} LLM
        </span>
        <span className="dp-badge">≈ {formatDurationLong(plan.estimate?.totalMs)}</span>
        {planning ? <span className="muted dp-small">оновлюємо…</span> : null}
      </div>
      {plan.blocked ? <div className="dp-alert">{plan.blockedReason}</div> : null}
    </>
  );
}

/**
 * Компактне зведення ціни — для секцій, де форми осей немає (наприклад,
 * «Тестування»): кнопка запускає ту саму матрицю, тож її ціна має бути видна
 * і там, а не лише поруч із полями.
 */
export function BenchmarkPlanSummary({ benchmark, note = null }) {
  return (
    <div className="dp-plan">
      {BENCHMARK_KINDS.map((kind) => (
        <PlanRow
          key={kind.id}
          kind={kind}
          plan={benchmark.plans[kind.id]}
          planning={benchmark.planning}
        />
      ))}
      {benchmark.planError ? <div className="dp-alert">{benchmark.planError}</div> : null}
      {note ? <div className="muted dp-small">{note}</div> : null}
    </div>
  );
}

export default function BenchmarkAxesForm({ benchmark, disabled = false }) {
  const estimate = benchmark.plans.rag?.estimate || benchmark.plans.external?.estimate || null;

  return (
    <div className="dp-axes-block">
      <div className="row dp-axes-head">
        <span className="muted dp-small">
          Осі бенчмарку (те, що не змінено, береться з config → rag.benchmark.axes):
        </span>
        <button
          type="button"
          className="dp-small"
          onClick={benchmark.resetAll}
          disabled={disabled || benchmark.changedCount === 0}
        >
          Усе з конфіга
        </button>
      </div>

      <div className="dp-axes">
        {AXIS_FIELDS.map((field) => {
          const values = benchmark.axes[field.id] || [];
          const error = benchmark.fieldErrors[field.id];
          const fromConfig = benchmark.isFromConfig(field.id);
          return (
            <div className="dp-axis" data-axis={field.id} key={field.id}>
              <div className="row dp-axis-head">
                <span className="dp-axis-name">{field.label}</span>
                {fromConfig ? (
                  <span className="dp-badge">з конфіга</span>
                ) : (
                  <button
                    type="button"
                    className="dp-small"
                    onClick={() => benchmark.resetAxis(field.id)}
                    disabled={disabled}
                  >
                    ↩ з конфіга
                  </button>
                )}
              </div>

              {field.type === "choice" ? (
                <div className="dp-check-group">
                  {field.options.map((option) => (
                    <label className="row dp-check" key={String(option.value)}>
                      <input
                        type="checkbox"
                        checked={values.includes(option.value)}
                        onChange={() => benchmark.toggleValue(field.id, option.value)}
                        disabled={disabled}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              ) : (
                <input
                  type="text"
                  className="dp-axis-input"
                  aria-label={field.label}
                  placeholder={field.placeholder}
                  value={benchmark.textOf(field.id)}
                  onChange={(event) => benchmark.setListText(field.id, event.target.value)}
                  disabled={disabled}
                />
              )}

              <div className={`dp-axis-hint ${error ? "dp-err" : "muted"}`}>
                {error || field.hint || ""}
              </div>
            </div>
          );
        })}
      </div>

      <BenchmarkPlanSummary
        benchmark={benchmark}
        note={
          estimate
            ? `Оцінка часу: ${Math.round(estimate.msPerRun / 100) / 10} с на прогін ` +
              `(${estimate.source}, ${estimate.concurrency} паралельних запити). ` +
              `Осі йдуть у tests.run / tests.runExternal параметром axes; ` +
              `у звіт вони лягають цілком, тож режим завжди видно з самого файлу.`
            : null
        }
      />
    </div>
  );
}
