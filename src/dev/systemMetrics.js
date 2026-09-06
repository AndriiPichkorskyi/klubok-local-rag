function metric(value, render) {
  return Number.isFinite(value) ? render(value) : null;
}

/** Короткий підпис живих системних метрик; недоступні значення не маскуємо нулем. */
export function formatLiveMetrics(metrics) {
  if (!metrics) return dt("metrics.waiting");

  const parts = [
    metric(metrics.ram_mb, (value) => `Ollama RAM: ${value.toFixed(0)} MB`),
    metric(metrics.gpu_percent, (value) => `${dt("metrics.systemGpu")}: ${value.toFixed(0)}%`),
    metric(metrics.gpu_memory_mb, (value) => `${dt("metrics.gpuMemory")}: ${value.toFixed(0)} MB`),
    metric(metrics.power_score, (value) => `Energy Impact: ${value.toFixed(1)}`),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : dt("metrics.unavailable");
}
import { dt } from "./i18n";

