/**
 * Керування sidecar: статус мосту, ping, перезапуск процесу і перевірка оточення
 * (модуль 2.1, метод `bootstrap.check`).
 *
 * У режимі external Rust свідомо відмовляє в перезапуску (процесом керує
 * розробник у своєму терміналі). Це нормальна поведінка, а не збій, тому
 * показуємо відповідь бекенда як пояснення, а не як червону помилку.
 *
 * Форма відповіді `bootstrap.check` описана в docs/contracts/rpc.md:
 * {platform, scanDirs, ollama, models, ready, actions, checkedAt}. Головне тут —
 * `ready` і `actions`: перше відповідає на питання «чи можна працювати», друге
 * перелічує, що саме зробити людині. Решта полів — доказова база під ці два.
 */
import { useEffect, useState } from "react";
import { rpc, sidecarStatus, sidecarRestart, onStatus } from "../ipc";
import Section from "./Section";
import OpButton, { ErrorBox } from "./OpButton";
import { opState } from "./useDevRuntime";
import { errorText } from "./format";

/** Ключ операції завантаження моделі. Своя мітка на кожну модель: інакше два
 *  паралельних `pullModel` ділили б один прогрес. */
const pullKey = (model) => `bootstrap.pullModel:${model}`;

/** Час перевірки людською мовою; ISO-рядок у панелі читати незручно. */
function formatCheckedAt(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

/** Список моделей із позначкою наявності. Відсутні — червоним, решта — зеленим. */
function ModelChips({ models, missing = [] }) {
  if (!models?.length) return <span className="muted">—</span>;
  const absent = new Set(missing);
  return (
    <span className="row">
      {models.map((model) => (
        <span key={model} className={`dp-badge ${absent.has(model) ? "dp-err" : "dp-ok"}`}>
          {absent.has(model) ? "✗" : "✓"} {model}
        </span>
      ))}
    </span>
  );
}

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

  const checkEnv = () =>
    run("bootstrap.check", "Перевірка оточення", (ref) => rpc("bootstrap.check", {}, ref));

  /** Завантаження моделі. Після успіху перевірку повторюємо самі: без цього
   *  панель показувала б модель відсутньою, хоча вона вже на диску. */
  const pullModel = (model) =>
    run(pullKey(model), `Завантаження моделі ${model}`, (ref) =>
      rpc("bootstrap.pullModel", { model }, ref),
    ).then((outcome) => {
      if (outcome.ok && !outcome.cancelled) checkEnv();
      return outcome;
    });

  const models = bootstrap?.models;
  // Обов'язкові й необов'язкові моделі різняться лише тим, як виглядає їх
  // відсутність: перша блокує роботу, друга — забирає частину сценаріїв.
  const missing = [
    ...(models?.missingRequired || []).map((model) => ({ model, required: true })),
    ...(models?.missingOptional || []).map((model) => ({ model, required: false })),
  ];

  const readyHint = bootstrap ? (bootstrap.ready ? "оточення готове" : "оточення не готове") : "";

  return (
    <Section
      title="Sidecar"
      hint={[status?.mode ? `режим ${status.mode}` : "", readyHint].filter(Boolean).join(" · ")}
    >
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
          onClick={checkEnv}
          onCancel={() => cancelOp?.("bootstrap.check")}
        />
      </div>

      {bootstrap ? (
        <>
          {/* Головна відповідь методу — одним рядком, до всіх подробиць. */}
          <div className={bootstrap.ready ? "dp-op-msg dp-ok" : "dp-alert"}>
            {bootstrap.ready
              ? "Система готова до роботи."
              : "Працювати не можна, поки не зроблено те, що нижче."}
          </div>

          {bootstrap.actions?.length ? (
            <ul className="dp-small">
              {bootstrap.actions.map((action, index) => (
                <li key={index}>{action}</li>
              ))}
            </ul>
          ) : null}

          {/* Кнопка на кожну відсутню модель: контракт дає для цього
              bootstrap.pullModel, і людині не треба йти в термінал. */}
          {missing.length ? (
            <div className="dp-grid">
              {missing.map(({ model, required }) => (
                <OpButton
                  key={model}
                  op={opState(ops, pullKey(model))}
                  label={`Завантажити ${model}${required ? "" : " (необов'язково)"}`}
                  onClick={() => pullModel(model)}
                  onCancel={() => cancelOp?.(pullKey(model))}
                />
              ))}
            </div>
          ) : null}

          <dl className="dp-kv">
            <dt>ОС</dt>
            <dd className={bootstrap.platform?.supported ? undefined : "dp-err"}>
              {bootstrap.platform?.name} {bootstrap.platform?.release} ({bootstrap.platform?.arch})
              {bootstrap.platform?.supported ? "" : ` — ${bootstrap.platform?.reason}`}
            </dd>
            <dt>Ollama</dt>
            <dd className={bootstrap.ollama?.isAvailable ? "dp-ok" : "dp-err"}>
              {bootstrap.ollama?.isAvailable ? "запущена" : "не відповідає"} ·{" "}
              {bootstrap.ollama?.baseUrl}
              {bootstrap.ollama?.error ? ` · ${bootstrap.ollama.error}` : ""}
            </dd>
            <dt>Обов'язкові моделі</dt>
            <dd>
              <ModelChips models={models?.required} missing={models?.missingRequired} />
            </dd>
            <dt>Необов'язкові моделі</dt>
            <dd>
              <ModelChips models={models?.optional} missing={models?.missingOptional} />
            </dd>
            {models?.autoPulled?.length ? (
              <>
                <dt>Завантажено автоматично</dt>
                <dd className="dp-ok">{models.autoPulled.join(", ")}</dd>
              </>
            ) : null}
            <dt>Встановлені моделі</dt>
            <dd>{bootstrap.ollama?.installedModels?.join(", ") || "—"}</dd>
            <dt>Теки сканування</dt>
            <dd>
              {bootstrap.scanDirs?.length ? (
                <details>
                  <summary>{bootstrap.scanDirs.length} тек</summary>
                  {bootstrap.scanDirs.join("\n")}
                </details>
              ) : (
                <span className="muted">— (адаптер ОС не працює)</span>
              )}
            </dd>
            <dt>Перевірено</dt>
            <dd>{formatCheckedAt(bootstrap.checkedAt)}</dd>
          </dl>
        </>
      ) : null}
    </Section>
  );
}
