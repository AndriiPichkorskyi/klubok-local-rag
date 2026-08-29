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

/** value — рівно ті значення target, які приймає sidecar. */
const TARGETS = [
  { value: "all", label: "Очистити ВСЕ (повне скидання)" },
  { value: "web", label: "Тільки ВЕБ-документи" },
  { value: "local", label: "Тільки ЛОКАЛЬНА довідка" },
  { value: "apps", label: "Таблиця програм (SQLite)" },
  { value: "document_links", label: "Посилання на документацію" },
  { value: "raw_html", label: "Сирий HTML довідки" },
  { value: "web_documents", label: "Очищений текст документації" },
  { value: "lancedb", label: "Векторна база (LanceDB)" },
  { value: "intents", label: "Наміри (ключові слова та їх вектори)" },
];

export default function ClearSection({ ops, run, cancelOp }) {
  const [pending, setPending] = useState(null);

  const confirmClear = () => {
    const target = pending;
    setPending(null);
    if (!target) return;
    run(`db.clear:${target.value}`, `Очистка «${target.value}»`, (ref) =>
      rpc("db.clear", { target: target.value }, ref),
    );
  };

  return (
    <Section title="Очистка бази" hint="незворотні дії — з підтвердженням">
      <div className="dp-grid">
        {TARGETS.map((target) => {
          const key = `db.clear:${target.value}`;
          const op = opState(ops, key);
          return (
            <OpButton
              key={key}
              op={op}
              label={target.label}
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
          title="Незворотна дія"
          message={`Очистити «${pending.value}» (${pending.label})? Дані видаляються назавжди, скасувати буде неможливо.`}
          confirmLabel={`Очистити ${pending.value}`}
          onConfirm={confirmClear}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </Section>
  );
}
