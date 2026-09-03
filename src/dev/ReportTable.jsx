/**
 * Таблиця звіту про тестування. Логіка й склад колонок повторюють
 * renderReportTable() з sidecar/src/cli/reports.js: ті самі величини,
 * те саме підсвічування успішності (100% — зелений, >=50% — жовтий, решта — червоний)
 * і ті самі підсумкові рядки. Різниця лише в тому, що замість padEnd —
 * звичайна HTML-таблиця.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { formatDateTime } from "./format";

const ReportCharts = lazy(() => import("./ReportCharts"));

const RESULT_FILTERS = [
  { id: "all", label: "Усі" },
  { id: "passed", label: "Тільки успішні" },
  { id: "failed", label: "Тільки провалені" },
];

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

function languageScore(bucket) {
  if (!bucket || !Number.isFinite(bucket.passRate) || !Number.isFinite(bucket.cases)) return "—";
  return `${bucket.passRate}% (${bucket.passed}/${bucket.cases})`;
}

function gapText(gap) {
  if (!Number.isFinite(gap)) return "—";
  return `${gap > 0 ? "+" : ""}${gap} п.п.`;
}

function gapClass(gap) {
  if (!Number.isFinite(gap) || gap === 0) return "muted";
  return gap > 0 ? "dp-ok" : "dp-err";
}

function expectedText(value) {
  if (Array.isArray(value)) return value.join(" або ");
  return value === undefined || value === null ? "—" : String(value);
}

function sourceIdFromRaw(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/["']?sourceId["']?\s*:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function flattenResults(data) {
  const rows = [];
  for (const [mode, entry] of Object.entries(data?.modes || {})) {
    const results = Array.isArray(entry?.results) ? entry.results : [];
    results.forEach((result, index) => rows.push({ mode, index, result }));
  }
  return rows;
}

function allModeFailures(rows, modeNames) {
  const grouped = new Map();
  for (const row of rows) {
    const pairId = row.result?.comparisonId;
    const language = row.result?.language;
    const key = pairId
      ? `${pairId}:${language || row.result?.query || row.index}`
      : row.result?.query || `${row.mode}:${row.index}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.values()].filter((attempts) => {
    const attemptedModes = new Set(attempts.map((row) => row.mode));
    return (
      modeNames.length > 0 &&
      attemptedModes.size === modeNames.length &&
      attempts.every((row) => row.result?.isSuccess !== true)
    );
  });
}

function contextLabel(result) {
  if (Array.isArray(result?.contextDocuments) && result.contextDocuments.length > 0) {
    return result.contextDocuments
      .map((doc) => `${doc.sourceId || "?"}. ${doc.appName || "?"} — ${doc.title || "Довідка"}`)
      .join("; ");
  }
  if (Array.isArray(result?.contextApps) && result.contextApps.length > 0) {
    return result.contextApps.join(", ");
  }
  return "—";
}

function resourceMetricsText(result) {
  const parts = [];
  if (Number.isFinite(result?.memoryUsageMB)) {
    parts.push(`Node RAM ${Math.round(result.memoryUsageMB)} MB`);
  }
  if (Number.isFinite(result?.sysOllamaRamMB)) {
    parts.push(`Ollama RAM ${Math.round(result.sysOllamaRamMB)} MB`);
  }
  if (Number.isFinite(result?.sysGpuPercent)) {
    const maximum = Number.isFinite(result.sysGpuPercentMax)
      ? `, max ${result.sysGpuPercentMax.toFixed(0)}%`
      : "";
    parts.push(`GPU системи avg ${result.sysGpuPercent.toFixed(1)}%${maximum}`);
  }
  if (Number.isFinite(result?.sysGpuMemoryMB)) {
    parts.push(`GPU-пам’ять ${Math.round(result.sysGpuMemoryMB)} MB`);
  }
  if (Number.isFinite(result?.sysPowerScore)) {
    parts.push(`Energy Impact ${result.sysPowerScore.toFixed(1)}`);
  }
  if (Number.isFinite(result?.sysMetricsSamples)) {
    parts.push(`зрізів ${result.sysMetricsSamples}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function ResultDetails({ result }) {
  const documents = Array.isArray(result?.contextDocuments) ? result.contextDocuments : [];
  const chosenSourceId = sourceIdFromRaw(result?.rawLlmOutput);

  return (
    <details className="dp-result-details">
      <summary>Показати</summary>
      <dl className="dp-result-meta">
        <dt>Причина</dt>
        <dd>{result?.reason || "—"}</dd>
        <dt>Відповідь LLM</dt>
        <dd>{result?.llmResponse || "—"}</dd>
        <dt>Сира відповідь</dt>
        <dd><pre>{result?.rawLlmOutput || "—"}</pre></dd>
        <dt>Пошук</dt>
        <dd>
          {result?.retrievalStats
            ? `${result.retrievalStats.searchMode || "?"}; чанків: ${result.retrievalStats.filteredChunks ?? "?"}`
            : "—"}
        </dd>
        <dt>Ресурси</dt>
        <dd>{resourceMetricsText(result)}</dd>
      </dl>

      <div className="dp-result-docs">
        <strong>Документи в контексті LLM</strong>
        {documents.length > 0 ? (
          <ol>
            {documents.map((doc, index) => {
              const sourceId = doc.sourceId || index + 1;
              return (
                <li key={`${sourceId}:${doc.appName}:${doc.title}`}>
                  <div>
                    <strong>{doc.appName || "Невідома програма"}</strong>
                    {` — ${doc.title || "Довідка"}`}
                    {chosenSourceId === sourceId ? <span className="dp-badge">вказано LLM</span> : null}
                  </div>
                  <div className="muted dp-small">
                    sourceId={sourceId}
                    {doc.sourceType ? ` · ${doc.sourceType}` : ""}
                    {Number.isFinite(doc.contentLength) ? ` · ${doc.contentLength} символів` : ""}
                  </div>
                  {doc.matchedChunk ? <blockquote>{doc.matchedChunk}</blockquote> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="muted dp-small">
            {Array.isArray(result?.contextApps) && result.contextApps.length > 0
              ? `Старий звіт зберіг лише програми: ${result.contextApps.join(", ")}.`
              : "Цей звіт створено до збереження контексту; перелік документів у ньому відсутній."}
          </div>
        )}
      </div>
    </details>
  );
}

export default function ReportTable({ data }) {
  const [resultFilter, setResultFilter] = useState("all");
  const detailRows = useMemo(() => flattenResults(data), [data]);
  const modeNames = useMemo(() => Object.keys(data?.modes || {}), [data]);
  const hardFailures = useMemo(
    () => allModeFailures(detailRows, modeNames),
    [detailRows, modeNames],
  );
  const filteredDetailRows = detailRows.filter(({ result }) => {
    if (resultFilter === "passed") return result?.isSuccess === true;
    if (resultFilter === "failed") return result?.isSuccess !== true;
    return true;
  });

  if (!data || typeof data !== "object" || !data.modes) {
    return <div className="dp-alert">Це не схоже на звіт: у JSON немає поля «modes».</div>;
  }

  const totalCases = data.totalCases || 0;
  const modelsText = Array.isArray(data.models)
    ? data.models.join(", ")
    : [data.models?.chat, data.models?.embed].filter(Boolean).join(" + ");
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
      nodeRam: Number.isFinite(summary.avgMem) ? `${Math.round(summary.avgMem)} MB` : "—",
      ollamaRam: Number.isFinite(summary.avgSysRam)
        ? `${Math.round(summary.avgSysRam)} MB`
        : "—",
      gpu: Number.isFinite(summary.avgSysGpuPercent)
        ? `${summary.avgSysGpuPercent.toFixed(1)}% / ${Number.isFinite(summary.maxSysGpuPercent) ? summary.maxSysGpuPercent.toFixed(0) : "—"}%`
        : "—",
      gpuMemory: Number.isFinite(summary.avgSysGpuMemoryMB)
        ? `${Math.round(summary.avgSysGpuMemoryMB)} MB`
        : "—",
      metricsSamples: Number.isFinite(summary.sysMetricsSamples)
        ? summary.sysMetricsSamples
        : "—",
    };
  });

  const languageRows = modeNames
    .map((mode) => {
      const byLanguage = data.modes[mode]?.summary?.byLanguage;
      const uk = byLanguage?.uk;
      const en = byLanguage?.en;
      if (!uk?.cases || !en?.cases) return null;
      return { mode, uk, en, gap: uk.passRate - en.passRate };
    })
    .filter(Boolean);
  const languageTotals = data.languageBreakdown?.totals;
  const totalGap =
    Number.isFinite(languageTotals?.uk?.passRate) && Number.isFinite(languageTotals?.en?.passRate)
      ? languageTotals.uk.passRate - languageTotals.en.passRate
      : null;

  return (
    <div>
      <div className="dp-small" style={{ marginBottom: 6 }}>
        <strong>Підсумкове порівняння режимів (search modes)</strong>
        <div className="muted">
          Дата звіту: {formatDateTime(data.timestamp)} · кейсів: {totalCases}
          {modelsText ? ` · моделі: ${modelsText}` : ""}
        </div>
      </div>

      <Suspense fallback={<div className="muted dp-small">Готую графіки…</div>}>
        <ReportCharts data={data} />
      </Suspense>

      <div className="dp-scroll-x">
        <table className="dp-table">
          <thead>
            <tr>
              <th>Режим</th>
              <th>Успішність</th>
              <th>Час (заг/сер)</th>
              <th>In/Out токени</th>
              <th>Швидкість</th>
              <th>Node RAM</th>
              <th>Ollama RAM</th>
              <th title="Середнє / максимум системного GPU протягом запитів">GPU сер./макс.</th>
              <th title="Уніфікована пам’ять, яку використовує GPU всієї системи">GPU-пам’ять</th>
              <th>Зрізів</th>
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
                <td className="dp-num">{row.nodeRam}</td>
                <td className="dp-num">{row.ollamaRam}</td>
                <td className="dp-num">{row.gpu}</td>
                <td className="dp-num">{row.gpuMemory}</td>
                <td className="dp-num">{row.metricsSamples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {languageRows.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="dp-small" style={{ marginBottom: 6 }}>
            <strong>Порівняння однакових задач за мовою</strong>
            <div className="muted">
              Різниця = українська − англійська; нейтральні запити не враховуються.
            </div>
          </div>
          <div className="dp-scroll-x">
            <table className="dp-table">
              <thead>
                <tr>
                  <th>Режим</th>
                  <th>Українська</th>
                  <th>Англійська</th>
                  <th>Різниця</th>
                </tr>
              </thead>
              <tbody>
                {languageRows.map((row) => (
                  <tr key={row.mode}>
                    <td>{row.mode}</td>
                    <td className={passRateClass(row.uk.passRate)}>{languageScore(row.uk)}</td>
                    <td className={passRateClass(row.en.passRate)}>{languageScore(row.en)}</td>
                    <td className={gapClass(row.gap)}>{gapText(row.gap)}</td>
                  </tr>
                ))}
                {languageTotals?.uk?.cases && languageTotals?.en?.cases ? (
                  <tr>
                    <td><strong>Усі режими</strong></td>
                    <td className={passRateClass(languageTotals.uk.passRate)}>
                      {languageScore(languageTotals.uk)}
                    </td>
                    <td className={passRateClass(languageTotals.en.passRate)}>
                      {languageScore(languageTotals.en)}
                    </td>
                    <td className={gapClass(totalGap)}>{gapText(totalGap)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {detailRows.length > 0 ? (
        <div className="dp-report-results">
          <div className="dp-report-block-title">
            <strong>Кейси, що провалили всі режими ({hardFailures.length})</strong>
            <div className="muted dp-small">
              Сюди потрапляє кейс, який має результат для кожного режиму звіту і ніде не пройшов.
            </div>
          </div>
          {hardFailures.length > 0 ? (
            <div className="dp-scroll-x">
              <table className="dp-table dp-result-table">
                <thead>
                  <tr>
                    <th>Запит</th>
                    <th>Очікувалось</th>
                    <th>Результати режимів</th>
                  </tr>
                </thead>
                <tbody>
                  {hardFailures.map((attempts) => {
                    const first = attempts[0].result;
                    return (
                      <tr key={`${first.comparisonId || first.query}:${first.language || "?"}`}>
                        <td className="dp-report-query">{first.query}</td>
                        <td className="dp-report-wrap">{expectedText(first.expectedApp)}</td>
                        <td className="dp-report-wrap">
                          {attempts.map(({ mode, result }) => (
                            <div key={mode}><strong>{mode}:</strong> {result.extractedApp || "—"}</div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dp-ok dp-small">Немає кейсів, які провалили всі режими.</div>
          )}

          <div className="dp-report-block-title">
            <strong>Усі результати построково ({filteredDetailRows.length}/{detailRows.length})</strong>
          </div>
          <div className="dp-result-filters" role="group" aria-label="Фільтр результатів">
            {RESULT_FILTERS.map((filter) => {
              const count = detailRows.filter(({ result }) =>
                filter.id === "all"
                  ? true
                  : filter.id === "passed"
                    ? result?.isSuccess === true
                    : result?.isSuccess !== true,
              ).length;
              return (
                <button
                  key={filter.id}
                  type="button"
                  className={resultFilter === filter.id ? "dp-selected" : undefined}
                  aria-pressed={resultFilter === filter.id}
                  onClick={() => setResultFilter(filter.id)}
                >
                  {filter.label} ({count})
                </button>
              );
            })}
          </div>

          <div className="dp-scroll-x">
            <table className="dp-table dp-result-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Статус</th>
                  <th>Режим</th>
                  <th>Запит</th>
                  <th>Очікувалось</th>
                  <th>Рекомендовано</th>
                  <th>Контекст</th>
                  <th>Деталі</th>
                </tr>
              </thead>
              <tbody>
                {filteredDetailRows.map(({ mode, index, result }) => (
                  <tr key={`${mode}:${index}:${result.query}`}>
                    <td className="dp-num">{index + 1}</td>
                    <td className={result.isSuccess ? "dp-ok" : "dp-err"}>
                      {result.isSuccess ? "✓" : "✗"}
                    </td>
                    <td className="dp-report-wrap">{mode}</td>
                    <td className="dp-report-query">{result.query}</td>
                    <td className="dp-report-wrap">{expectedText(result.expectedApp)}</td>
                    <td className="dp-report-wrap">{result.extractedApp || "—"}</td>
                    <td className="dp-report-context" title={contextLabel(result)}>
                      {contextLabel(result)}
                    </td>
                    <td><ResultDetails result={result} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="muted dp-small" style={{ marginTop: 14 }}>
          Цей звіт не містить построкових результатів.
        </div>
      )}

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
