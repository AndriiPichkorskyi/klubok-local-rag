/**
 * Повний прогін: пайплайн + тести одним запуском.
 *
 * Навіщо: нічне оновлення бази триває годинами, і зранку людина мусить бачити
 * повну картину — що саме зробив кожен крок, скільки він тривав і чим
 * закінчились тести. Раніше після 38-хвилинного прогону єдиним способом
 * дізнатися, чи векторизувалась друга модель, був прямий запит до бази.
 *
 * Послідовність виконує useFullRun.js звичайними викликами pipeline.* і tests.*.
 */
import { useMemo, useState } from "react";
import Section from "./Section";
import { ProgressBar, StopButton, CancelNote } from "./OpButton";
import { opState } from "./useDevRuntime";
import { useFullRun } from "./useFullRun";
import { buildPlan, defaultSelection, describeStepResult, testsFailed, PIPELINE_STEPS, TEST_STEPS } from "./fullRunPlan";
import { formatExecutionTime } from "./format";

/** Підпис і колір кожного стану кроку. Зупинка і помилка — навмисно різні. */
const STATUS_VIEW = {
  pending: { text: "очікує", className: "muted" },
  running: { text: "виконується", className: "dp-warn" },
  done: { text: "готово", className: "dp-ok" },
  error: { text: "помилка", className: "dp-err" },
  cancelled: { text: "зупинено", className: "dp-warn" },
  skipped: { text: "не виконувався", className: "muted" },
};

const RUN_STATE_VIEW = {
  done: { text: "Прогін завершено: усі кроки виконано", className: "dp-ok" },
  failed: { text: "Прогін зупинено помилкою", className: "dp-err" },
  cancelled: { text: "Прогін зупинено користувачем", className: "dp-warn" },
};

/** Українська множина: 1 крок, 2 кроки, 5 кроків. */
function stepsWord(count) {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return "кроків";
  const last = count % 10;
  if (last === 1) return "крок";
  if (last >= 2 && last <= 4) return "кроки";
  return "кроків";
}

function Checkbox({ checked, onChange, disabled, children }) {
  return (
    <label className="row dp-check">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      {children}
    </label>
  );
}

