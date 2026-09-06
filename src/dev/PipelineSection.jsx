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
import { dt } from "./i18n";

/** Кроки в тому ж порядку, що й у CLI. Ключ = метод з docs/contracts/rpc.md. */
const STEPS = [
  { key: "pipeline.scanApps", labelKey: "pipeline.steps.scan" },
  { key: "pipeline.fetchDocs", labelKey: "pipeline.steps.web" },
  { key: "pipeline.fetchLocalDocs", labelKey: "pipeline.steps.local" },
  { key: "pipeline.keywordAugmentation", labelKey: "pipeline.steps.keywords" },
  { key: "pipeline.vectorize", labelKey: "pipeline.steps.vectors" },
  { key: "pipeline.vectorizeIntents", labelKey: "pipeline.steps.intentVectors" },
];

export default function PipelineSection({ ops, run, cancelOp, embedModels }) {
  const [models, setModels] = useState([]);

  const toggleModel = (model) =>
    setModels((prev) =>
      prev.includes(model) ? prev.filter((item) => item !== model) : prev.concat(model),
    );

  const startStep = (method, label) => run(method, label, (ref) => rpc(method, {}, ref));

  /**
   * Зупинка живе в useDevRuntime: job.cancel приймає СЕРВЕРНИЙ id, а не нашу
   * мітку ref, тож id беремо з першої події прогресу (docs/notes/phase3.md).
   * Що саме відповів бекенд — показує сама кнопка «Стоп», без прикрас:
   * `cancelled:false` означає «зупинити не вдалося», а не «зупинено».
   */
  const renderOp = ({ key, label, labelKey }) => {
    const visibleLabel = label || dt(labelKey);
    const op = opState(ops, key);
    return (
      <OpButton
        key={key}
        op={op}
        label={visibleLabel}
        onClick={() => startStep(key, visibleLabel)}
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
      title={dt("pipeline.title")}
      hint={dt("pipeline.hint")}
      collapsible
    >
      <div className="dp-grid">{STEPS.map(renderOp)}</div>

      <div className="dp-op">
        {renderOp({ key: "pipeline.fullSync", label: dt("pipeline.fullLabel") })}
        <div className="dp-check-group">
          <span className="muted dp-small">{dt("pipeline.models")}</span>
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
            <span className="muted dp-small">{dt("pipeline.configModel")}</span>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
