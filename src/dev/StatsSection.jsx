/**
 * Статистика бази — пункт «📊 Переглянути статистику» з CLI.
 * db.stats читає SQLite на ~1.5 ГБ і буває повільним, тому запускаємо лише
 * кнопкою і, як усе інше, без блокування інтерфейсу.
 */
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import { opState } from "./useDevRuntime";

/** Людські назви для відомих полів; невідомі показуємо як є. */
const LABELS = {
  appsCount: "Проіндексовано програм",
  chunksCount: "Векторних чанків",
};

export default function StatsSection({ ops, run }) {
  const op = opState(ops, "db.stats");
  const stats = op.result;

  return (
    <Section title="Статистика бази">
      <OpButton
        op={op}
        label="Оновити статистику (db.stats)"
        onClick={() => run("db.stats", "Статистика", (ref) => rpc("db.stats", {}, ref))}
      />

      {stats && typeof stats === "object" ? (
        <dl className="dp-kv">
          {Object.entries(stats).map(([key, value]) => (
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
