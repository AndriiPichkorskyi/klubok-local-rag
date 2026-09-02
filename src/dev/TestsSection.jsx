/**
 * Тестування — пункти «🤖 RAG Benchmark» і «🧬 EXTERNAL тестування» з CLI.
 * Обидва методи довгі; прогрес іде у спільний журнал, панель лишається живою.
 */
import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";
import { BenchmarkPlanSummary } from "./BenchmarkAxesForm";

function verdict(result) {
  if (result && typeof result === "object") {
    const { ok, totalCases, passed, failed, passRate } = result;
    const parts = [];
    if (Number.isFinite(passed) && Number.isFinite(totalCases)) {
      parts.push(`пройдено ${passed} з ${totalCases}`);
    }
    if (Number.isFinite(failed) && failed > 0) parts.push(`провалено ${failed}`);
    if (Number.isFinite(passRate)) parts.push(`${passRate}%`);
    return {
      text: parts.length ? parts.join(" · ") : JSON.stringify(result),
      className: ok ? "dp-ok" : "dp-warn",
    };
  }
  if (result === true) return { text: "усі кейси пройдено", className: "dp-ok" };
  if (result === false) return { text: "є провалені кейси — дивіться звіт", className: "dp-warn" };
  return null;
}

export default function TestsSection({
  ops,
  run,
  cancelOp,
  pauseOp,
  resumeOp,
  testConcurrency = 1,
  benchmark,
  onFinished,
}) {
  const [metrics, setMetrics] = useState(null);
  const [concurrency, setConcurrency] = useState(() => Math.max(1, Number(testConcurrency) || 1));

  useEffect(() => {
    let unlisten;
    listen("metrics_tick", (event) => {
      setMetrics(event.payload);
    }).then(u => unlisten = u);
    return () => {
      if (unlisten) unlisten();
    };
  }, []);
  
  useEffect(() => {
    invoke("start_metrics").catch(console.error);
    return () => invoke("stop_metrics").catch(console.error);
  }, []);

  const rag = opState(ops, "tests.run");
  const external = opState(ops, "tests.runExternal");
  const activeTests = [rag, external].filter((op) => op.running);
  const concurrencyLocked = activeTests.some((op) => !op.paused);
  const selectedConcurrency = Math.max(1, Math.trunc(Number(concurrency) || 1));

  useEffect(() => {
    if (!rag.running && !external.running) {
      setConcurrency(Math.max(1, Number(testConcurrency) || 1));
    }
  }, [rag.running, external.running, testConcurrency]);

  const axes = benchmark?.axesParam || null;
  const start = (method, label) =>
    run(method, label, async (ref) => {
      const result = await rpc(
        method,
        { ...(axes ? { axes } : {}), concurrency: selectedConcurrency },
        ref,
      );
      onFinished?.();
      return result;
    });

  const renderVerdict = (op) => {
    if (op.running || op.result === undefined) return null;
    const value = verdict(op.result);
    return value ? <div className={`dp-op-msg ${value.className}`}>{value.text}</div> : null;
  };

  return (
    <Section 
      title="Тестування" 
      hint={metrics ? `Ollama RAM: ${metrics.ram_mb.toFixed(0)} MB | Energy Score: ${metrics.power_score.toFixed(1)}` : "Очікування метрик..."}
    >
      <div className="dp-test-controls">
        <label className="row dp-test-concurrency">
          <span>Кількість потоків</span>
          <input
            type="number"
            min="1"
            step="1"
            value={concurrency}
            disabled={concurrencyLocked}
            onChange={(event) => setConcurrency(Math.max(1, Math.trunc(Number(event.target.value) || 1)))}
          />
        </label>
        <span className="muted dp-small">
          Під час прогону змінюється після паузи; нове значення застосує «Продовжити».
        </span>
      </div>

      <div className="dp-grid">
        <OpButton
          op={rag}
          label="RAG-бенчмарк (tests.run)"
          onClick={() => start("tests.run", "RAG-бенчмарк")}
          onCancel={() => cancelOp?.("tests.run")}
          onPause={() => pauseOp?.("tests.run")}
          onResume={(concurrency) => resumeOp?.("tests.run", concurrency)}
          defaultConcurrency={selectedConcurrency}
          stopLabel="Завершити"
          disabled={Boolean(benchmark?.blockedFor?.("rag") || benchmark?.hasFieldErrors)}
        >
          {renderVerdict(rag)}
        </OpButton>

        <OpButton
          op={external}
          label="EXTERNAL-тести (tests.runExternal)"
          onClick={() => start("tests.runExternal", "EXTERNAL-тести")}
          onCancel={() => cancelOp?.("tests.runExternal")}
          onPause={() => pauseOp?.("tests.runExternal")}
          onResume={(concurrency) => resumeOp?.("tests.runExternal", concurrency)}
          defaultConcurrency={selectedConcurrency}
          stopLabel="Завершити"
          disabled={Boolean(benchmark?.blockedFor?.("external") || benchmark?.hasFieldErrors)}
        >
          {renderVerdict(external)}
        </OpButton>
      </div>

      {benchmark ? (
        <BenchmarkPlanSummary
          benchmark={benchmark}
          note="Осі цієї матриці задаються у вкладці «Прогін», секція «Повний прогін»; незадане береться з конфіга."
        />
      ) : null}

      <div className="muted dp-small">
        Обидва методи пишуть JSON-звіт у sidecar/test-reports/ — після завершення список
        звітів оновлюється автоматично. EXTERNAL-тести тепер теж ідуть ПО ВСІХ режимах
        матриці, а не одним фіксованим.
      </div>
    </Section>
  );
}
