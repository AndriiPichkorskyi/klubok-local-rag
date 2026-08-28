/**
 * Звіти — пункт «🧪 Переглянути тестові звіти» з CLI.
 * Список файлів дає reports.list, вміст обраного — reports.read({name}),
 * таблицю малює ReportTable.jsx (порт renderReportTable з sidecar/src/cli/reports.js).
 */
import { useEffect, useState } from "react";
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import ReportTable from "./ReportTable";
import { opState } from "./useDevRuntime";
import { formatBytes, formatDateTime } from "./format";

export default function ReportsSection({ ops, run, refreshKey }) {
  const listOp = opState(ops, "reports.list");
  const readOp = opState(ops, "reports.read");
  const dir = listOp.result?.dir || "";
  const reports = listOp.result?.reports || [];

  const [selected, setSelected] = useState(null);

  const loadList = () => run("reports.list", "Список звітів", (ref) => rpc("reports.list", {}, ref));

  // Список оновлюємо на монтуванні і після кожного прогону тестів.
  useEffect(() => {
    run("reports.list", "Список звітів", (ref) => rpc("reports.list", {}, ref));
  }, [run, refreshKey]);

  /** Клік по рядку — читаємо звіт. Поки читається попередній, кліки ігноруємо. */
  const openReport = (name) => {
    if (readOp.running) return;
    setSelected(name);
    run("reports.read", `Звіт ${name}`, (ref) => rpc("reports.read", { name }, ref));
  };

  // Таблицю показуємо лише для того файлу, який реально прочитаний.
  const loaded = readOp.result?.name === selected ? readOp.result.report : null;

  return (
    <Section
      title="Звіти тестування"
      hint={dir}
      actions={
        <button type="button" onClick={loadList} disabled={listOp.running}>
          {listOp.running ? "Оновлення…" : "Оновити"}
        </button>
      }
    >
      {listOp.error ? <div className="dp-alert">{listOp.error}</div> : null}

      {reports.length === 0 && !listOp.running ? (
        <div className="muted dp-small">Жодного JSON-звіту не знайдено.</div>
      ) : (
        <div className="dp-scroll-x" style={{ maxHeight: 220, overflowY: "auto" }}>
          <table className="dp-table">
            <thead>
              <tr>
                <th>Файл</th>
                <th>Розмір</th>
                <th>Змінено</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr
                  key={report.name}
                  className={report.name === selected ? "dp-selected" : undefined}
                  onClick={() => openReport(report.name)}
                  style={{ cursor: readOp.running ? "default" : "pointer" }}
                  title={readOp.running ? "Зачекайте: читається попередній звіт" : "Показати таблицею"}
                >
                  <td>{report.name}</td>
                  <td className="dp-num">{formatBytes(report.size)}</td>
                  <td>{formatDateTime(report.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <div className="dp-op">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="dp-small">
              Обрано: <code>{selected}</code>
            </span>
            <button type="button" onClick={() => setSelected(null)}>
              Закрити
            </button>
          </div>

          <OpButton
            op={readOp}
            label={`Перечитати ${selected} (reports.read)`}
            onClick={() =>
              run("reports.read", `Звіт ${selected}`, (ref) =>
                rpc("reports.read", { name: selected }, ref),
              )
            }
          />

          {loaded ? <ReportTable data={loaded} /> : null}
        </div>
      ) : null}
    </Section>
  );
}
