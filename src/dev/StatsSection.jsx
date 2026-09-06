/**
 * Статистика бази — пункт «📊 Переглянути статистику» з CLI плюс головне
 * доповнення: видима готовність КОЖНОЇ моделі ембедингу.
 *
 * Навіщо: після нічного прогону з двома моделями не було способу дізнатися,
 * що друга модель не векторизувалась узагалі — це з'ясовувалось лише прямим
 * запитом до бази (docs/improvements.md). Тепер це видно з першого погляду.
 *
 * db.stats читає SQLite на ~1.5 ГБ і буває повільним, тому запускаємо лише
 * кнопкою (та автоматично після повного прогону) і, як усе інше, без блокування.
 */
import { useEffect } from "react";
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";
import { readModelStats, readiness } from "./modelStats";
import { dt } from "./i18n";

/** Людські назви для відомих полів; невідомі показуємо як є. */
const LABELS = {
  appsCount: "stats.fields.appsCount", chunksCount: "stats.fields.chunksCount",
  currentModel: "stats.fields.currentModel", chunksFtsTotal: "stats.fields.chunksFtsTotal",
  chunksBySourceType: "stats.fields.chunksBySourceType", documentLinksBySourceType: "stats.fields.documentLinksBySourceType",
  webDocumentsCount: "stats.fields.webDocumentsCount", appsWithoutKeywords: "stats.fields.appsWithoutKeywords",
  sqlite: "stats.fields.sqlite", collectedAt: "stats.fields.collectedAt",
};

/** Підпис готовності. «Невідомо» — це теж чесна відповідь, на відміну від нуля. */
const READY_VIEW = {
  ready: { textKey: "stats.states.ready", className: "dp-ok" },
  partial: { textKey: "stats.states.partial", className: "dp-warn" },
  missing: { textKey: "stats.states.missing", className: "dp-err" },
  unknown: { textKey: "stats.states.unknown", className: "muted" },
};

/** Число або прочерк: нуль замість «немає даних» вводив би в оману. */
const numberOrDash = (value) => (typeof value === "number" ? value : "—");

export default function StatsSection({ ops, run, cancelOp, refreshKey }) {
  const op = opState(ops, "db.stats");
  const stats = op.result;
  const load = () => run("db.stats", dt("stats.operation"), (ref) => rpc("db.stats", {}, ref));

  // Після повного прогону статистику оновлюємо самі: саме заради неї прогін і робиться.
  useEffect(() => {
    if (refreshKey) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Читаємо захищено: бекенд саме зараз розширює db.stats, і полів може ще не бути.
  const { models, containerKey, hasModelData } = readModelStats(stats);

  return (
    <Section title={dt("stats.title")} hint={dt("stats.hint")}>
      <OpButton
        op={op}
        label={dt("stats.refresh")}
        onClick={load}
        onCancel={() => cancelOp?.("db.stats")}
      />

      {hasModelData ? (
        <div className="dp-scroll-x">
          <table className="dp-table">
            <thead>
              <tr>
                <th>{dt("stats.headers.model")}</th><th>{dt("stats.headers.apps")}</th>
                <th>{dt("stats.headers.chunks")}</th><th>{dt("stats.headers.size")}</th>
                <th>{dt("stats.headers.status")}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const view = READY_VIEW[readiness(model)];
                return (
                  <tr key={model.name}>
                    <td>
                      {model.name}
                      {model.isCurrent ? <span className="dp-badge">{dt("stats.current")}</span> : null}
                    </td>
                    <td className="dp-num">
                      {dt("stats.ratio", { value: numberOrDash(model.vectorized), total: numberOrDash(model.total) })}
                    </td>
                    <td
                      className="dp-num"
                      title={model.sourceTypes ? JSON.stringify(model.sourceTypes) : undefined}
                    >
                      {numberOrDash(model.chunks)}
                    </td>
                    <td
                      className={
                        model.tableExists === true
                          ? "dp-ok"
                          : model.tableExists === false
                            ? "dp-err"
                            : "muted"
                      }
                      title={model.tablePath || undefined}
                    >
                      {model.tableExists === true
                        ? `${model.tableSize || "0.00"} MB`
                        : model.tableExists === false
                          ? dt("common.none")
                          : dt("common.unknown")}
                    </td>
                    <td className={view.className}>{dt(view.textKey)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : stats && typeof stats === "object" ? (
        <div className="muted dp-small">
          {dt("stats.oldBackend")}
        </div>
      ) : null}

      {stats && typeof stats === "object" ? (
        <dl className="dp-kv">
          {Object.entries(stats)
            .filter(([key]) => key !== containerKey)
            .map(([key, value]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt>{LABELS[key] ? dt(LABELS[key]) : key}</dt>
                <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
              </div>
            ))}
        </dl>
      ) : (
        <div className="muted dp-small">{dt("stats.noData")}</div>
      )}
    </Section>
  );
}
