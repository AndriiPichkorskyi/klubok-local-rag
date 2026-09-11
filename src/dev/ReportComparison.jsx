import { useMemo } from "react";
import EChart from "./EChart";
import { dt } from "./i18n";

function pct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function seconds(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(2)} ${dt("common.seconds")}` : "—";
}

function modelLabel(item) {
  return `${item.models.chat} + ${item.models.embed}`;
}

function modelInfo(details) {
  if (!details) return dt("comparison.noMetadata");
  return [details.parameterSize, details.quantizationLevel].filter(Boolean).join(" · ") || dt("comparison.noMetadata");
}

function shortHash(value) {
  return value ? value.slice(0, 10) : "—";
}

/** Ті самі токени дизайн-системи, що й у ReportCharts. */
function cssVar(name, fallback) {
  if (typeof window === "undefined" || !document.documentElement) return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function colors() {
  return {
    text: cssVar("--fg", "#1d1d1f"),
    muted: cssVar("--muted", "#6e6e73"),
    line: cssVar("--line", "#e5e5e5"),
    panel: cssVar("--surface", "#ffffff"),
    accent: cssVar("--accent", "#7d82b8"),
    sage: "#81968f",
    taupe: "#c7c4b9",
    ramp: ["#b4867f", "#c7c4b9", "#81968f"],
  };
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
    legend: { data: [dt("comparison.total"), dt("comparison.ukrainian"), dt("comparison.english")], textStyle: { color: theme.text } },
    xAxis: { type: "category", data: items.map(modelLabel), axisLabel: { color: theme.muted, rotate: items.length > 3 ? 30 : 0 } },
    yAxis: { type: "value", min: 0, max: 100, name: dt("comparison.successPct"), axisLabel: { color: theme.muted } },
    series: [
      { name: dt("comparison.total"), type: "bar", data: items.map((item) => item.passRate), itemStyle: { color: theme.accent } },
      { name: dt("comparison.ukrainian"), type: "bar", data: items.map((item) => item.ukPassRate), itemStyle: { color: theme.sage } },
      { name: dt("comparison.english"), type: "bar", data: items.map((item) => item.enPassRate), itemStyle: { color: theme.taupe } },
    ],
  };

  const scatterOption = {
    ...base,
    xAxis: { type: "value", name: dt("comparison.averageTime"), axisLabel: { color: theme.muted } },
    yAxis: { type: "value", min: 0, max: 100, name: dt("comparison.successPct"), axisLabel: { color: theme.muted } },
    series: [{
      type: "scatter",
      data: items.map((item) => ({
        name: modelLabel(item),
        value: [item.avgTimeMs / 1000, item.passRate, item.avgRam || 0, item.avgGpu],
      })),
      symbolSize: (value) => Math.max(9, Math.min(34, (value[2] || 512) / 220)),
      itemStyle: { color: theme.accent, opacity: 0.8 },
    }],
    tooltip: {
      ...base.tooltip,
      formatter: ({ data }) => `<strong>${data.name}</strong><br/>${dt("comparison.success")}: ${pct(data.value[1])}<br/>${dt("comparison.time")}: ${data.value[0].toFixed(2)} ${dt("common.seconds")}<br/>RAM: ${data.value[2] ? Math.round(data.value[2]) + " MB" : "—"}<br/>GPU: ${pct(data.value[3])}`,
    },
  };

  const matrixOption = {
    ...base,
    grid: { left: 150, right: 25, top: 15, bottom: 65 },
    xAxis: { type: "category", data: view.chats, axisLabel: { color: theme.muted, rotate: 25 } },
    yAxis: { type: "category", data: view.embeds, axisLabel: { color: theme.muted } },
    visualMap: { min: 0, max: 100, orient: "horizontal", left: "center", bottom: 0, textStyle: { color: theme.muted }, inRange: { color: theme.ramp } },
    series: [{ type: "heatmap", data: view.matrix, label: { show: true, formatter: ({ value }) => `${value[2]}%\n(n=${value[3]})`, color: theme.text } }],
    tooltip: {
      ...base.tooltip,
      formatter: ({ value }) => `${view.chats[value[0]]}<br/>${view.embeds[value[1]]}<br/><strong>${value[2]}%</strong><br/>${dt("comparison.reportsCount", { count: value[3] })}`,
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
        <strong>{dt("comparison.title", { count: items.length })}</strong>
        <div className="muted dp-small">{dt("comparison.oneRow")}</div>
      </div>
      {duplicatePairs > 0 ? (
        <div className="dp-alert dp-alert-info">
          {dt("comparison.duplicates")}
        </div>
      ) : null}
      {items.some((item) => item.completeness < 100) ? (
        <div className="dp-alert">{dt("comparison.incomplete")}</div>
      ) : null}
      {items.some((item) => !item.datasetHash) ? (
        <div className="dp-alert">{dt("comparison.noHash")}</div>
      ) : datasetKeys.size > 1 ? (
        <div className="dp-alert">{dt("comparison.differentDatasets")}</div>
      ) : null}
      {items.some((item) => !item.environment) || environmentKeys.size > 1 ? (
        <div className="dp-alert dp-alert-info">{dt("comparison.environments")}</div>
      ) : null}

      <div className="dp-scroll-x">
        <table className="dp-table">
          <thead><tr><th>{dt("comparison.chatModel")}</th><th>{dt("comparison.embeddingModel")}</th><th>{dt("comparison.headers.dataset")}</th><th>{dt("comparison.headers.modes")}</th><th>{dt("comparison.headers.completeness")}</th><th>{dt("comparison.headers.success")}</th><th>UK / EN</th><th>{dt("comparison.headers.time")}</th><th>t/s</th><th>Ollama RAM</th><th>GPU</th><th>{dt("comparison.headers.metrics")}</th><th>{dt("comparison.headers.threads")}</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.name} title={item.name}>
                <td>{item.models.chat}<div className="muted dp-small">{modelInfo(item.modelDetails?.chat)}</div></td>
                <td>{item.models.embed}<div className="muted dp-small">{modelInfo(item.modelDetails?.embed)}</div></td>
                <td title={item.datasetHash || dt("comparison.hashMissing")}>{shortHash(item.datasetHash)}</td>
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
        <div className="dp-chart-card"><div className="dp-chart-title"><strong>{dt("comparison.qualityLanguages")}</strong></div><EChart option={qualityOption} style={{ height: 360 }} /></div>
        <div className="dp-chart-card"><div className="dp-chart-title"><strong>{dt("comparison.pareto")}</strong><span className="muted dp-small">{dt("comparison.sizeHint")}</span></div><EChart option={scatterOption} style={{ height: 360 }} /></div>
        {view.chats.length > 1 || view.embeds.length > 1 ? <div className="dp-chart-card"><div className="dp-chart-title"><strong>{dt("comparison.matrix")}</strong><span className="muted dp-small">{dt("comparison.matrixHint")}</span></div><EChart option={matrixOption} style={{ height: Math.max(330, view.embeds.length * 70) }} /></div> : null}
      </div>
    </div>
  );
}
