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

/** Людські назви для відомих полів; невідомі показуємо як є. */
const LABELS = {
  appsCount: "Проіндексовано програм",
  chunksCount: "Векторних чанків (поточна модель)",
  currentModel: "Модель ембедингу з конфіга",
  chunksFtsTotal: "Чанків у FTS",
  chunksBySourceType: "Чанки за типом джерела",
  documentLinksBySourceType: "Посилання за типом джерела",
  webDocumentsCount: "Очищених веб-документів",
  appsWithoutKeywords: "Програм без намірів",
  sqlite: "SQLite",
  collectedAt: "Зібрано",
};

/** Підпис готовності. «Невідомо» — це теж чесна відповідь, на відміну від нуля. */
const READY_VIEW = {
  ready: { text: "готова", className: "dp-ok" },
  partial: { text: "неповна", className: "dp-warn" },
  missing: { text: "НЕ ГОТОВА", className: "dp-err" },
  unknown: { text: "невідомо", className: "muted" },
};

/** Число або прочерк: нуль замість «немає даних» вводив би в оману. */
const numberOrDash = (value) => (typeof value === "number" ? value : "—");

export default function StatsSection({ ops, run, cancelOp, refreshKey }) {
  const op = opState(ops, "db.stats");
  const stats = op.result;
  const load = () => run("db.stats", "Статистика", (ref) => rpc("db.stats", {}, ref));

  // Після повного прогону статистику оновлюємо самі: саме заради неї прогін і робиться.
  useEffect(() => {
    if (refreshKey) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Читаємо захищено: бекенд саме зараз розширює db.stats, і полів може ще не бути.
  const { models, containerKey, hasModelData } = readModelStats(stats);

  return (
    <Section title="Статистика бази" hint="готовність моделей видно завжди">
      <OpButton
        op={op}
        label="Оновити статистику (db.stats)"
        onClick={load}
        onCancel={() => cancelOp?.("db.stats")}
      />

      {hasModelData ? (
        <div className="dp-scroll-x">
          <table className="dp-table">
            <thead>
              <tr>
                <th>Модель ембедингу</th>
                <th>Векторизовано програм</th>
                <th>Векторна база</th>
                <th>Готовність</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const view = READY_VIEW[readiness(model)];
                return (
                  <tr key={model.name}>
                    <td>
                      {model.name}
                      {model.isCurrent ? <span className="dp-badge">поточна</span> : null}
                    </td>
                    <td className="dp-num">
                      {model.vectorized === undefined && model.chunks !== undefined
                        ? `${model.chunks} чанків`
                        : `${numberOrDash(model.vectorized)} з ${numberOrDash(model.total)}`}
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
                        ? `існує${model.tableSize ? ` · ${model.tableSize}` : ""}`
                        : model.tableExists === false
                          ? "немає"
                          : "невідомо"}
                    </td>
                    <td className={view.className}>{view.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : stats && typeof stats === "object" ? (
        <div className="muted dp-small">
          db.stats поки не повертає статус моделей — бекенд ще не розширив метод.
          Порожні лічильники тут не вигадуємо.
        </div>
      ) : null}

      {stats && typeof stats === "object" ? (
        <dl className="dp-kv">
          {Object.entries(stats)
            .filter(([key]) => key !== containerKey)
            .map(([key, value]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt>{LABELS[key] || key}</dt>
                <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
              </div>
            ))}
        </dl>
      ) : (
        <div className="muted dp-small">Дані ще не запитували.</div>
      )}
    </Section>
  );
}
