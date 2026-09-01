/**
 * Конфіг: показати поточний (config.get) і перечитати з диска (config.reload).
 * Токен RPC у виводі маскуємо — панель відкрита на екрані.
 */
import { useEffect, useState, useMemo } from "react";
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";
import { maskSecrets } from "./format";

/** Найцікавіші поля винесені нагору, решта — у розгортайці. */
function highlights(config) {
  if (!config || typeof config !== "object") return [];
  return [
    ["Модель векторів", config.embedModelName],
    ["Чат-модель", config.ollama?.chatModel],
    ["Модель зору", config.ollama?.visionModel],
    ["Ollama", config.ollama?.baseUrl],
    ["RPC", config.rpc ? `${config.rpc.host}:${config.rpc.port}` : undefined],
    ["Режим пошуку", config.rag?.searchMode],
    ["Файл конфіга", config.paths?.configPath],
    ["SQLite", config.db?.sqlitePath],
    ["LanceDB", config.db?.lancedbPath],
  ].filter(([, value]) => value !== undefined && value !== null);
}

export default function ConfigSection({ ops, run, cancelOp, config }) {
  const getOp = opState(ops, "config.get");
  const reloadOp = opState(ops, "config.reload");
  const [allModels, setAllModels] = useState([]);

  // Конфіг легкий, тож тягнемо його одразу — панель від цього не блокується.
  useEffect(() => {
    run("config.get", "Конфіг", (ref) => rpc("config.get", {}, ref));
    // Завантажуємо моделі
    rpc("ollama.getModels").then((models) => {
      if (Array.isArray(models)) setAllModels(models);
    }).catch(err => console.error("Failed to load models", err));
  }, [run]);

  const embedModels = useMemo(() => {
    const filtered = allModels.filter(m => m.includes("embed") || m.includes("bge"));
    return filtered.length > 0 ? filtered : allModels;
  }, [allModels]);

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
    run("config.reload", `Зміна моделі (${type})`, async (ref) => {
      await rpc("config.updateModels", payload, ref);
      return rpc("config.get", {}, ref);
    });
  };

  const renderSelect = (label, current, options, type) => (
    <select value={current || ""} onChange={(e) => updateModel(type, e.target.value)}>
      <option value="" disabled>Оберіть модель</option>
      {[...new Set([current, ...options])].filter(Boolean).map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  );

  return (
    <Section title="Конфігурація">
      <div className="dp-grid">
        <OpButton
          op={getOp}
          label="Показати поточний (config.get)"
          onClick={() => run("config.get", "Конфіг", (ref) => rpc("config.get", {}, ref))}
          onCancel={() => cancelOp?.("config.get")}
        />
        <OpButton
          op={reloadOp}
          label="Перечитати з диска (config.reload)"
          onClick={() => run("config.reload", "Перечитування конфіга", (ref) => rpc("config.reload", {}, ref))}
          onCancel={() => cancelOp?.("config.reload")}
        />
      </div>

      {config ? (
        <>
          <dl className="dp-kv">
            {highlights(config).map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt>{label}</dt>
                <dd>
                  {label === "Модель векторів" ? renderSelect(label, value, embedModels, "embed")
                   : label === "Чат-модель" ? renderSelect(label, value, allModels, "chat")
                   : label === "Модель зору" ? renderSelect(label, value, visionModels, "vision")
                   : String(value)}
                </dd>
              </div>
            ))}
          </dl>
          <details>
            <summary className="dp-small muted">Повний JSON (токен замаскований)</summary>
            <pre>{JSON.stringify(maskSecrets(config), null, 2)}</pre>
          </details>
        </>
      ) : (
        <div className="muted dp-small">Конфіг ще не завантажено.</div>
      )}
    </Section>
  );
}
