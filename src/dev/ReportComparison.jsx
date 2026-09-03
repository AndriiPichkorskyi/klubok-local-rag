import { useMemo } from "react";
import EChart from "./EChart";

function pct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function seconds(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(2)} с` : "—";
}

function modelLabel(item) {
  return `${item.models.chat} + ${item.models.embed}`;
}

function modelInfo(details) {
  if (!details) return "метаданих немає";
  return [details.parameterSize, details.quantizationLevel].filter(Boolean).join(" · ") || "метаданих немає";
}

function shortHash(value) {
  return value ? value.slice(0, 10) : "—";
}

function colors() {
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return dark
    ? { text: "#e8eaed", muted: "#9aa1ac", line: "#2a2e37", panel: "#1d2027" }
    : { text: "#16181d", muted: "#6b7280", line: "#e5e7eb", panel: "#f7f8fa" };
}

export default function ReportComparison({ items }) {
  const view = useMemo(() => {
    const chats = [...new Set(items.map((item) => item.models.chat))];
    const embeds = [...new Set(items.map((item) => item.models.embed))];
    const grouped = new Map();
    for (const item of items) {
      const key = `${item.models.chat}\u0000${item.models.embed}`;
      const current = grouped.get(key) || { weightedPass: 0, runs: 0, reports: 0 };
      current.weightedPass += (item.passRate || 0) * item.actualRuns;
      current.runs += item.actualRuns;
      current.reports += 1;
      grouped.set(key, current);
    }
    const matrix = [...grouped.entries()].map(([key, score]) => {
      const [chat, embed] = key.split("\u0000");
      return [chats.indexOf(chat), embeds.indexOf(embed), score.runs ? Number((score.weightedPass / score.runs).toFixed(1)) : null, score.reports];
    });
    return { chats, embeds, grouped, matrix };
  }, [items]);
  const theme = colors();
  const base = {
    animation: false,
    textStyle: { color: theme.text, fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif" },
    tooltip: { backgroundColor: theme.panel, borderColor: theme.line, textStyle: { color: theme.text } },
    grid: { left: 55, right: 30, top: 32, bottom: 70, containLabel: true },
  };

  const qualityOption = {
    ...base,
    legend: { data: ["Загалом", "Українська", "Англійська"], textStyle: { color: theme.text } },
    xAxis: { type: "category", data: items.map(modelLabel), axisLabel: { color: theme.muted, rotate: items.length > 3 ? 30 : 0 } },
    yAxis: { type: "value", min: 0, max: 100, name: "% успіху", axisLabel: { color: theme.muted } },
    series: [
      { name: "Загалом", type: "bar", data: items.map((item) => item.passRate), itemStyle: { color: "#2563eb" } },
      { name: "Українська", type: "bar", data: items.map((item) => item.ukPassRate), itemStyle: { color: "#15803d" } },
      { name: "Англійська", type: "bar", data: items.map((item) => item.enPassRate), itemStyle: { color: "#f59e0b" } },
    ],
  };

  const scatterOption = {
    ...base,
    xAxis: { type: "value", name: "Середній час, с", axisLabel: { color: theme.muted } },
    yAxis: { type: "value", min: 0, max: 100, name: "% успіху", axisLabel: { color: theme.muted } },
    series: [{
      type: "scatter",
      data: items.map((item) => ({
        name: modelLabel(item),
        value: [item.avgTimeMs / 1000, item.passRate, item.avgRam || 0, item.avgGpu],
      })),
      symbolSize: (value) => Math.max(9, Math.min(34, (value[2] || 512) / 220)),
      itemStyle: { color: "#2563eb", opacity: 0.78 },
    }],
    tooltip: {
      ...base.tooltip,
      formatter: ({ data }) => `<strong>${data.name}</strong><br/>успішність: ${pct(data.value[1])}<br/>час: ${data.value[0].toFixed(2)} с<br/>RAM: ${data.value[2] ? Math.round(data.value[2]) + " MB" : "—"}<br/>GPU: ${pct(data.value[3])}`,
    },
  };

  const matrixOption = {
    ...base,
    grid: { left: 150, right: 25, top: 15, bottom: 65 },
    xAxis: { type: "category", data: view.chats, axisLabel: { color: theme.muted, rotate: 25 } },
    yAxis: { type: "category", data: view.embeds, axisLabel: { color: theme.muted } },
    visualMap: { min: 0, max: 100, orient: "horizontal", left: "center", bottom: 0, textStyle: { color: theme.muted }, inRange: { color: ["#b91c1c", "#fbbf24", "#15803d"] } },
    series: [{ type: "heatmap", data: view.matrix, label: { show: true, formatter: ({ value }) => `${value[2]}%\n(n=${value[3]})`, color: theme.text } }],
    tooltip: {
      ...base.tooltip,
      formatter: ({ value }) => `${view.chats[value[0]]}<br/>${view.embeds[value[1]]}<br/><strong>${value[2]}%</strong><br/>звітів: ${value[3]}`,
    },
  };

  const duplicatePairs = [...view.grouped.values()].filter((group) => group.reports > 1).length;
  const datasetKeys = new Set(items.map((item) => item.datasetHash).filter(Boolean));
  const environmentKeys = new Set(
    items.map((item) => item.environment && JSON.stringify(item.environment)).filter(Boolean),
  );

  return (
    <div className="dp-report-dashboard">
      <div className="dp-report-block-title">
        <strong>Порівняння звітів ({items.length})</strong>
        <div className="muted dp-small">Один рядок — один окремий JSON-прогін.</div>
      </div>
      {duplicatePairs > 0 ? (
        <div className="dp-alert dp-alert-info">
          Деякі звіти мають однакову пару моделей. У matrix вони об’єднані як повторні прогони; перевірте, що це очікувані повтори, а не помилка перемикання моделей.
        </div>
      ) : null}
      {items.some((item) => item.completeness < 100) ? (
        <div className="dp-alert">У вибірці є незавершені звіти; їхні показники не можна напряму порівнювати з повними.</div>
      ) : null}
      {items.some((item) => !item.datasetHash) ? (
        <div className="dp-alert">Принаймні один старий звіт не містить dataset hash, тому тотожність тестових наборів не підтверджена.</div>
      ) : datasetKeys.size > 1 ? (
        <div className="dp-alert">Вибрані звіти мають різні тестові набори. Таке порівняння не є науково коректним.</div>
      ) : null}
      {items.some((item) => !item.environment) || environmentKeys.size > 1 ? (
        <div className="dp-alert dp-alert-info">Середовище виконання відрізняється або не записане в старих звітах. Порівнюйте ресурсні метрики обережно.</div>
      ) : null}

      <div className="dp-scroll-x">
        <table className="dp-table">
          <thead><tr><th>Chat model</th><th>Embedding</th><th>Набір</th><th>Режимів</th><th>Повнота</th><th>Успішність</th><th>UK / EN</th><th>Час avg / p95</th><th>t/s</th><th>Ollama RAM</th><th>GPU</th><th>Метрики</th><th>Потоки</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.name} title={item.name}>
                <td>{item.models.chat}<div className="muted dp-small">{modelInfo(item.modelDetails?.chat)}</div></td>
                <td>{item.models.embed}<div className="muted dp-small">{modelInfo(item.modelDetails?.embed)}</div></td>
                <td title={item.datasetHash || "Хеш не записаний"}>{shortHash(item.datasetHash)}</td>
                <td className="dp-num">{item.modeCount}</td>
                <td className="dp-num">{item.actualRuns}/{item.expectedRuns} ({pct(item.completeness)})</td>
                <td className="dp-num">{pct(item.passRate)}</td>
                <td className="dp-num">{pct(item.ukPassRate)} / {pct(item.enPassRate)}</td>
                <td className="dp-num">{seconds(item.avgTimeMs)} / {seconds(item.p95TimeMs)}</td>
                <td className="dp-num">{Number.isFinite(item.avgTps) ? item.avgTps.toFixed(1) : "—"}</td>
                <td className="dp-num">{Number.isFinite(item.avgRam) ? `${Math.round(item.avgRam)} MB` : "—"}</td>
                <td className="dp-num">{pct(item.avgGpu)}</td>
                <td className="dp-num">{pct(item.metricsCoverage)}</td>
                <td className="dp-num">{item.initialConcurrency ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="dp-chart-grid">
        <div className="dp-chart-card"><div className="dp-chart-title"><strong>Якість моделей і мов</strong></div><EChart option={qualityOption} style={{ height: 360 }} /></div>
        <div className="dp-chart-card"><div className="dp-chart-title"><strong>Pareto: якість × час</strong><span className="muted dp-small">розмір = Ollama RAM</span></div><EChart option={scatterOption} style={{ height: 360 }} /></div>
        {view.chats.length > 1 || view.embeds.length > 1 ? <div className="dp-chart-card"><div className="dp-chart-title"><strong>Матриця: chat × embedding</strong><span className="muted dp-small">успішність; n = звітів</span></div><EChart option={matrixOption} style={{ height: Math.max(330, view.embeds.length * 70) }} /></div> : null}
      </div>
    </div>
  );
}
