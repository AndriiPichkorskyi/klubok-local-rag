/**
 * Модуль 2.4.2 — панель розробника.
 * Порт термінального меню sidecar/src/cli/index.js у React: склад пунктів той самий,
 * змінена лише подача. Усі виклики бекенда йдуть виключно через src/ipc.js.
 *
 * Головна вимога: інтерфейс не блокується ніколи. Довгі методи (векторизація,
 * тести) стартують у useDevRuntime і живуть у стані; поки вони йдуть, решта
 * панелі повністю робоча, а прогрес видно у спільному журналі праворуч.
 */
import { useCallback, useMemo, useState } from "react";
import { useDevRuntime } from "./useDevRuntime";
import ProgressLog from "./ProgressLog";
import SidecarSection from "./SidecarSection";
import PipelineSection from "./PipelineSection";
import StatsSection from "./StatsSection";
import ClearSection from "./ClearSection";
import TestsSection from "./TestsSection";
import ReportsSection from "./ReportsSection";
import ConfigSection from "./ConfigSection";
import "./dev.css";

/** Резерв на випадок, якщо конфіг ще не приїхав або в ньому немає списку моделей. */
const FALLBACK_EMBED_MODELS = ["qwen3-embedding:0.6b", "qwen3-embedding:4b"];

/** Моделі ембедингу з конфіга: required + optional, лише embedding-моделі. */
function embedModelsOf(config) {
  const declared = [
    ...(config?.bootstrap?.requiredModels || []),
    ...(config?.bootstrap?.optionalModels || []),
  ].filter((model) => model.includes("embedding"));

  const list = declared.length > 0 ? declared : FALLBACK_EMBED_MODELS;
  const current = config?.embedModelName;
  return current && !list.includes(current) ? [current, ...list] : list;
}

export default function DevPanel() {
  const { ops, run, note, anyRunning, runningCount, logEntries, clearLog } = useDevRuntime();
  const [reportsRefresh, setReportsRefresh] = useState(0);

  // Актуальний конфіг — те, що повернув останній із config.get / config.reload.
  const config = useMemo(() => {
    const get = ops["config.get"];
    const reload = ops["config.reload"];
    const newest =
      (reload?.finishedAt || 0) > (get?.finishedAt || 0) ? reload : get;
    return newest?.result && typeof newest.result === "object" ? newest.result : null;
  }, [ops]);

  const embedModels = useMemo(() => embedModelsOf(config), [config]);
  const onTestsFinished = useCallback(() => setReportsRefresh((value) => value + 1), []);

  return (
    <main className="dp-root">
      <header className="dp-head">
        <span className="dp-title">Панель розробника</span>
        <span className="row dp-small muted">
          {anyRunning ? (
            <span className="dp-warn">виконується операцій: {runningCount}</span>
          ) : (
            <span>операцій не виконується</span>
          )}
          <span className="dp-badge">⌘D — режим користувача</span>
        </span>
      </header>

      <div className="dp-body">
        <div className="dp-col">
          <SidecarSection ops={ops} run={run} note={note} />
          <PipelineSection ops={ops} run={run} note={note} embedModels={embedModels} />
          <StatsSection ops={ops} run={run} />
          <TestsSection ops={ops} run={run} onFinished={onTestsFinished} />
          <ReportsSection ops={ops} run={run} refreshKey={reportsRefresh} />
          <ClearSection ops={ops} run={run} />
          <ConfigSection ops={ops} run={run} config={config} />
        </div>

        <div className="dp-col" style={{ overflowY: "hidden" }}>
          <ProgressLog entries={logEntries} onClear={clearLog} />
        </div>
      </div>
    </main>
  );
}
