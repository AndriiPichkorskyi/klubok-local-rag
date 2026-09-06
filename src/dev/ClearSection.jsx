/**
 * Очистка бази — пункт «⚙️ Очистити базу даних» з CLI.
 * Перелік цілей повністю збігається з db.clear у docs/contracts/rpc.md.
 * Підтвердження — власний React-діалог (див. ConfirmDialog.jsx).
 */
import { useState } from "react";
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import ConfirmDialog from "./ConfirmDialog";
import { opState } from "./useDevRuntime";
import { dt } from "./i18n";

/** value — рівно ті значення target, які приймає sidecar. */
const TARGETS = [
  { value: "all", labelKey: "clear.targets.all" },
  { value: "web", labelKey: "clear.targets.web" },
  { value: "local", labelKey: "clear.targets.local" },
  { value: "apps", labelKey: "clear.targets.apps" },
  { value: "document_links", labelKey: "clear.targets.links" },
  { value: "raw_html", labelKey: "clear.targets.raw" },
  { value: "web_documents", labelKey: "clear.targets.documents" },
  { value: "lancedb", labelKey: "clear.targets.lancedb" },
  { value: "intents", labelKey: "clear.targets.intents" },
];

export default function ClearSection({ ops, run, cancelOp }) {
  const [pending, setPending] = useState(null);

  const confirmClear = () => {
    const target = pending;
    setPending(null);
    if (!target) return;
    run(`db.clear:${target.value}`, dt("clear.operation", { target: target.value }), (ref) =>
      rpc("db.clear", { target: target.value }, ref),
    );
  };

  return (
    <Section title={dt("clear.title")} hint={dt("clear.hint")}>
      <div className="dp-grid">
        {TARGETS.map((target) => {
          const key = `db.clear:${target.value}`;
          const op = opState(ops, key);
          return (
            <OpButton
              key={key}
              op={op}
              label={dt(target.labelKey)}
              danger
              onClick={() => setPending(target)}
              onCancel={() => cancelOp?.(key)}
            >
              <div className="dp-op-msg">target: {target.value}</div>
            </OpButton>
          );
        })}
      </div>

      {pending ? (
        <ConfirmDialog
          title={dt("clear.irreversible")}
          message={dt("clear.message", { target: pending.value, label: dt(pending.labelKey) })}
          confirmLabel={dt("clear.confirm", { target: pending.value })}
          onConfirm={confirmClear}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </Section>
  );
}
