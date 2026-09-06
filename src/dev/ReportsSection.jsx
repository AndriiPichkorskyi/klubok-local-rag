/**
 * Звіти — пункт «🧪 Переглянути тестові звіти» з CLI.
 * Список файлів дає reports.list, вміст обраного — reports.read({name}),
 * таблицю малює ReportTable.jsx (порт renderReportTable з sidecar/src/cli/reports.js).
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { rpc } from "../ipc";
import Section from "./Section";
import OpButton from "./OpButton";
import ReportTable from "./ReportTable";
import { opState } from "./useDevRuntime";
import { formatBytes, formatDateTime } from "./format";
import { summarizeReport } from "./reportAnalytics";

import Checkbox from "./Checkbox";
import { dt } from "./i18n";

const ReportComparison = lazy(() => import("./ReportComparison"));

export default function ReportsSection({ ops, run, cancelOp, refreshKey }) {
  const listOp = opState(ops, "reports.list");
  const readOp = opState(ops, "reports.read");
  const compareOp = opState(ops, "reports.compare");
  const dir = listOp.result?.dir || "";
  const reports = listOp.result?.reports || [];

  const [selected, setSelected] = useState(null);
  const [compareSelected, setCompareSelected] = useState([]);

  const loadList = () =>
    run("reports.list", dt("reports.listOperation"), (ref) => rpc("reports.list", {}, ref));

  // Список оновлюємо на монтуванні і після кожного прогону тестів.
  useEffect(() => {
    run("reports.list", dt("reports.listOperation"), (ref) => rpc("reports.list", {}, ref));
  }, [run, refreshKey]);

  /** Клік по рядку — читаємо звіт. Поки читається попередній, кліки ігноруємо. */
  const openReport = (name) => {
    if (readOp.running) return;
    setSelected(name);
    run("reports.read", dt("reports.reportOperation", { name }), (ref) =>
      rpc("reports.read", { name }, ref),
    );
  };

  // Таблицю показуємо лише для того файлу, який реально прочитаний.
  const loaded = readOp.result?.name === selected ? readOp.result.report : null;

  const toggleComparison = (name) => {
    setCompareSelected((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  };

  const compareReports = () => {
    const names = [...compareSelected];
    run("reports.compare", dt("reports.compareOperation", { count: names.length }), async (ref) => {
      const items = [];
      for (const [index, name] of names.entries()) {
        const value = await rpc(
          "reports.read",
          { name },
          `${ref}:compare:${index}`,
        );
        items.push(summarizeReport(name, value.report));
      }
      return { names, items };
    });
  };

  return (
    <Section
      title={dt("reports.title")}
      hint={dir}
      actions={
        <button type="button" onClick={loadList} disabled={listOp.running}>
          {dt(listOp.running ? "reports.updating" : "reports.refresh")}
        </button>
      }
    >
      {listOp.error ? <div className="dp-alert">{listOp.error}</div> : null}

      {reports.length === 0 && !listOp.running ? (
        <div className="muted dp-small">{dt("reports.empty")}</div>
      ) : (
        <div
          className="dp-scroll-x"
          style={{ maxHeight: 220, overflowY: "auto" }}
        >
          <table className="dp-table">
            <thead>
              <tr>
                <th title={dt("reports.addCompare")}>✓</th>
                <th>{dt("reports.file")}</th><th>{dt("reports.size")}</th><th>{dt("reports.modified")}</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr
                  key={report.name}
                  // Клік по рядку відкриває звіт, тож рядок мусить це показувати
                  // САМ: курсор і підсвітка на ховері, видимий фокус із клавіатури.
                  // Раніше єдиною підказкою був title, який видно лише через секунду.
                  className={[
                    "dp-row",
                    readOp.running ? "is-busy" : "is-clickable",
                    report.name === selected ? "dp-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  tabIndex={readOp.running ? -1 : 0}
                  onClick={() => openReport(report.name)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openReport(report.name);
                    }
                  }}
                  title={
                    readOp.running
                      ? dt("reports.waitRead")
                      : dt("reports.showTable")
                  }
                >
                  <td onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      className="dp-report-checkbox"
                      type="checkbox"
                      aria-label={dt("reports.compareAria", { name: report.name })}
                      checked={compareSelected.includes(report.name)}
                      onChange={() => toggleComparison(report.name)}
                    />
                  </td>
                  <td>{report.name}</td>
                  <td className="dp-num">{formatBytes(report.size)}</td>
                  <td>{formatDateTime(report.mtime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reports.length > 0 ? (
        <div className="dp-compare-controls">
          <button
            type="button"
            onClick={() =>
              setCompareSelected(reports.map((report) => report.name))
            }
          >
            {dt("reports.selectAll")}
          </button>
          <button
            type="button"
            onClick={() => setCompareSelected([])}
            disabled={compareSelected.length === 0}
          >
            {dt("reports.clearSelection")}
          </button>
          <button
            type="button"
            onClick={compareReports}
            disabled={compareSelected.length < 2 || compareOp.running}
          >
            {compareOp.running
              ? dt("reports.comparing")
              : dt("reports.compare", { count: compareSelected.length })}
          </button>
          <span className="muted dp-small">
            {dt("reports.matrixHint")}
          </span>
        </div>
      ) : null}

      {compareOp.error ? (
        <div className="dp-alert">{compareOp.error}</div>
      ) : null}
      {Array.isArray(compareOp.result?.items) &&
      compareOp.result.items.length > 0 ? (
        <Suspense
          fallback={<div className="muted dp-small">{dt("reports.preparing")}</div>}
        >
          <ReportComparison items={compareOp.result.items} />
        </Suspense>
      ) : null}

      {selected ? (
        <div className="dp-op">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="dp-small">
              {dt("reports.selected")} <code>{selected}</code>
            </span>
            <button type="button" onClick={() => setSelected(null)}>
              {dt("reports.close")}
            </button>
          </div>

          <OpButton
            op={readOp}
            label={dt("reports.reread", { name: selected })}
            onClick={() =>
              run("reports.read", dt("reports.reportOperation", { name: selected }), (ref) =>
                rpc("reports.read", { name: selected }, ref),
              )
            }
            onCancel={() => cancelOp?.("reports.read")}
          />

          {loaded ? <ReportTable data={loaded} /> : null}
        </div>
      ) : null}
    </Section>
  );
}
