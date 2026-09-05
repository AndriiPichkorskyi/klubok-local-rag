/**
 * Пайплайн індексації — порт пункту «🔄 Оновлення бази» з sidecar/src/cli/index.js.
 * Склад кроків той самий, змінена лише подача: замість послідовного меню —
 * окрема кнопка на кожен крок плюс повне оновлення.
 */
import { useState } from "react";
import { rpc } from "../ipc";
import Section from "./Section";
import Checkbox from "./Checkbox";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";
import { summarizeResult } from "./format";

/** Кроки в тому ж порядку, що й у CLI. Ключ = метод з docs/contracts/rpc.md. */
const STEPS = [
  { key: "pipeline.scanApps", label: "1. Сканувати програми" },
  { key: "pipeline.fetchDocs", label: "2. Завантажити довідку (веб)" },
  { key: "pipeline.fetchLocalDocs", label: "3. Завантажити довідку (локальна)" },
  { key: "pipeline.keywordAugmentation", label: "4. Згенерувати наміри (keywords)" },
  { key: "pipeline.vectorize", label: "5. Побудувати вектори" },
  { key: "pipeline.vectorizeIntents", label: "6. Вектори намірів" },
];

export default function PipelineSection({ ops, run, cancelOp, embedModels }) {
  const [models, setModels] = useState([]);

  const toggleModel = (model) =>
    setModels((prev) =>
      prev.includes(model) ? prev.filter((item) => item !== model) : prev.concat(model),
    );

  const startStep = (method, label) => run(method, label, (ref) => rpc(method, {}, ref));

  const startFullSync = () =>
    run("pipeline.fullSync", "Повне оновлення", (ref) =>
      rpc("pipeline.fullSync", models.length > 0 ? { models } : {}, ref),
    );

  /**
   * Зупинка живе в useDevRuntime: job.cancel приймає СЕРВЕРНИЙ id, а не нашу
   * мітку ref, тож id беремо з першої події прогресу (docs/notes/phase3.md).
   * Що саме відповів бекенд — показує сама кнопка «Стоп», без прикрас:
   * `cancelled:false` означає «зупинити не вдалося», а не «зупинено».
   */
  const renderOp = ({ key, label }) => {
    const op = opState(ops, key);
    return (
      <OpButton
        key={key}
        op={op}
        label={label}
        onClick={() => startStep(key, label)}
        onCancel={() => cancelOp?.(key)}
      >
        {!op.running && op.result !== undefined ? (
          <div className="dp-op-msg">{summarizeResult(op.result)}</div>
        ) : null}
      </OpButton>
    );
  };

  const fullSync = opState(ops, "pipeline.fullSync");

  return (
    <Section
      title="Окремі кроки пайплайна"
      hint="для налагодження і відновлення: один крок, без послідовності"
      collapsible
    >
      <div className="dp-grid">{STEPS.map(renderOp)}</div>

      <div className="dp-op">
        {renderOp({ key: "pipeline.fullSync", label: "Повне оновлення (усі кроки поспіль)" })}
        <div className="dp-check-group">
          <span className="muted dp-small">Векторизувати для моделей:</span>
          {embedModels.map((model) => (
            <Checkbox
              key={model}
              checked={models.includes(model)}
              onChange={() => toggleModel(model)}
              disabled={fullSync.running}
            >
              {model}
            </Checkbox>
          ))}
          {models.length === 0 ? (
            <span className="muted dp-small">нічого не обрано — модель з конфіга</span>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
