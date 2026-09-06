import { useMemo } from "react";
import { analyzeReport } from "./reportAnalytics";
import { formatBytes } from "./format";
import EChart from "./EChart";
import { dt } from "./i18n";

const AXIS_LABELS = {
  search: "charts.axes.search",
  xml: "XML",
  reorder: "Reorder",
  systemPrompt: "charts.axes.prompt",
  seed: "Seed",
  temperature: "charts.axes.temperature",
};

function palette() {
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return dark
    ? { text: "#e8eaed", muted: "#9aa1ac", line: "#2a2e37", panel: "#1d2027" }
    : { text: "#16181d", muted: "#6b7280", line: "#e5e7eb", panel: "#f7f8fa" };
}

function baseOption() {
  const colors = palette();
  return {
    animation: false,
    textStyle: { color: colors.text, fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif" },
    tooltip: { trigger: "item", backgroundColor: colors.panel, borderColor: colors.line, textStyle: { color: colors.text } },
    grid: { left: 48, right: 24, top: 24, bottom: 48, containLabel: true },
  };
}

function pct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function seconds(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(2)} ${dt("charts.seconds")}` : "—";
}

function modelDescription(details) {
  if (!details) return dt("charts.noMetadata");
  return [
    details.parameterSize,
    details.quantizationLevel,
    Number.isFinite(details.sizeBytes) ? formatBytes(details.sizeBytes) : null,
    details.family,
  ].filter(Boolean).join(" · ") || dt("charts.metadataUnavailable");
}

function shortHash(value) {
  return value ? `${value.slice(0, 12)}…` : dt("charts.noMetadata");
}

function ChartCard({ title, hint, option, height = 320 }) {
  return (
    <div className="dp-chart-card">
      <div className="dp-chart-title">
        <strong>{title}</strong>
        {hint ? <span className="muted dp-small">{hint}</span> : null}
      </div>
      <EChart option={option} style={{ height }} />
    </div>
  );
}

export default function ReportCharts({ data }) {
  const analytics = useMemo(() => analyzeReport(data), [data]);
  const colors = palette();
  const repeatedSeedGroups = Object.entries(data.seedGroups || {}).filter(
    ([, group]) => Number(group?.runs) > 1,
  );
  const axisImpact = Object.entries(data.axisImpact || {});

  const axisItems = analytics.axisGroups.flatMap((group) =>
    group.values.map((item) => ({
      axis: group.axis,
      label: `${AXIS_LABELS[group.axis] ? dt(AXIS_LABELS[group.axis]) : group.axis}: ${item.value}`,
      value: item.passRate,
      total: item.total,
    })),
  );
  const axisOption = {
    ...baseOption(),
    xAxis: {
      type: "category",
      data: axisItems.map((item) => item.label),
      axisLabel: { color: colors.muted, rotate: axisItems.length > 7 ? 35 : 0 },
    },
    yAxis: { type: "value", min: 0, max: 100, name: dt("charts.successPct"), axisLabel: { color: colors.muted } },
    series: [{
      type: "bar",
      data: axisItems.map((item) => ({ value: item.value, itemStyle: { color: "#2563eb" }, total: item.total })),
      label: { show: true, position: "top", formatter: ({ value }) => `${Number(value).toFixed(0)}%`, color: colors.text },
    }],
    tooltip: {
      ...baseOption().tooltip,
      formatter: ({ name, data: item }) => `${name}<br/><strong>${pct(item.value)}</strong><br/>${dt("charts.observations")}: ${item.total}`,
    },
  };

  const heatmapOption = {
    ...baseOption(),
    grid: { left: 90, right: 30, top: 18, bottom: 50 },
    xAxis: { type: "category", data: analytics.heatmap.prompts, axisLabel: { color: colors.muted } },
    yAxis: { type: "category", data: analytics.heatmap.searches, axisLabel: { color: colors.muted } },
    visualMap: {
      min: 0,
      max: 100,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      textStyle: { color: colors.muted },
      inRange: { color: ["#b91c1c", "#fbbf24", "#15803d"] },
    },
    series: [{
      type: "heatmap",
      data: analytics.heatmap.data,
      label: { show: true, formatter: ({ value }) => `${value[2]}%`, color: colors.text },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,.35)" } },
    }],
    tooltip: {
      ...baseOption().tooltip,
      formatter: ({ value }) =>
        `${analytics.heatmap.searches[value[1]]} + ${analytics.heatmap.prompts[value[0]]}<br/><strong>${value[2]}%</strong>`,
    },
  };

  const scatterOption = {
    ...baseOption(),
    xAxis: { type: "value", name: dt("charts.averageTime"), axisLabel: { color: colors.muted } },
    yAxis: { type: "value", min: 0, max: 100, name: dt("charts.successPct"), axisLabel: { color: colors.muted } },
    series: [{
      type: "scatter",
      data: analytics.scatter,
      symbolSize: (value) => Math.max(8, Math.min(28, (value[2] || 512) / 250)),
      itemStyle: { color: "#2563eb", opacity: 0.75 },
    }],
    tooltip: {
      ...baseOption().tooltip,
      formatter: ({ data: item }) =>
        `<strong>${item.name}</strong><br/>${dt("charts.success")}: ${pct(item.value[1])}<br/>${dt("charts.time")}: ${item.value[0].toFixed(2)} ${dt("charts.seconds")}<br/>Ollama RAM: ${item.value[2] ? Math.round(item.value[2]) + " MB" : "—"}<br/>GPU: ${pct(item.value[3])}`,
    },
  };

  const languageOption = {
    ...baseOption(),
    legend: { data: [dt("charts.ukrainian"), dt("charts.english")], textStyle: { color: colors.text } },
    xAxis: { type: "category", data: analytics.languageBySearch.map((item) => item.search), axisLabel: { color: colors.muted } },
    yAxis: { type: "value", min: 0, max: 100, name: dt("charts.successPct"), axisLabel: { color: colors.muted } },
    series: [
      { name: dt("charts.ukrainian"), type: "bar", data: analytics.languageBySearch.map((item) => item.uk), itemStyle: { color: "#2563eb" } },
      { name: dt("charts.english"), type: "bar", data: analytics.languageBySearch.map((item) => item.en), itemStyle: { color: "#f59e0b" } },
    ],
  };

  const failureOption = {
    ...baseOption(),
    grid: { left: 210, right: 28, top: 12, bottom: 35 },
    xAxis: { type: "value", min: 0, max: 100, name: dt("charts.failurePct"), axisLabel: { color: colors.muted } },
    yAxis: {
      type: "category",
      inverse: true,
      data: analytics.failures.map((item) => item.query.length > 34 ? `${item.query.slice(0, 34)}…` : item.query),
      axisLabel: { color: colors.muted },
    },
    series: [{ type: "bar", data: analytics.failures.map((item) => item.failRate), itemStyle: { color: "#b91c1c" } }],
    tooltip: {
      ...baseOption().tooltip,
      formatter: ({ dataIndex, value }) => {
        const item = analytics.failures[dataIndex];
        return `<strong>${item.query}</strong><br/>${dt("charts.language")}: ${item.language}<br/>${dt("charts.failures")}: ${item.failed}/${item.attempts} (${Number(value).toFixed(1)}%)`;
      },
    },
  };

  return (
    <div className="dp-report-dashboard">
      <div className="dp-kpi-grid">
        <div className="dp-kpi"><span>{dt("charts.completeness")}</span><strong>{analytics.actualRuns}/{analytics.expectedRuns}</strong><small>{pct(analytics.completeness)}</small></div>
        <div className="dp-kpi"><span>{dt("charts.overallSuccess")}</span><strong>{pct(analytics.passRate)}</strong><small>{analytics.models.chat}</small></div>
        <div className="dp-kpi"><span>{dt("charts.bestMode")}</span><strong>{analytics.best ? pct(analytics.best.passRate) : "—"}</strong><small title={analytics.best?.name}>{analytics.best?.name || "—"}</small></div>
        <div className="dp-kpi"><span>{dt("charts.medianP95")}</span><strong>{seconds(analytics.medianTimeMs)}</strong><small>p95: {seconds(analytics.p95TimeMs)}</small></div>
        <div className="dp-kpi"><span>{dt("charts.metricsCoverage")}</span><strong>{pct(analytics.metricsCoverage)}</strong><small>GPU + Ollama RAM</small></div>
      </div>

      <div className="dp-scroll-x">
        <table className="dp-table">
          <thead><tr><th>{dt("charts.reproducibility")}</th><th>{dt("charts.value")}</th></tr></thead>
          <tbody>
            <tr><td>{dt("charts.dataset")}</td><td title={data.datasetHash || undefined}>{shortHash(data.datasetHash)}</td></tr>
            <tr><td>{dt("charts.chatModel")}</td><td>{analytics.models.chat}<div className="muted dp-small">{modelDescription(data.modelDetails?.chat)}</div></td></tr>
            <tr><td>{dt("charts.embeddingModel")}</td><td>{analytics.models.embed}<div className="muted dp-small">{modelDescription(data.modelDetails?.embed)}</div></td></tr>
            <tr><td>{dt("charts.environment")}</td><td>{data.environment ? `${data.environment.platform} ${data.environment.release} · ${data.environment.arch} · ${data.environment.cpu} · ${data.environment.logicalCpus} ${dt("charts.logicalCpu")} · ${data.environment.totalMemoryMB} MB RAM · Node ${data.environment.nodeVersion}` : dt("charts.noMetadata")}</td></tr>
            <tr><td>{dt("charts.matrix")}</td><td>{data.benchmarkKind || "—"} · {analytics.rows.length} {dt("charts.modes")} · {data.totalCases ?? "—"} {dt("charts.cases")} · {data.initialConcurrency ?? "—"} {dt("charts.threads")}</td></tr>
          </tbody>
        </table>
      </div>

      {analytics.completeness < 100 ? (
        <div className="dp-alert">{dt("charts.incomplete")}</div>
      ) : null}

      {analytics.axisGroups.length > 0 ? (
        <div className="dp-scroll-x">
          <table className="dp-table">
            <thead><tr><th>{dt("charts.factor")}</th><th>{dt("charts.bestValue")}</th><th>{dt("reportTable.headers.success")}</th><th>{dt("charts.spread")}</th></tr></thead>
            <tbody>
              {analytics.axisGroups.map((group) => {
                const ordered = [...group.values].sort((left, right) => right.passRate - left.passRate);
                const spread = ordered.length > 1 ? ordered[0].passRate - ordered.at(-1).passRate : 0;
                return <tr key={group.axis}><td>{AXIS_LABELS[group.axis] ? dt(AXIS_LABELS[group.axis]) : group.axis}</td><td>{ordered[0].value}</td><td className="dp-num">{pct(ordered[0].passRate)}</td><td className="dp-num">{spread.toFixed(1)} {dt("reportTable.points")}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {repeatedSeedGroups.length > 0 ? (
        <div className="dp-scroll-x">
          <table className="dp-table">
            <thead><tr><th>{dt("charts.seedStability")}</th><th>{dt("charts.runs")}</th><th>{dt("charts.average")}</th><th>{dt("charts.minMax")}</th><th>σ</th><th>{dt("charts.value")}</th></tr></thead>
            <tbody>
              {repeatedSeedGroups.map(([name, group]) => (
                <tr key={name}>
                  <td>{name}</td><td className="dp-num">{group.runs}</td>
                  <td className="dp-num">{pct(group.passRate?.mean)}</td>
                  <td className="dp-num">{pct(group.passRate?.min)}–{pct(group.passRate?.max)}</td>
                  <td className="dp-num">{Number.isFinite(group.passRate?.stdev) ? group.passRate.stdev.toFixed(2) : "—"}</td>
                  <td className="dp-num">{group.passRate?.values?.map((value) => `${value}%`).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {axisImpact.length > 0 ? (
        <div className="dp-scroll-x">
          <table className="dp-table">
            <thead><tr><th>{dt("charts.outputSensitivity")}</th><th>{dt("charts.caseComparisons")}</th><th>{dt("charts.outputChanged")}</th><th>{dt("charts.identical")}</th><th>{dt("charts.conclusion")}</th></tr></thead>
            <tbody>
              {axisImpact.map(([axis, impact]) => (
                <tr key={axis}>
                  <td>{AXIS_LABELS[axis] ? dt(AXIS_LABELS[axis]) : axis}</td><td className="dp-num">{impact.cases}</td>
                  <td className="dp-num">{Number.isFinite(impact.identicalPct) ? `${100 - impact.identicalPct}%` : "—"}</td>
                  <td className="dp-num">{impact.identical}/{impact.cases} ({impact.identicalPct}%)</td>
                  <td className={impact.inert ? "dp-err" : "dp-ok"}>{dt(impact.inert ? "charts.axisInert" : "charts.axisAffects")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted dp-small">{dt("charts.sensitivityHint")}</div>
        </div>
      ) : null}

      <div className="dp-chart-grid">
        {axisItems.length > 0 ? <ChartCard title={dt("charts.factorImpact")} hint={dt("charts.factorHint")} option={axisOption} /> : null}
        {analytics.heatmap.searches.length > 1 && analytics.heatmap.prompts.length > 1 ? <ChartCard title={dt("charts.heatmap")} hint={dt("charts.heatmapHint")} option={heatmapOption} /> : null}
        {analytics.scatter.length > 1 ? <ChartCard title={dt("charts.qualitySpeed")} hint={dt("charts.qualitySpeedHint")} option={scatterOption} /> : null}
        {analytics.languageBySearch.length > 0 ? <ChartCard title={dt("charts.languages")} hint={dt("charts.languagesHint")} option={languageOption} /> : null}
        {analytics.failures.length > 0 ? <ChartCard title={dt("charts.hardest")} hint={dt("charts.hardestHint")} option={failureOption} height={Math.max(320, analytics.failures.length * 30)} /> : null}
      </div>
    </div>
  );
}
