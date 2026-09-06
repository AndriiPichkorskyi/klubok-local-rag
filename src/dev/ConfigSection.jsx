/**
 * Конфіг: показати поточний (config.get) і перечитати з диска (config.reload).
 * Токен RPC у виводі маскуємо — панель відкрита на екрані.
 */
import { useEffect, useState, useMemo } from "react";
import { rpc, notifyConfigChanged } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";
import { maskSecrets } from "./format";
import { dt } from "./i18n";

/** Найцікавіші поля винесені нагору, решта — у розгортайці. */
function highlights(config) {
  if (!config || typeof config !== "object") return [];
  return [
    { id: "embed", label: dt("config.fields.embed"), value: config.embedModelName },
    { id: "chat", label: dt("config.fields.chat"), value: config.ollama?.chatModel },
    { id: "vision", label: dt("config.fields.vision"), value: config.ollama?.visionModel },
    { id: "ollama", label: dt("config.fields.ollama"), value: config.ollama?.baseUrl },
    { id: "rpc", label: dt("config.fields.rpc"), value: config.rpc ? `${config.rpc.host}:${config.rpc.port}` : undefined },
    { id: "search", label: dt("config.fields.search"), value: config.rag?.searchMode },
    { id: "file", label: dt("config.fields.file"), value: config.paths?.configPath },
    { id: "sqlite", label: dt("config.fields.sqlite"), value: config.db?.sqlitePath },
    { id: "lancedb", label: dt("config.fields.lancedb"), value: config.db?.lancedbPath },
  ].filter(({ value }) => value !== undefined && value !== null);
}

export default function ConfigSection({ ops, run, cancelOp, config }) {
  const getOp = opState(ops, "config.get");
  const reloadOp = opState(ops, "config.reload");
  const [allModels, setAllModels] = useState([]);

  // Конфіг легкий, тож тягнемо його одразу — панель від цього не блокується.
  useEffect(() => {
    run("config.get", dt("config.operation"), (ref) => rpc("config.get", {}, ref));
    // Завантажуємо моделі
    rpc("ollama.getModels").then((models) => {
      if (Array.isArray(models)) setAllModels(models);
    }).catch(err => console.error(dt("config.modelLoadError"), err));
  }, [run]);

  const embedModels = useMemo(() => {
    return [...new Set([config?.embedModelName, ...(config?.embedModels || [])].filter(Boolean))];
  }, [config]);

  const visionModels = useMemo(() => {
    const filtered = allModels.filter(m => m.includes("vl") || m.includes("vision") || m.includes("llava"));
    return filtered.length > 0 ? filtered : allModels;
  }, [allModels]);

  const updateModel = (type, value) => {
    if (!value) return;
    const payload = {};
    if (type === "embed") payload.embedModel = value;
    if (type === "chat") payload.chatModel = value;
    if (type === "vision") payload.visionModel = value;

    // Використовуємо ключ "config.reload", щоб DevPanel.jsx підхопив оновлений стан.
    run("config.reload", dt("config.changeModel", { type }), async (ref) => {
      await rpc("config.updateModels", payload, ref);
      const next = await rpc("config.get", {}, ref);
      // Вікно пошуку мусить перевірити готовність заново: у нової моделі
      // може не бути векторного індексу, і це видно одразу, а не після
      // перезапуску.
      notifyConfigChanged();
      return next;
    });
  };

  /** Режим пошуку. Значення перевіряє бекенд тим самим списком, що й `query`. */
  const updateSearchMode = (value) => {
    if (!value) return;
    run("config.reload", dt("config.changeSearchMode"), async (ref) => {
      await rpc("config.setSearchMode", { mode: value }, ref);
      const next = await rpc("config.get", {}, ref);
      notifyConfigChanged();
      return next;
    });
  };

  const SEARCH_MODE_OPTIONS = ["auto", "hybrid", "vector", "fts"];

  const renderSelect = (current, options, type) => (
    <select value={current || ""} onChange={(e) => updateModel(type, e.target.value)}>
      <option value="" disabled>{dt("common.chooseModel")}</option>
      {[...new Set([current, ...options])].filter(Boolean).map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  );

  return (
    <Section title={dt("config.title")}>
      <div className="dp-grid">
        <OpButton
          op={getOp}
          label={dt("config.show")}
          onClick={() => run("config.get", dt("config.operation"), (ref) => rpc("config.get", {}, ref))}
          onCancel={() => cancelOp?.("config.get")}
        />
        <OpButton
          op={reloadOp}
          label={dt("config.reload")}
          onClick={() => run("config.reload", dt("config.reloadOperation"), (ref) => rpc("config.reload", {}, ref))}
          onCancel={() => cancelOp?.("config.reload")}
        />
      </div>

      {config ? (
        <>
          <dl className="dp-kv">
            {highlights(config).map(({ id, label, value }) => (
              <div key={id} style={{ display: "contents" }}>
                <dt>{label}</dt>
                <dd>
                  {id === "embed" ? renderSelect(value, embedModels, "embed")
                   : id === "chat" ? renderSelect(value, allModels, "chat")
                   : id === "vision" ? renderSelect(value, visionModels, "vision")
                   : id === "search" ? (
                       <select value={value || ""} onChange={(e) => updateSearchMode(e.target.value)}>
                         {[...new Set([value, ...SEARCH_MODE_OPTIONS])].filter(Boolean).map((m) => (
                           <option key={m} value={m}>{m}</option>
                         ))}
                       </select>
                     )
                   : String(value)}
                </dd>
              </div>
            ))}
          </dl>
          <details>
            <summary className="dp-small muted">{dt("config.fullJson")}</summary>
            <pre>{JSON.stringify(maskSecrets(config), null, 2)}</pre>
          </details>
        </>
      ) : (
        <div className="muted dp-small">{dt("config.unloaded")}</div>
      )}
    </Section>
  );
}
