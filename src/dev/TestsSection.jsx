/**
 * Тестування — пункти «🤖 RAG Benchmark» і «🧬 EXTERNAL тестування» з CLI.
 * Обидва методи довгі; прогрес іде у спільний журнал, панель лишається живою.
 */
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";

/** tests.run повертає булеве «жоден кейс не провалився». */
function verdict(result) {
  if (result === true) return { text: "усі кейси пройдено", className: "dp-ok" };
  if (result === false) return { text: "є провалені кейси — дивіться звіт", className: "dp-warn" };
  if (result && typeof result === "object") {
    return { text: JSON.stringify(result), className: "muted" };
  }
  return null;
}

export default function TestsSection({ ops, run, onFinished }) {
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
        >
          {renderVerdict(rag)}
        </OpButton>

        <OpButton
          op={external}
          label="EXTERNAL-тести (tests.runExternal)"
          onClick={() => start("tests.runExternal", "EXTERNAL-тести")}
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
