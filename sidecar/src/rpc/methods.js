/**
 * Файл: src/rpc/methods.js
 * Опис: Реєстр RPC-методів. Кожен метод — тонка обгортка над уже наявним
 *       експортом sidecar. Жодної нової бізнес-логіки тут немає:
 *       контракт описано в docs/contracts/rpc.md.
 *
 * Сигнатура методу: async (params, ctx) => result
 *   params — об'єкт з запиту (може бути порожнім);
 *   ctx    — { id, onProgress(msg, pct), signal } для довгих операцій.
 */

import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { config, reloadConfig } from "../config/config.js";
import { db } from "../services/db.service.js";
import { ollama } from "../services/ollama.service.js";
import { check as bootstrapCheck, pullModel as bootstrapPullModel } from "../bootstrap/index.js";
import { processQuery } from "../modules/rag/engine.js";
import {
  runScanApps,
  runFetchDocs,
  runFetchLocalDocs,
  runKeywordAugmentation,
  runVectorize,
  runVectorizeIntents,
} from "../modules/indexer/pipeline.js";
import { runRagTests } from "../tests/test-rag.js";
import { runExternalTests } from "../tests/test-external.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Корінь sidecar/src — звідти дістаємо допоміжні скрипти */
const SRC_DIR = path.resolve(__dirname, "..");

/**
 * Реєстр активних довгих задач: id → { method, startedAt, cancelled }.
 * Заповнює сервер (server.js) на час виконання методу.
 */
export const jobs = new Map();

/**
 * Витягує відсоток із текстового повідомлення пайплайна.
 * Наявні колбеки віддають лише рядок на кшталт "[3/120] ..." або
 * "Чанк 5/40", тож pct обчислюємо з першої пари "i/n". Не знайшли — null,
 * як і дозволяє контракт.
 */
