import fs from "fs/promises";
import os from "os";
import path from "path";

const METRICS_PATH = path.join(os.tmpdir(), "ollama_metrics.json");
const POLL_INTERVAL_MS = 250;
const MAX_SAMPLE_AGE_MS = 3_000;

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function average(samples, key) {
  const values = samples.map((sample) => finite(sample[key])).filter((value) => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Збирає унікальні системні зрізи протягом одного запиту до RAG.
 * Rust оновлює файл із паузою в одну секунду між системними зрізами, тому
 * частіше опитування потрібне лише для межі короткого запиту; дублікати
 * прибирає sampled_at_ms.
 */
export function createSystemMetricsSampler() {
  const startedAtMs = Date.now();
  const samples = new Map();
  let timer = null;
  let pending = Promise.resolve();

  async function readSample() {
    try {
      const raw = await fs.readFile(METRICS_PATH, "utf8");
      const sample = JSON.parse(raw);
      const sampledAtMs = finite(sample.sampled_at_ms);
      if (
        sampledAtMs === null ||
        sampledAtMs < startedAtMs ||
        Date.now() - sampledAtMs > MAX_SAMPLE_AGE_MS
      ) {
        return;
      }
      samples.set(sampledAtMs, sample);
    } catch {
      // Tauri може ще не створити перший зріз або метрики можуть бути недоступні.
    }
  }

  function capture() {
    pending = pending.then(readSample);
    return pending;
  }

  return {
    start() {
      capture();
      timer = setInterval(capture, POLL_INTERVAL_MS);
      timer.unref?.();
    },

    async stop() {
      if (timer) clearInterval(timer);
      await capture();
      const values = [...samples.values()];
      const gpuValues = values
        .map((sample) => finite(sample.gpu_percent))
        .filter((value) => value !== null);

      return {
        sampleCount: values.length,
        ollamaRamMbAvg: average(values, "ram_mb"),
        powerScoreAvg: average(values, "power_score"),
        gpuPercentAvg: average(values, "gpu_percent"),
        gpuPercentMax: gpuValues.length > 0 ? Math.max(...gpuValues) : null,
        gpuMemoryMbAvg: average(values, "gpu_memory_mb"),
      };
    },
  };
}
