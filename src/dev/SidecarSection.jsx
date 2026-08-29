/**
 * Керування sidecar: статус мосту, ping, перезапуск процесу і перевірка оточення.
 *
 * У режимі external Rust свідомо відмовляє в перезапуску (процесом керує
 * розробник у своєму терміналі). Це нормальна поведінка, а не збій, тому
 * показуємо відповідь бекенда як пояснення, а не як червону помилку.
 */
import { useEffect, useState } from "react";
import { rpc, sidecarStatus, sidecarRestart, onStatus } from "../ipc";
import Section from "./Section";
import OpButton, { ErrorBox } from "./OpButton";
import { opState } from "./useDevRuntime";
import { errorText } from "./format";

export default function SidecarSection({ ops, run, cancelOp, note }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    sidecarStatus()
      .then(setStatus)
      .catch((error) => note("sidecar", `статус недоступний: ${errorText(error)}`, "error"));

    const subscription = onStatus(setStatus);
    subscription
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => note("sidecar", `підписка на статус: ${errorText(error)}`, "error"));

    // Відписка обов'язкова: інакше після виходу з панелі слухач лишиться жити.
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [note]);

  const pingOp = opState(ops, "ping");
  const restartOp = opState(ops, "sidecarRestart");
  const bootstrapOp = opState(ops, "bootstrap.check");
  const bootstrap = bootstrapOp.result;

  /** Відмову в перезапуску повертаємо як результат, а не як помилку операції. */
  const restart = () =>
    run("sidecarRestart", "Перезапуск sidecar", async () => {
      try {
        return await sidecarRestart();
      } catch (error) {
        return { refused: errorText(error) };
      }
    });

  return (
    <Section title="Sidecar" hint={status?.mode ? `режим ${status.mode}` : ""}>
      <dl className="dp-kv">
        <dt>З'єднання</dt>
        <dd className={status?.connected ? "dp-ok" : "dp-err"}>
          {status?.connected ? "підключено" : "немає зв'язку"}
        </dd>
        <dt>Адреса</dt>
        <dd>{status ? `${status.host}:${status.port}` : "—"}</dd>
        <dt>PID процесу</dt>
        <dd>{status?.pid ?? "— (керує розробник)"}</dd>
      </dl>

      <div className="dp-grid">
        <OpButton
          op={pingOp}
          label="Перевірити живість (ping)"
          onClick={() => run("ping", "ping", (ref) => rpc("ping", {}, ref))}
          onCancel={() => cancelOp?.("ping")}
        >
          {pingOp.result ? (
            <div className="dp-op-msg">
              pid {pingOp.result.pid} · версія {pingOp.result.version}
            </div>
          ) : null}
        </OpButton>

        <OpButton op={restartOp} label="Перезапустити sidecar" onClick={restart}>
          {restartOp.result?.refused ? (
            <ErrorBox kind="info" text={`Відмова бекенда: ${restartOp.result.refused}`} />
          ) : null}
          {restartOp.result?.restarted ? (
            <div className="dp-op-msg dp-ok">перезапущено, pid {restartOp.result.pid}</div>
          ) : null}
        </OpButton>

        <OpButton
          op={bootstrapOp}
          label="Перевірити оточення (bootstrap.check)"
          onClick={() => run("bootstrap.check", "Перевірка оточення", (ref) => rpc("bootstrap.check", {}, ref))}
          onCancel={() => cancelOp?.("bootstrap.check")}
        />
      </div>

      {bootstrap ? (
        <dl className="dp-kv">
          <dt>ОС</dt>
          <dd>
            {bootstrap.os?.platform} {bootstrap.os?.release} ({bootstrap.os?.arch})
          </dd>
          <dt>Ollama</dt>
          <dd className={bootstrap.ollama?.isAvailable ? "dp-ok" : "dp-err"}>
            {bootstrap.ollama?.isAvailable ? "запущена" : "не відповідає"} · {bootstrap.ollama?.baseUrl}
          </dd>
          <dt>Відсутні моделі</dt>
          <dd className={bootstrap.ollama?.missingModels?.length ? "dp-warn" : "dp-ok"}>
            {bootstrap.ollama?.missingModels?.length
              ? `${bootstrap.ollama.missingModels.join(", ")} — виконайте ollama pull`
              : "усі на місці"}
          </dd>
          <dt>Встановлені моделі</dt>
          <dd>{bootstrap.ollama?.installedModels?.join(", ") || "—"}</dd>
        </dl>
      ) : null}
    </Section>
  );
}