export function extractPct(msg) {
  if (typeof msg !== "string") return null;
  const match = msg.match(/(\d+)\s*(?:\/|з)\s*~?(\d+)/);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

/** Дозволені значення db.clear → відповідний виклик db-сервісу. */
const CLEAR_TARGETS = {
  all: () => db.clearAll(),
  web: () => db.clearDocumentsByType("WEB"),
  local: () => db.clearDocumentsByType("LOCAL"),
  apps: () => db.clearTable("apps"),
  document_links: () => db.clearTable("document_links"),
  raw_html: () => db.clearTable("raw_html"),
  web_documents: () => db.clearTable("web_documents"),
  lancedb: () => db.clearTable("lancedb"),
  intents: () => db.clearIntents(),
};

/**
 * Запускає окремий Node-процес (як це робить CLI для векторизації під іншу
 * модель) і транслює його stdout у прогрес.
 */
function runChildScript(scriptPath, envModel, onProgress) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (envModel) env.EMBED_MODEL = envModel;
    const child = spawn(process.execPath, [scriptPath], { env, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.on("data", (buf) => {
      const line = buf.toString().trim();
      if (line) onProgress(`[${envModel || "default"}] ${line}`);
    });
    child.stderr.on("data", (buf) => {
      const line = buf.toString().trim();
      if (line) onProgress(`[${envModel || "default"}] ${line}`);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(code)
        : reject(new Error(`Скрипт ${path.basename(scriptPath)} завершився з кодом ${code}`)),
    );
  });
}

export const methods = {
  /** Перевірка живості. Мусить відповідати миттєво навіть під час векторизації. */
  ping() {
    return { ok: true, pid: process.pid, version: process.env.npm_package_version || "1.0.0" };
  },

  /** Модуль 2.1: делегує у sidecar/src/bootstrap. */
  async "bootstrap.check"() {
    return await bootstrapCheck();
  },

  /** `ollama pull` зі стрімінгом прогресу. Логіка — в модулі 2.1. */
  async "bootstrap.pullModel"(params = {}, ctx) {
    return await bootstrapPullModel(params.model, (msg, pct) => ctx.onProgress(msg, pct ?? null));
  },

  /** Поточний конфіг. */
  "config.get"() {
    return config;
  },

  /** Перечитати pipeline.config.json з диска без перезапуску процесу. */
  "config.reload"() {
    return reloadConfig();
  },

  /** RAG-пошук: обгортка над processQuery(). */
  async query(params = {}, ctx) {
    const text = params.text;
    if (!text || !String(text).trim()) throw new Error("Не вказано параметр `text`.");
    return await processQuery(
      String(text),
      (msg) => ctx.onProgress(msg, extractPct(msg)),
      params.searchMode ?? null,
      params.excludeLocal ?? false,
    );
  },

  async "pipeline.scanApps"(params, ctx) {
    const newApps = await runScanApps((msg) => ctx.onProgress(msg, extractPct(msg)));
    return { newApps };
  },

  async "pipeline.fetchDocs"(params, ctx) {
    return await runFetchDocs((msg) => ctx.onProgress(msg, extractPct(msg)));
  },

  async "pipeline.fetchLocalDocs"(params, ctx) {
    return await runFetchLocalDocs((msg) => ctx.onProgress(msg, extractPct(msg)));
  },

  async "pipeline.keywordAugmentation"(params, ctx) {
    const generated = await runKeywordAugmentation((msg) => ctx.onProgress(msg, extractPct(msg)));
    return { generated };
  },

  async "pipeline.vectorize"(params, ctx) {
    const chunks = await runVectorize((msg) => ctx.onProgress(msg, extractPct(msg)));
    return { chunks };
  },

  async "pipeline.vectorizeIntents"(params, ctx) {
    const chunks = await runVectorizeIntents((msg) => ctx.onProgress(msg, extractPct(msg)));
    return { chunks };
  },

  /**
   * Повний цикл оновлення бази — та сама послідовність, що й пункт
   * «🛸 Повне оновлення» в CLI.
   * `models` (необов'язковий) повторює режим «Обидва»: додаткова векторизація
   * під кожну модель окремим процесом, бо EMBED_MODEL читається при старті.
   */
  async "pipeline.fullSync"(params = {}, ctx) {
    const progress = (msg) => ctx.onProgress(msg, extractPct(msg));

    const newApps = await runScanApps(progress);
    const web = await runFetchDocs(progress);
    const local = await runFetchLocalDocs(progress);
    const generated = await runKeywordAugmentation(progress);

    const models = Array.isArray(params.models) ? params.models : null;
    let chunks = 0;
    const perModel = {};

    if (models && models.length > 0) {
      const script = path.join(SRC_DIR, "cli", "run-vectorize.js");
      for (const model of models) {
        if (model === config.embedModelName) {
          perModel[model] = await runVectorize(progress);
          chunks += perModel[model];
        } else {
          ctx.onProgress(`Векторизація в окремому процесі для моделі ${model}...`, null);
          await runChildScript(script, model, progress);
          perModel[model] = "done";
        }
      }
    } else {
      chunks = await runVectorize(progress);
      perModel[config.embedModelName] = chunks;
    }

    const intents = await runVectorizeIntents(progress);

    return {
      newApps,
      docsCount: (web?.docsCount || 0) + (local?.docsCount || 0),
      mbDownloaded: web?.mbDownloaded || "0",
      generated,
      chunks,
      intents,
      perModel,
    };
  },

  /** Статистика бази (пункт «📊» у CLI). Читає SQLite на ~1.5 ГБ, буває повільно. */
  async "db.stats"() {
    return await db.getStats();
  },

  /** Очищення бази. `target` — один із CLEAR_TARGETS. */
  async "db.clear"(params = {}) {
    const target = params.target;
    const action = CLEAR_TARGETS[target];
    if (!action) {
      throw new Error(
        `Невідомий target «${target}». Дозволені: ${Object.keys(CLEAR_TARGETS).join(", ")}.`,
      );
    }
    await action();
    return { cleared: target };
  },

  /** RAG-бенчмарк. */
  async "tests.run"(params, ctx) {
    // Захист: runRagTests() робить process.exit(1), якщо Ollama недоступна,
    // а сервер падати не має права. Перевіряємо доступність заздалегідь.
    const status = await ollama.checkAvailability();
    if (!status.isAvailable) throw new Error("Ollama не запущена — тести не можуть стартувати.");
    // runRagTests() не приймає onProgress (сигнатура без аргументів), тож поетапного
    // прогресу немає. Віддаємо хоча б стартову подію, щоб панель не мовчала кілька хвилин.
    ctx.onProgress(
      "Запуск RAG-бенчмарку... (детальний прогрес недоступний, дивіться консоль sidecar)",
      null,
    );
    return (await runRagTests()) ?? { ok: true };
  },

  /** EXTERNAL-тести (intents, OOD, ambiguous). */
  async "tests.runExternal"(params, ctx) {
    const status = await ollama.checkAvailability();
    if (!status.isAvailable) throw new Error("Ollama не запущена — тести не можуть стартувати.");
    // Те саме: runExternalTests() теж без onProgress.
    ctx.onProgress(
      "Запуск EXTERNAL-тестів... (детальний прогрес недоступний, дивіться консоль sidecar)",
      null,
    );
    return (await runExternalTests()) ?? { ok: true };
  },

  /** Список файлів у sidecar/test-reports/. */
  async "reports.list"() {
    const dir = path.join(config.paths.sidecarDir, "test-reports");
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return { dir, reports: [] };
    }
    const reports = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const stat = await fs.stat(path.join(dir, name));
      reports.push({ name, size: stat.size, mtime: stat.mtime.toISOString() });
    }
    reports.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return { dir, reports };
  },

  /**
   * Вміст одного звіту з sidecar/test-reports/.
   * `name` — виключно ім'я файлу: усе, що містить роздільники шляху або «..»,
   * відкидаємо, інакше це вихід за межі теки звітів.
   */
  async "reports.read"(params = {}) {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) throw new Error("Не вказано параметр `name`.");
    if (
      /[\\/]/.test(name) ||
      name.includes("..") ||
      path.isAbsolute(name) ||
      name !== path.basename(name)
    ) {
      throw new Error(`Недопустиме ім'я звіту «${name}»: очікується лише ім'я файлу без шляху.`);
    }
    if (!name.endsWith(".json")) {
      throw new Error(`Недопустиме ім'я звіту «${name}»: очікується файл .json.`);
    }

    const dir = path.join(config.paths.sidecarDir, "test-reports");
    const file = path.join(dir, name);
    // Подвійний запобіжник: після склеювання шлях мусить лишитись усередині теки.
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
      throw new Error(`Недопустиме ім'я звіту «${name}».`);
    }

    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Звіту «${name}» немає в теці test-reports.`);
      throw new Error(`Не вдалося прочитати звіт «${name}»: ${error.message}`);
    }

    try {
      return { name, report: JSON.parse(raw) };
    } catch (error) {
      throw new Error(`Звіт «${name}» містить невалідний JSON: ${error.message}`);
    }
  },

  /**
   * Скасування довгої операції.
   * MVP: наявні функції пайплайна не приймають прапорця скасування (їхній
   * єдиний аргумент — onProgress), тому реально перервати цикл нічим.
   * Прапорець виставляємо (на майбутнє), але чесно повертаємо cancelled:false.
   * Записано в docs/improvements.md.
   */
  "job.cancel"(params = {}) {
    const targetId = params.id;
    const job = jobs.get(targetId);
    if (!job) {
      return { cancelled: false, reason: `Задачі з id=${targetId} немає серед активних.` };
    }
    job.cancelled = true;
    return {
      cancelled: false,
      reason:
        "Функції пайплайна не підтримують скасування (приймають лише onProgress). " +
        "Прапорець виставлено, але поточний цикл доїде до кінця.",
    };
  },
};