export default function FullRunSection({ ops, run, cancelOp, note, embedModels, configModel, onFinished }) {
  const [selection, setSelection] = useState(defaultSelection);
  const [models, setModels] = useState([]);

  const fullRun = useFullRun({ run, cancelOp, note, onFinished });
  const { entries, state, running, stopping, totalMs } = fullRun;

  const plan = useMemo(
    () => buildPlan(selection, models, configModel),
    [selection, models, configModel],
  );

  const toggleStep = (id) =>
    setSelection((prev) => ({ ...prev, steps: { ...prev.steps, [id]: !prev.steps[id] } }));
  const toggleTest = (id) =>
    setSelection((prev) => ({ ...prev, tests: { ...prev.tests, [id]: !prev.tests[id] } }));
  const toggleModel = (model) =>
    setModels((prev) =>
      prev.includes(model) ? prev.filter((item) => item !== model) : prev.concat(model),
    );

  const rows = running || state !== "idle" ? entries : plan.map((step) => ({ ...step, status: "pending" }));
  const runView = RUN_STATE_VIEW[state];
  const doneCount = entries.filter((entry) => entry.status === "done").length;

  return (
    <Section
      title="Повний прогін (пайплайн + тести)"
      hint="кроки йдуть послідовно, кожен наступний — лише після успіху попереднього"
    >
      <div className="dp-check-group">
        <span className="muted dp-small">Кроки пайплайна:</span>
        {PIPELINE_STEPS.map((step) => (
          <Checkbox
            key={step.id}
            checked={Boolean(selection.steps[step.id])}
            onChange={() => toggleStep(step.id)}
            disabled={running}
          >
            {step.label}
          </Checkbox>
        ))}
      </div>

      <div className="dp-check-group">
        <span className="muted dp-small">Моделі для векторизації:</span>
        {embedModels.map((model) => (
          <Checkbox
            key={model}
            checked={models.includes(model)}
            onChange={() => toggleModel(model)}
            disabled={running || !selection.steps.vectors}
          >
            {model}
            {model === configModel ? " (з конфіга)" : ""}
          </Checkbox>
        ))}
        {models.length === 0 ? (
          <span className="muted dp-small">нічого не обрано — модель з конфіга</span>
        ) : null}
      </div>

      <div className="dp-check-group">
        <span className="muted dp-small">Тести після пайплайна:</span>
        {TEST_STEPS.map((step) => (
          <Checkbox
            key={step.id}
            checked={Boolean(selection.tests[step.id])}
            onChange={() => toggleTest(step.id)}
            disabled={running}
          >
            {step.label}
          </Checkbox>
        ))}
      </div>

      <div className="row">
        <button type="button" onClick={() => fullRun.start(plan)} disabled={running || plan.length === 0}>
          {running
            ? `Прогін триває… ${formatExecutionTime(totalMs)} · крок ${doneCount + 1} з ${entries.length}`
            : `Запустити прогін (${plan.length} ${stepsWord(plan.length)} поспіль)`}
        </button>
        {running ? (
          <button type="button" className="dp-danger" onClick={fullRun.stop} disabled={stopping}>
            {stopping ? "Зупиняю послідовність…" : "Стоп (уся послідовність)"}
          </button>
        ) : null}
        {plan.length === 0 ? <span className="muted dp-small">не обрано жодного кроку</span> : null}
      </div>

      {stopping ? (
        <div className="dp-op-msg dp-warn">
          Наступні кроки не почнуться. Поточний крок бекенд перериває лише якщо job.cancel
          підтвердив скасування — інакше він дійде до кінця, і це видно в його рядку.
        </div>
      ) : null}

      <ol className="dp-steps">
        {rows.map((entry, index) => {
          const op = opState(ops, entry.key);
          const view = STATUS_VIEW[entry.status] || STATUS_VIEW.pending;
          return (
            <li key={entry.key} className="dp-step">
              <div className="row dp-step-head">
                <span className="dp-step-num">{index + 1}</span>
                <span className="dp-step-label">{entry.label}</span>
                <span className={`dp-small ${view.className}`}>{view.text}</span>
                {entry.durationMs !== null && entry.durationMs !== undefined ? (
                  <span className="muted dp-small">{formatExecutionTime(entry.durationMs)}</span>
                ) : null}
                <span className="dp-badge">{entry.method}</span>
              </div>

              {entry.warn ? <div className="dp-op-msg dp-warn">{entry.warn}</div> : null}

              {entry.status === "running" ? (
                <>
                  <ProgressBar pct={op.pct} />
                  <div className="dp-op-msg">
                    {typeof op.pct === "number" ? `${op.pct}% · ` : ""}
                    {op.msg || "виконується…"}
                  </div>
                  <StopButton op={op} onCancel={() => fullRun.stop()} />
                  <CancelNote op={op} />
                </>
              ) : null}

              {entry.status === "done"
                ? describeStepResult(entry.method, entry.result).map((line) => (
                    <div key={line} className="dp-op-msg dp-ok">
                      {line}
                    </div>
                  ))
                : null}

              {entry.status === "error" ? <div className="dp-alert">{entry.error}</div> : null}

              {entry.status === "cancelled" ? (
                <>
                  <div className="dp-alert dp-alert-info">
                    Зупинено користувачем{entry.error ? ` · ${entry.error}` : ""}
                  </div>
                  {/* Скасований крок повертає те, що встигло зробитися — показуємо. */}
                  {entry.result !== undefined
                    ? describeStepResult(entry.method, entry.result).map((line) => (
                        <div key={line} className="dp-op-msg">
                          {line}
                        </div>
                      ))
                    : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Підсумок прогону — те, що людина читає зранку. */}
      {state !== "idle" && !running ? (
        <div className="dp-summary">
          <div className={`dp-summary-head ${runView?.className || ""}`}>
            {runView?.text || "Прогін"} · загальний час {formatExecutionTime(totalMs)}
          </div>

          <div className="dp-scroll-x">
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Крок</th>
                  <th>Стан</th>
                  <th>Час</th>
                  <th>Що зроблено</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const view = STATUS_VIEW[entry.status] || STATUS_VIEW.pending;
                  const failedTests = entry.status === "done" && testsFailed(entry.method, entry.result);
                  return (
                    <tr key={entry.key}>
                      <td>{entry.label}</td>
                      <td className={view.className}>{view.text}</td>
                      <td className="dp-num">
                        {entry.durationMs === null || entry.durationMs === undefined
                          ? "—"
                          : formatExecutionTime(entry.durationMs)}
                      </td>
                      <td style={{ whiteSpace: "normal" }} className={failedTests ? "dp-warn" : undefined}>
                        {entry.status === "done"
                          ? describeStepResult(entry.method, entry.result).join(" · ")
                          : entry.status === "error"
                            ? entry.error
                            : entry.status === "cancelled"
                              ? `зупинено користувачем${
                                  entry.result === undefined
                                    ? ""
                                    : ` · встигло: ${describeStepResult(entry.method, entry.result).join(" · ")}`
                                }`
                              : "не виконувався"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="muted dp-small">
            Статус готовності моделей — у секції «Статистика бази»: вона оновлюється
            автоматично після кожного прогону.
          </div>
        </div>
      ) : null}
    </Section>
  );
}
