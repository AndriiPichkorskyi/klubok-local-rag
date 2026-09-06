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
import { useMemo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import Section from "./Section";
import { ProgressBar, StopButton, CancelNote, TestPauseControls } from "./OpButton";
import { opState } from "./useDevRuntime";
import { useFullRun } from "./useFullRun";
import { buildPlan, defaultSelection, describeStepResult, testsFailed, PIPELINE_STEPS, TEST_STEPS } from "./fullRunPlan";
import { formatExecutionTime } from "./format";
import Checkbox from "./Checkbox";
import BenchmarkAxesForm from "./BenchmarkAxesForm";
import { formatLiveMetrics } from "./systemMetrics";
import { dt } from "./i18n";

/** Підпис і колір кожного стану кроку. Зупинка і помилка — навмисно різні. */
const STATUS_VIEW = {
  pending: { textKey: "fullRun.statuses.pending", className: "muted" },
  running: { textKey: "fullRun.statuses.running", className: "dp-warn" },
  done: { textKey: "fullRun.statuses.done", className: "dp-ok" },
  error: { textKey: "fullRun.statuses.error", className: "dp-err" },
  cancelled: { textKey: "fullRun.statuses.cancelled", className: "dp-warn" },
  skipped: { textKey: "fullRun.statuses.skipped", className: "muted" },
};

export default function FullRunSection({
  ops,
  run,
  cancelOp,
  pauseOp,
  resumeOp,
  testConcurrency = 1,
  note,
  embedModels,
  configModel,
  benchmark,
  onFinished,
  chatModels,
  configChatModel,
}) {
  const { i18n } = useTranslation();
  const [selection, setSelection] = useState(defaultSelection);
  const [models, setModels] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [selectedChat, setSelectedChat] = useState([]);
  const [concurrency, setConcurrency] = useState(() => Math.max(1, Number(testConcurrency) || 1));

  useEffect(() => {
    let unlisten;
    listen("metrics_tick", (event) => {
      setMetrics(event.payload);
    }).then(u => unlisten = u);
    return () => { if (unlisten) unlisten(); };
  }, []);
  
  const fullRun = useFullRun({ run, cancelOp, note, onFinished });
  const { entries, state, running, stopping, totalMs } = fullRun;
  const selectedConcurrency = Math.max(1, Math.trunc(Number(concurrency) || 1));
  const activeTestEntry = entries.find(
    (entry) =>
      entry.status === "running" &&
      (entry.method === "tests.run" || entry.method === "tests.runExternal"),
  );
  const activeTestOp = activeTestEntry ? opState(ops, activeTestEntry.key) : null;
  const concurrencyLocked = running && !activeTestOp?.paused;

  useEffect(() => {
    if (!running) setConcurrency(Math.max(1, Number(testConcurrency) || 1));
  }, [running, testConcurrency]);

  // Осі бенчмарку їдуть у кроки tests.* параметром: те, що людина бачить у
  // формі, і те, чим піде прогін, — один і той самий об'єкт.
  const plan = useMemo(
    () =>
      buildPlan(
        selection,
        models,
        configModel,
        { axes: benchmark?.axesParam || null, concurrency: selectedConcurrency },
        selectedChat,
        configChatModel,
      ),
    [
      selection,
      models,
      configModel,
      benchmark?.axesParam,
      selectedConcurrency,
      selectedChat,
      configChatModel,
      i18n.resolvedLanguage,
    ],
  );

  // Запобіжник maxModes спрацював саме на тому тесті, який обрано? Тоді
  // прогін не починаємо взагалі: інакше пайплайн відпрацював би годину, а
  // тести впали б із помилкою в кінці.
  const blockedTests = TEST_STEPS.filter(
    (step) => selection.tests[step.id] && benchmark?.blockedFor?.(step.kind),
  );
  const axesInvalid = Boolean(benchmark?.hasFieldErrors);
  const startBlocked = blockedTests.length > 0 || axesInvalid;

  const toggleStep = (id) =>
    setSelection((prev) => ({ ...prev, steps: { ...prev.steps, [id]: !prev.steps[id] } }));
  const toggleTest = (id) =>
    setSelection((prev) => ({ ...prev, tests: { ...prev.tests, [id]: !prev.tests[id] } }));
  const toggleModel = (model) =>
    setModels((prev) =>
      prev.includes(model) ? prev.filter((item) => item !== model) : prev.concat(model),
    );
  const toggleChatModel = (model) =>
    setSelectedChat((prev) =>
      prev.includes(model) ? prev.filter((item) => item !== model) : prev.concat(model),
    );

  // Кожна пара «embed × chat» — окремий виклик tests.* (див. buildPlan), тож
  // саме на це число множиться ціна прогону в оцінці часу.
  const modelPairs = Math.max(1, models.length) * Math.max(1, selectedChat?.length || 0);

  const rows = running || state !== "idle" ? entries : plan.map((step) => ({ ...step, status: "pending" }));
  const doneCount = entries.filter((entry) => entry.status === "done").length;

  return (
    <Section
      title={dt("fullRun.title")}
      hint={metrics && running ? dt("fullRun.runningMetrics", { metrics: formatLiveMetrics(metrics) }) : dt("fullRun.hint")}
    >
      {/* Чотири набори прапорців — це вибір ЩО запускати, тому вони стоять
          поруч колонками, а не тягнуться в один рядок із переносами: у вузькій
          панелі перенесені прапорці зливались в одну кашу без видимих меж. */}
      <div className="dp-picker">
        <fieldset className="dp-picker-group">
          <legend className="dp-picker-title">{dt("fullRun.pipelineSteps")}</legend>
          <div className="dp-picker-list">
            {PIPELINE_STEPS.map((step) => (
              <Checkbox
                key={step.id}
                checked={Boolean(selection.steps[step.id])}
                onChange={() => toggleStep(step.id)}
                disabled={running}
              >
                {dt(step.labelKey)}
              </Checkbox>
            ))}
          </div>
        </fieldset>

        <fieldset className="dp-picker-group">
          <legend className="dp-picker-title">{dt("fullRun.embedModels")}</legend>
          <div className="dp-picker-list">
            {embedModels.map((model) => (
              <Checkbox
                key={model}
                checked={models.includes(model)}
                onChange={() => toggleModel(model)}
                disabled={running}
                hint={model === configModel ? dt("common.fromConfig") : null}
              >
                {model}
              </Checkbox>
            ))}
          </div>
          <div className="dp-picker-foot muted dp-small">
            {models.length === 0
              ? dt("fullRun.nothingConfig")
              : dt("fullRun.vectorAndTests")}
          </div>
        </fieldset>

        <fieldset className="dp-picker-group">
          <legend className="dp-picker-title">{dt("fullRun.chatModels")}</legend>
          <div className="dp-picker-list">
            {chatModels?.map((model) => (
              <Checkbox
                key={model}
                checked={selectedChat.includes(model)}
                onChange={() => toggleChatModel(model)}
                disabled={running}
                hint={model === configChatModel ? dt("common.fromConfig") : null}
              >
                {model}
              </Checkbox>
            ))}
          </div>
          <div className="dp-picker-foot muted dp-small">
            {selectedChat.length === 0 ? dt("fullRun.nothingConfig") : dt("fullRun.testsOnly")}
          </div>
        </fieldset>

        <fieldset className="dp-picker-group">
          <legend className="dp-picker-title">{dt("fullRun.testsAfter")}</legend>
          <div className="dp-picker-list">
            {TEST_STEPS.map((step) => (
              <Checkbox
                key={step.id}
                checked={Boolean(selection.tests[step.id])}
                onChange={() => toggleTest(step.id)}
                disabled={running}
              >
                {dt(step.labelKey)}
              </Checkbox>
            ))}
          </div>
          <div className="dp-picker-foot muted dp-small">
            {modelPairs > 1
              ? dt("fullRun.eachTest", { count: modelPairs })
              : dt("fullRun.configModels")}
          </div>
        </fieldset>
      </div>

      <div className="dp-test-controls">
        <label className="row dp-test-concurrency">
          <span>{dt("fullRun.concurrency")}</span>
          <input
            type="number"
            min="1"
            step="1"
            value={concurrency}
            disabled={concurrencyLocked}
            onChange={(event) =>
              setConcurrency(Math.max(1, Math.trunc(Number(event.target.value) || 1)))
            }
          />
        </label>
        <span className="muted dp-small">{dt("fullRun.concurrencyNote")}</span>
      </div>

      {/* Осі бенчмарку. Секція прогону — саме те місце, де їх задають перед ніччю. */}
      {benchmark ? (
        <BenchmarkAxesForm benchmark={benchmark} disabled={running} runMultiplier={modelPairs} />
      ) : null}

      {startBlocked ? (
        <div className="dp-alert">
          {axesInvalid
            ? dt("fullRun.invalidAxes")
            : dt("fullRun.blocked", { tests: blockedTests.map((step) => dt(step.labelKey)).join(dt("fullRun.and")) })}
        </div>
      ) : null}

      <div className="row">
        <button
          type="button"
          onClick={() => fullRun.start(plan)}
          disabled={running || plan.length === 0 || startBlocked}
        >
          {running
            ? activeTestOp?.paused
              ? dt("fullRun.testPaused", { time: formatExecutionTime(totalMs), current: doneCount + 1, total: entries.length })
              : dt("fullRun.runActive", { time: formatExecutionTime(totalMs), current: doneCount + 1, total: entries.length })
            : dt("fullRun.start", { count: plan.length })}
        </button>
        {activeTestEntry && activeTestOp ? (
          <TestPauseControls
            op={activeTestOp}
            onPause={() => pauseOp?.(activeTestEntry.key)}
            onResume={(nextConcurrency) => resumeOp?.(activeTestEntry.key, nextConcurrency)}
            defaultConcurrency={selectedConcurrency}
          />
        ) : null}
        {running ? (
          <button type="button" className="dp-danger" onClick={fullRun.stop} disabled={stopping}>
            {dt(stopping ? "fullRun.stopping" : "fullRun.stopAll")}
          </button>
        ) : null}
        {plan.length === 0 ? <span className="muted dp-small">{dt("fullRun.noSteps")}</span> : null}
      </div>

      {running && !activeTestEntry && plan.some((entry) => entry.method.startsWith("tests.")) ? (
        <div className="muted dp-small">
          {dt("fullRun.pauseLater")}
        </div>
      ) : null}

      {stopping ? (
        <div className="dp-op-msg dp-warn">
          {dt("fullRun.stopNotice")}
        </div>
      ) : null}

      <ol className="dp-steps">
        {rows.map((entry, index) => {
          const op = opState(ops, entry.key);
          const view = STATUS_VIEW[entry.status] || STATUS_VIEW.pending;
          const isTest = entry.method === "tests.run" || entry.method === "tests.runExternal";
          return (
            <li key={entry.key} className="dp-step">
              <div className="row dp-step-head">
                <span className="dp-step-num">{index + 1}</span>
                <span className="dp-step-label">{entry.label}</span>
                <span className={`dp-small ${view.className}`}>{dt(view.textKey)}</span>
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
                    {op.msg || dt("operation.running")}
                  </div>
                  <StopButton
                    op={op}
                    onCancel={() => fullRun.stop()}
                    label={isTest ? dt("tests.finish") : dt("operation.stop")}
                  />
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
                    {dt("fullRun.cancelledByUser")}{entry.error ? ` · ${entry.error}` : ""}
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
          <div className="dp-scroll-x">
            <table className="dp-table">
              <thead>
                <tr>
                  <th>{dt("fullRun.headers.step")}</th><th>{dt("fullRun.headers.status")}</th>
                  <th>{dt("fullRun.headers.time")}</th><th>{dt("fullRun.headers.result")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const view = STATUS_VIEW[entry.status] || STATUS_VIEW.pending;
                  const failedTests = entry.status === "done" && testsFailed(entry.method, entry.result);
                  return (
                    <tr key={entry.key}>
                      <td>{entry.label}</td>
                      <td className={view.className}>{dt(view.textKey)}</td>
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
                              ? `${dt("fullRun.cancelledByUser")}${
                                  entry.result === undefined
                                    ? ""
                                    : ` · ${dt("fullRun.managedPartial", { result: describeStepResult(entry.method, entry.result).join(" · ") })}`
                                }`
                              : dt("fullRun.statuses.skipped")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="muted dp-small">
            {dt("fullRun.managedStats")}
          </div>
        </div>
      ) : null}
    </Section>
  );
}
