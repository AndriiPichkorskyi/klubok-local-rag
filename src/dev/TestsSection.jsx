/**
 * Тестування — пункти «🤖 RAG Benchmark» і «🧬 EXTERNAL тестування» з CLI.
 * Обидва методи довгі; прогрес іде у спільний журнал, панель лишається живою.
 */
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";

/**
 * tests.run і tests.runExternal повертають
 * {ok, totalCases, passed, failed, passRate, reportPath}.
 * Булеве значення лишилось у гілці сумісності зі старою поведінкою.
 */
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

export default function TestsSection({ ops, run, cancelOp, onFinished }) {
  const rag = opState(ops, "tests.run");
  const external = opState(ops, "tests.runExternal");

  const start = (method, label) =>
    run(method, label, async (ref) => {
      const result = await rpc(method, {}, ref);
      onFinished?.();
      return result;
    });

  const renderVerdict = (op) => {
    if (op.running || op.result === undefined) return null;
    const value = verdict(op.result);
    return value ? <div className={`dp-op-msg ${value.className}`}>{value.text}</div> : null;
  };

  return (
    <Section title="Тестування" hint="детальний вивід — у терміналі sidecar">
      <div className="dp-grid">
        <OpButton
          op={rag}
          label="RAG-бенчмарк (tests.run)"
          onClick={() => start("tests.run", "RAG-бенчмарк")}
          onCancel={() => cancelOp?.("tests.run")}
        >
          {renderVerdict(rag)}
        </OpButton>

        <OpButton
          op={external}
          label="EXTERNAL-тести (tests.runExternal)"
          onClick={() => start("tests.runExternal", "EXTERNAL-тести")}
          onCancel={() => cancelOp?.("tests.runExternal")}
        >
          {renderVerdict(external)}
        </OpButton>
      </div>

      <div className="muted dp-small">
        Обидва методи пишуть JSON-звіт у sidecar/test-reports/ — після завершення список
        звітів оновлюється автоматично.
      </div>
    </Section>
  );
}
