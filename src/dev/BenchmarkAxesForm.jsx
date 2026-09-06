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
import Checkbox from "./Checkbox";
import { AXIS_FIELDS, formatDurationLong } from "./benchmarkAxes";
import { BENCHMARK_KINDS } from "./useBenchmarkAxes";
import { dt } from "./i18n";

/**
 * Один рядок ціни: «8 режимів × 68 кейсів = 544 прогони ≈ 1 год».
 *
 * `multiplier` — скільки РАЗІВ цей тест піде в прогоні. Бекенд у `tests.plan`
 * рахує ціну одного прогону (режими × кейси) і про вибір моделей не знає: у
 * повному прогоні кожна пара «embed × chat» — це окремий виклик tests.*, тож
 * без множника оцінка часу брехала б у стільки разів, скільки обрано пар.
 */
function PlanRow({ kind, plan, planning, multiplier = 1 }) {
  if (!plan) {
    return (
      <div className="row dp-plan-row" data-plan={kind.id}>
        <span className="dp-plan-name">{dt(kind.labelKey)}</span>
        <span className="muted dp-small">{dt(planning ? "benchmark.calculating" : "benchmark.noPlan")}</span>
      </div>
    );
  }

  const times = Math.max(1, Math.trunc(multiplier) || 1);
  const totalRuns = plan.totalRuns * times;
  const totalMs =
    typeof plan.estimate?.totalMs === "number" ? plan.estimate.totalMs * times : undefined;

  const modesWord = dt("benchmark.modes");
  const casesWord = dt("benchmark.cases");
  const runsWord = dt("benchmark.runs");

  return (
    <>
      <div className="row dp-plan-row" data-plan={kind.id}>
        <span className="dp-plan-name">{dt(kind.labelKey)}</span>
        <span className={plan.blocked ? "dp-err" : undefined}>
          {plan.modeCount} {modesWord} × {plan.caseCount} {casesWord}
          {times > 1 ? ` × ${dt("benchmark.modelPairs", { count: times })}` : ""} ={" "}
          <b>{totalRuns}</b> {runsWord} LLM
        </span>
        <span className="dp-badge">≈ {formatDurationLong(totalMs)}</span>
        {planning ? <span className="muted dp-small">{dt("benchmark.updating")}</span> : null}
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
export function BenchmarkPlanSummary({ benchmark, note = null, runMultiplier = 1 }) {
  return (
    <div className="dp-plan">
      {BENCHMARK_KINDS.map((kind) => (
        <PlanRow
          key={kind.id}
          kind={kind}
          plan={benchmark.plans[kind.id]}
          planning={benchmark.planning}
          multiplier={runMultiplier}
        />
      ))}
      {benchmark.planError ? <div className="dp-alert">{benchmark.planError}</div> : null}
      {note ? <div className="muted dp-small">{note}</div> : null}
    </div>
  );
}

export default function BenchmarkAxesForm({ benchmark, disabled = false, runMultiplier = 1 }) {
  const estimate = benchmark.plans.rag?.estimate || benchmark.plans.external?.estimate || null;

  return (
    <div className="dp-axes-block">
      <div className="row dp-axes-head">
        <span className="muted dp-small">
          {dt("benchmark.axes")}
        </span>
        <button
          type="button"
          className="dp-small"
          onClick={benchmark.resetAll}
          disabled={disabled || benchmark.changedCount === 0}
        >
          {dt("benchmark.allFromConfig")}
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
                <span className="dp-axis-name">{dt(field.labelKey)}</span>
                {fromConfig ? (
                  <span className="dp-badge">{dt("benchmark.fromConfig")}</span>
                ) : (
                  <button
                    type="button"
                    className="dp-small"
                    onClick={() => benchmark.resetAxis(field.id)}
                    disabled={disabled}
                  >
                    {dt("benchmark.resetFromConfig")}
                  </button>
                )}
              </div>

              {field.type === "choice" ? (
                <div className="dp-check-group">
                  {field.options.map((option) => (
                    <Checkbox
                      key={String(option.value)}
                      checked={values.includes(option.value)}
                      onChange={() => benchmark.toggleValue(field.id, option.value)}
                      disabled={disabled}
                    >
                      {option.labelKey ? dt(option.labelKey) : option.label}
                    </Checkbox>
                  ))}
                </div>
              ) : (
                <input
                  type="text"
                  className="dp-axis-input"
                  aria-label={dt(field.labelKey)}
                  placeholder={field.placeholder}
                  value={benchmark.textOf(field.id)}
                  onChange={(event) => benchmark.setListText(field.id, event.target.value)}
                  disabled={disabled}
                />
              )}

              <div className={`dp-axis-hint ${error ? "dp-err" : "muted"}`}>
                {error || (field.hintKey ? dt(field.hintKey) : field.hint) || ""}
              </div>
            </div>
          );
        })}
      </div>

      <BenchmarkPlanSummary
        benchmark={benchmark}
        runMultiplier={runMultiplier}
        note={
          estimate
            ? dt("benchmark.estimate", {
                seconds: Math.round(estimate.msPerRun / 100) / 10,
                source: estimate.source,
                concurrency: estimate.concurrency,
              })
            : null
        }
      />
    </div>
  );
}
