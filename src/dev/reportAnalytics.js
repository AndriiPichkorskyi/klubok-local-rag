const AXES = ["search", "xml", "reorder", "systemPrompt", "seed", "temperature"];

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function mean(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function modelsOf(report) {
  if (Array.isArray(report?.models)) {
    return { chat: report.models[1] || report.models[0] || "—", embed: report.models[0] || "—" };
  }
  return {
    chat: report?.models?.chat || "—",
    embed: report?.models?.embed || "—",
  };
}

export function reportModeRows(report) {
  return Object.entries(report?.modes || {}).map(([name, entry]) => {
    const summary = entry?.summary || {};
    const results = Array.isArray(entry?.results) ? entry.results : [];
    const total = (finite(summary.passed) || 0) + (finite(summary.failed) || 0) || results.length;
    const timeValues = results.map((result) => result.timeMs).filter(Number.isFinite);
    return {
      name,
      params: entry?.params || {},
      summary,
      results,
      total,
      passed: finite(summary.passed) ?? results.filter((result) => result.isSuccess).length,
      passRate: finite(summary.passRate),
      avgTimeMs: timeValues.length
        ? mean(timeValues)
        : total > 0 && finite(summary.totalTimeMs) !== null
          ? summary.totalTimeMs / total
          : null,
      avgTps: finite(summary.avgTps),
      avgRam: finite(summary.avgSysRam),
      avgGpu: finite(summary.avgSysGpuPercent),
    };
  });
}

function groupedPassRates(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row.params?.[key];
    if (value === undefined || value === null) continue;
    const label = String(value);
    const current = groups.get(label) || { passed: 0, total: 0 };
    current.passed += row.passed;
    current.total += row.total;
    groups.set(label, current);
  }
  return [...groups.entries()].map(([value, score]) => ({
    value,
    passRate: score.total ? (score.passed / score.total) * 100 : null,
    total: score.total,
  }));
}

function languageBySearch(rows) {
  const groups = new Map();
  for (const row of rows) {
    const search = row.params?.search;
    if (!search) continue;
    const current = groups.get(search) || {
      uk: { passed: 0, total: 0 },
      en: { passed: 0, total: 0 },
    };
    for (const language of ["uk", "en"]) {
      const bucket = row.summary?.byLanguage?.[language];
      if (!bucket) continue;
      current[language].passed += finite(bucket.passed) || 0;
      current[language].total += finite(bucket.cases) || 0;
    }
    groups.set(search, current);
  }
  return [...groups.entries()].map(([search, value]) => {
    const uk = value.uk.total ? (value.uk.passed / value.uk.total) * 100 : null;
    const en = value.en.total ? (value.en.passed / value.en.total) * 100 : null;
    return { search, uk, en, gap: uk !== null && en !== null ? uk - en : null };
  });
}

function heatmap(rows) {
  const searches = [...new Set(rows.map((row) => row.params?.search).filter(Boolean))];
  const prompts = [...new Set(rows.map((row) => row.params?.systemPrompt).filter(Boolean))];
  const groups = new Map();
  for (const row of rows) {
    const x = prompts.indexOf(row.params?.systemPrompt);
    const y = searches.indexOf(row.params?.search);
    if (x < 0 || y < 0) continue;
    const key = `${x}:${y}`;
    const current = groups.get(key) || { passed: 0, total: 0 };
    current.passed += row.passed;
    current.total += row.total;
    groups.set(key, current);
  }
  const data = [...groups.entries()].map(([key, score]) => {
    const [x, y] = key.split(":").map(Number);
    return [x, y, score.total ? Number(((score.passed / score.total) * 100).toFixed(1)) : null];
  });
  return { searches, prompts, data };
}

function recurringFailures(rows) {
  const groups = new Map();
  for (const row of rows) {
    for (const result of row.results) {
      const key = result.comparisonId
        ? `${result.comparisonId}:${result.language || "?"}`
        : `${result.query}:${result.language || "?"}`;
      const current = groups.get(key) || {
        query: result.query,
        language: result.language || "?",
        expected: result.expectedApp,
        failed: 0,
        attempts: 0,
      };
      current.attempts += 1;
      if (result.isSuccess !== true) current.failed += 1;
      groups.set(key, current);
    }
  }
  return [...groups.values()]
    .map((item) => ({ ...item, failRate: item.attempts ? (item.failed / item.attempts) * 100 : 0 }))
    .filter((item) => item.failed > 0)
    .sort((left, right) => right.failRate - left.failRate || right.failed - left.failed)
    .slice(0, 15);
}

export function analyzeReport(report) {
  const rows = reportModeRows(report);
  const results = rows.flatMap((row) => row.results);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const passed = rows.reduce((sum, row) => sum + row.passed, 0);
  const actualRuns = results.length || total;
  const expectedRuns = finite(report?.expectedRuns) ?? actualRuns;
  const best = rows
    .filter((row) => Number.isFinite(row.passRate))
    .sort((left, right) => right.passRate - left.passRate || left.avgTimeMs - right.avgTimeMs)[0];
  const latencies = results.map((result) => result.timeMs).filter(Number.isFinite);
  const metricSamples = results.filter(
    (result) => Number.isFinite(result.sysGpuPercent) && Number.isFinite(result.sysOllamaRamMB),
  ).length;

  return {
    rows,
    models: modelsOf(report),
    expectedRuns,
    actualRuns,
    completeness: expectedRuns ? (actualRuns / expectedRuns) * 100 : 100,
    passRate: total ? (passed / total) * 100 : null,
    best,
    medianTimeMs: percentile(latencies, 0.5),
    p95TimeMs: percentile(latencies, 0.95),
    metricsCoverage: results.length ? (metricSamples / results.length) * 100 : null,
    axisGroups: AXES.map((axis) => ({ axis, values: groupedPassRates(rows, axis) })).filter(
      (group) => group.values.length > 1,
    ),
    heatmap: heatmap(rows),
    languageBySearch: languageBySearch(rows),
    failures: recurringFailures(rows),
    scatter: rows
      .filter((row) => Number.isFinite(row.passRate) && Number.isFinite(row.avgTimeMs))
      .map((row) => ({
        name: row.name,
        value: [row.avgTimeMs / 1000, row.passRate, row.avgRam || 0, row.avgGpu],
        params: row.params,
      })),
  };
}

export function summarizeReport(name, report) {
  const analytics = analyzeReport(report);
  const results = analytics.rows.flatMap((row) => row.results);
  const language = report?.languageBreakdown?.totals || {};
  return {
    name,
    timestamp: report?.timestamp || null,
    models: analytics.models,
    modeCount: analytics.rows.length,
    actualRuns: analytics.actualRuns,
    expectedRuns: analytics.expectedRuns,
    completeness: analytics.completeness,
    passRate: analytics.passRate,
    ukPassRate: finite(language.uk?.passRate),
    enPassRate: finite(language.en?.passRate),
    avgTimeMs: mean(results.map((result) => result.timeMs)),
    p95TimeMs: percentile(results.map((result) => result.timeMs), 0.95),
    avgTps: mean(results.map((result) => result.tokensPerSecond)),
    avgRam: mean(results.map((result) => result.sysOllamaRamMB)),
    avgGpu: mean(results.map((result) => result.sysGpuPercent)),
    metricsCoverage: analytics.metricsCoverage,
    initialConcurrency: report?.initialConcurrency ?? null,
    benchmarkKind: report?.benchmarkKind || null,
    totalCases: report?.totalCases ?? null,
    datasetHash: report?.datasetHash || null,
    environment: report?.environment || null,
    modelDetails: report?.modelDetails || null,
  };
}
