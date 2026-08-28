/**
 * Таблиця звіту про тестування. Логіка й склад колонок повторюють
 * renderReportTable() з sidecar/src/cli/reports.js: ті самі величини,
 * те саме підсвічування успішності (100% — зелений, >=50% — жовтий, решта — червоний)
 * і ті самі підсумкові рядки. Різниця лише в тому, що замість padEnd —
 * звичайна HTML-таблиця.
 */
import { formatDateTime } from "./format";

/** Колір рядка успішності — як у CLI. */
function passRateClass(passRate) {
  if (passRate === 100) return "dp-ok";
  if (passRate >= 50) return "dp-warn";
  return "dp-err";
}

/** Старі звіти писалися без лічильників токенів — показуємо прочерк, а не NaN. */
function num(value) {
  return Number.isFinite(value) ? value : null;
}

export default function ReportTable({ data }) {
  if (!data || typeof data !== "object" || !data.modes) {
    return <div className="dp-alert">Це не схоже на звіт: у JSON немає поля «modes».</div>;
  }

  const totalCases = data.totalCases || 0;
  const modeNames = Object.keys(data.modes);

  let grandTotalTime = 0;
  let grandTotalInputTokens = 0;
  let grandTotalOutputTokens = 0;
  let tokensKnown = false;

  const rows = modeNames.map((mode) => {
    const summary = data.modes[mode]?.summary || {};
    const totalTimeMs = num(summary.totalTimeMs) || 0;
    const inputTokens = num(summary.totalInputTokens);
    const outputTokens = num(summary.totalOutputTokens);

    grandTotalTime += totalTimeMs;
    grandTotalInputTokens += inputTokens || 0;
    grandTotalOutputTokens += outputTokens || 0;
    if (inputTokens !== null || outputTokens !== null) tokensKnown = true;

    return {
      mode,
      passRate: summary.passRate,
      passed: summary.passed,
      totalTimeSec: (totalTimeMs / 1000).toFixed(1),
      avgTime: totalCases > 0 ? (totalTimeMs / totalCases / 1000).toFixed(1) : "—",
      tokens: inputTokens === null && outputTokens === null ? "—" : `${inputTokens ?? "—"} / ${outputTokens ?? "—"}`,
      tps: Number.isFinite(summary.avgTps) ? `${summary.avgTps.toFixed(1)} t/s` : "—",
      mem: Number.isFinite(summary.avgMem) ? `${Math.round(summary.avgMem)} MB` : "—",
    };
  });

  return (
    <div>
      <div className="dp-small" style={{ marginBottom: 6 }}>
        <strong>Підсумкове порівняння режимів (search modes)</strong>
        <div className="muted">
          Дата звіту: {formatDateTime(data.timestamp)} · кейсів: {totalCases}
          {Array.isArray(data.models) && data.models.length > 0
            ? ` · моделі: ${data.models.join(", ")}`
            : ""}
        </div>
      </div>

      <div className="dp-scroll-x">
        <table className="dp-table">
          <thead>
            <tr>
              <th>Режим</th>
              <th>Успішність</th>
              <th>Час (заг/сер)</th>
              <th>In/Out токени</th>
              <th>Швидкість</th>
              <th>RAM</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.mode}>
                <td>{row.mode}</td>
                <td className={passRateClass(row.passRate)}>
                  {row.passRate}% ({row.passed}/{totalCases})
                </td>
                <td className="dp-num">
                  {row.totalTimeSec}c / {row.avgTime}c
                </td>
                <td className="dp-num">{row.tokens}</td>
                <td className="dp-num">{row.tps}</td>
                <td className="dp-num">{row.mem}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="dp-small" style={{ marginTop: 6 }}>
        <div>Загальний час усіх тестів: {(grandTotalTime / 1000).toFixed(1)} сек</div>
        <div>
          Загалом токенів:{" "}
          {tokensKnown
            ? `${grandTotalInputTokens} (input) / ${grandTotalOutputTokens} (output)`
            : "— (звіт цієї версії їх не рахував)"}
        </div>
      </div>
    </div>
  );
}
