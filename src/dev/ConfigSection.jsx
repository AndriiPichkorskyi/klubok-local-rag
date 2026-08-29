/**
 * Конфіг: показати поточний (config.get) і перечитати з диска (config.reload).
 * Токен RPC у виводі маскуємо — панель відкрита на екрані.
 */
import { useEffect } from "react";
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";
import { maskSecrets } from "./format";

/** Найцікавіші поля винесені нагору, решта — у розгортайці. */
function highlights(config) {
  if (!config || typeof config !== "object") return [];
  return [
    ["Модель ембедингу", config.embedModelName],
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

  // Конфіг легкий, тож тягнемо його одразу — панель від цього не блокується.
  useEffect(() => {
    run("config.get", "Конфіг", (ref) => rpc("config.get", {}, ref));
  }, [run]);

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
                <dd>{String(value)}</dd>
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
