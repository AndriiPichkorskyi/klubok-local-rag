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

import { config, reloadConfig, updateModels } from "../config/config.js";
import { db } from "../services/db.service.js";
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
import * as walkthrough from "../modules/walkthrough/index.js";
import { runRagTests } from "../tests/test-rag.js";
import { runExternalTests } from "../tests/test-external.js";
import { planBenchmark } from "../tests/benchmark-plan.js";
import { ollama } from "../services/ollama.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Корінь sidecar/src — звідти дістаємо допоміжні скрипти */
const SRC_DIR = path.resolve(__dirname, "..");

/**
 * Реєстр активних довгих задач:
 * id → { id, method, startedAt, cancelled, controller: AbortController }.
 * Заповнює сервер (server.js) на час виконання методу; `controller` смикає
 * метод job.cancel, а його `signal` доходить до циклів пайплайна.
 */
export const jobs = new Map();

/**
 * Чи скасовано поточну задачу. Пайплайн не кидає помилку через сигнал —
 * він виходить з циклу, тому стан «скасовано» читаємо саме з сигналу.
 */
function wasCancelled(ctx) {
  return Boolean(ctx && ctx.signal && ctx.signal.aborted);
}

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

/**
 * Скільки чекаємо, поки дочірній процес завершиться сам після SIGTERM,
 * перш ніж добити його SIGKILL. Спінер @clack у дочірньому процесі ставить
 * власний обробник SIGTERM, тому без цього запобіжника векторизація
 * продовжувала б жити фоном уже після скасування.
 */
const CHILD_KILL_GRACE_MS = 2000;

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
 *
 * `signal` передаємо штатною опцією child_process: Node сам вбиває дочірній
 * процес, коли контролер спрацював. Власного механізму вбивання не пишемо.
 *
 * @returns {Promise<{cancelled: boolean, code: number|null, pid: number|undefined}>}
 */
function runChildScript(scriptPath, envModel, onProgress, signal = null) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (envModel) env.EMBED_MODEL = envModel;
    // Дочірній процес працює під замком батька: pipeline.fullSync уже його взяв,
    // і без цієї змінної дитина блокувалась би об власного батька.
    env.PIPELINE_LOCK_OWNER_PID = String(process.pid);
    const child = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: signal || undefined,
    });
    const pid = child.pid;

    child.stdout.on("data", (buf) => {
      const line = buf.toString().trim();
      if (line) onProgress(`[${envModel || "default"}] ${line}`);
    });
    child.stderr.on("data", (buf) => {
      const line = buf.toString().trim();
      if (line) onProgress(`[${envModel || "default"}] ${line}`);
    });
    const name = path.basename(scriptPath);

    // Запобіжник: якщо процес не зник за grace-період після SIGTERM — SIGKILL.
    let killTimer = null;
    const escalate = () => {
      onProgress(`Скасування: дочірньому процесу ${name} (pid ${pid}) надіслано SIGTERM.`);
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          onProgress(`Дочірній процес ${name} (pid ${pid}) не зупинився — надсилаємо SIGKILL.`);
          try {
            child.kill("SIGKILL");
          } catch {
            // Процес уже завершився між перевіркою і сигналом — це нормально.
          }
        }
      }, CHILD_KILL_GRACE_MS);
    };
    if (signal) {
      if (signal.aborted) escalate();
      else signal.addEventListener("abort", escalate, { once: true });
    }

    // Abort породжує AbortError на рівні spawn — це не збій скрипта. Фінальну
    // відповідь віддаємо лише з `close`, тобто коли процес справді помер.
    child.on("error", (error) => {
      if (signal && signal.aborted) return;
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, termSignal) => {
      clearTimeout(killTimer);
      if (signal && signal.aborted) {
        onProgress(
          `Дочірній процес ${name} (pid ${pid}) зупинено (код ${code}, сигнал ${termSignal}).`,
        );
        resolve({ cancelled: true, code, pid });
        return;
      }
      if (code === 0) resolve({ cancelled: false, code, pid });
      else reject(new Error(`Скрипт ${name} завершився з кодом ${code}`));
    });
  });
}

/**
 * Тіло повного циклу оновлення. Винесено з реєстру методів, щоб RPC-метод міг
 * узяти файл-замок ОДИН раз на весь прогін: кроки всередині (runScanApps,
 * runVectorize, ...) беруть той самий замок повторно і бачать, що він уже їхній.
 */
async function fullSyncLocked(params, ctx) {
  const progress = (msg) => ctx.onProgress(msg, extractPct(msg));
  const signal = ctx.signal;

  // Проміжний результат наповнюємо по кроках: якщо задачу скасують,
  // клієнт отримає її саме в такому вигляді — зі станом і зробленим.
  const out = {
    newApps: 0,
    docsCount: 0,
    mbDownloaded: "0",
    generated: 0,
    chunks: 0,
    intents: 0,
    perModel: {},
    cancelled: false,
    stoppedAt: null,
  };

  /** Позначає крок, на якому спинилися, якщо сигнал уже спрацював. */
  const stopped = (step) => {
    if (!wasCancelled(ctx)) return false;
    out.cancelled = true;
    out.stoppedAt = step;
    return true;
  };

  out.newApps = await runScanApps(progress, signal);
  if (stopped("scanApps")) return out;

  const web = await runFetchDocs(progress, signal);
  out.docsCount += web?.docsCount || 0;
  out.mbDownloaded = web?.mbDownloaded || "0";
  if (stopped("fetchDocs")) return out;

  const local = await runFetchLocalDocs(progress, signal);
  out.docsCount += local?.docsCount || 0;
  if (stopped("fetchLocalDocs")) return out;

  out.generated = await runKeywordAugmentation(progress, signal);
  if (stopped("keywordAugmentation")) return out;

  const models = Array.isArray(params.models) ? params.models : null;

  if (models && models.length > 0) {
    const script = path.join(SRC_DIR, "cli", "run-vectorize.js");
    for (const model of models) {
      if (model === config.embedModelName) {
        out.perModel[model] = await runVectorize(progress, signal);
        out.chunks += out.perModel[model];
      } else {
        ctx.onProgress(`Векторизація в окремому процесі для моделі ${model}...`, null);
        // Сигнал іде і в дочірній процес: скасування вбиває і його.
        const child = await runChildScript(script, model, progress, signal);
        out.perModel[model] = child.cancelled ? "cancelled" : "done";
      }
      if (stopped(`vectorize:${model}`)) return out;
    }
  } else {
    out.chunks = await runVectorize(progress, signal);
    out.perModel[config.embedModelName] = out.chunks;
    if (stopped("vectorize")) return out;
  }

  out.intents = await runVectorizeIntents(progress, signal);
  stopped("vectorizeIntents");

  return out;
}

export const methods = {
  /** Перевірка живості. Мусить відповідати миттєво навіть під час векторизації. */
  ping() {
    return { ok: true, pid: process.pid, version: process.env.npm_package_version || "1.0.0" };
  },

  /** Модуль 2.1: делегує у sidecar/src/bootstrap. */
  async "bootstrap.check"(params, ctx) {
    // Прогрес потрібен лише коли ввімкнено config.bootstrap.autoPull:
    // тоді перевірка сама тягне відсутні моделі й це триває довго.
    return await bootstrapCheck((msg, pct) => ctx.onProgress(msg, pct ?? null));
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

  async "ollama.getModels"() {
    const status = await ollama.checkAvailability();
    return status.installedModels || [];
  },

  async "config.updateModels"(params) {
    const { embedModel, chatModel, visionModel } = params;
    if (embedModel) {
      // Ensure the vector column exists BEFORE saving config and using the model
      const colName = `vectorized_${embedModel.replace(/:/g, "_").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      await db.addColumnIfMissing("apps", `${colName} BOOLEAN DEFAULT 0`);
    }
    const newConfig = updateModels({ embedModel, chatModel, visionModel });
    return newConfig;
  },

  /**
   * RAG-пошук: обгортка над processQuery().
   * `searchMode` і `excludeLocal` не обов'язкові: null означає «взяти з конфіга».
   * Невідомий searchMode движок відхиляє помилкою — мовчазний фолбек ховав би
   * друкарську помилку в панелі розробника.
   */
  async query(params = {}, ctx) {
    const text = params.text;
    if (!text || !String(text).trim()) throw new Error("Не вказано параметр `text`.");
    return await processQuery(
      String(text),
      (msg) => ctx.onProgress(msg, extractPct(msg)),
      params.searchMode ?? null,
      params.excludeLocal ?? null,
    );
  },

  // Кожен метод пайплайна прокидає ctx.signal у функцію і повертає поле
  // `cancelled`: скасована операція — це нормальний результат із тим, що
  // встигло зробитися, а не кадр `error`.
  async "pipeline.scanApps"(params, ctx) {
    const newApps = await runScanApps((msg) => ctx.onProgress(msg, extractPct(msg)), ctx.signal);
    return { newApps, cancelled: wasCancelled(ctx) };
  },

  async "pipeline.fetchDocs"(params, ctx) {
    const res = await runFetchDocs((msg) => ctx.onProgress(msg, extractPct(msg)), ctx.signal);
    return { ...res, cancelled: wasCancelled(ctx) };
  },

  async "pipeline.fetchLocalDocs"(params, ctx) {
    const res = await runFetchLocalDocs((msg) => ctx.onProgress(msg, extractPct(msg)), ctx.signal);
    return { ...res, cancelled: wasCancelled(ctx) };
  },

  async "pipeline.keywordAugmentation"(params, ctx) {
    const generated = await runKeywordAugmentation(
      (msg) => ctx.onProgress(msg, extractPct(msg)),
      ctx.signal,
    );
    return { generated, cancelled: wasCancelled(ctx) };
  },

  async "pipeline.vectorize"(params, ctx) {
    const chunks = await runVectorize((msg) => ctx.onProgress(msg, extractPct(msg)), ctx.signal);
    return { chunks, cancelled: wasCancelled(ctx) };
  },

  async "pipeline.vectorizeIntents"(params, ctx) {
    const chunks = await runVectorizeIntents(
      (msg) => ctx.onProgress(msg, extractPct(msg)),
      ctx.signal,
    );
    return { chunks, cancelled: wasCancelled(ctx) };
  },

  /**
   * Повний цикл оновлення бази — та сама послідовність, що й пункт
   * «🛸 Повне оновлення» в CLI.
   * Замок беремо ОДИН раз на весь прогін: інакше дочірній процес векторизації
   * («чужа» модель) зіткнувся б із замком власного батька.
   */
  async "pipeline.fullSync"(params = {}, ctx) {
    return await db.withWriteLock("pipeline.fullSync", () => fullSyncLocked(params, ctx));
  },

  /** Статистика бази (пункт «📊» у CLI). Читає SQLite на ~1.5 ГБ, буває повільно. */
  async "db.stats"() {
    return await db.getStats();
  },

  /** Очищення бази. `target` — один із CLEAR_TARGETS. Це запис, тому під замком. */
  async "db.clear"(params = {}) {
    const target = params.target;
    const action = CLEAR_TARGETS[target];
    if (!action) {
      throw new Error(
        `Невідомий target «${target}». Дозволені: ${Object.keys(CLEAR_TARGETS).join(", ")}.`,
      );
    }
    await db.withWriteLock(`db.clear(${target})`, () => action());
    return { cleared: target };
  },

  /**
   * Примусове зняття файла-замка. Кнопка для людини: краще так, ніж шукати
   * і видаляти файл руками. Замок живого процесу без `force` не знімаємо —
   * це повернуло б саме ту гонку, від якої замок захищає.
   */
  async "db.unlock"(params = {}) {
    return await db.forceUnlock({ force: params.force === true });
  },

  /**
   * RAG-бенчмарк. Недоступна Ollama — це помилка методу (кадр `error`),
   * а не смерть процесу: runRagTests() більше не робить process.exit.
   *
   * `params.axes` — осі, задані в панелі розробника. Конфіг лишається джерелом
   * за замовчуванням: незадана вісь береться з `rag.benchmark.axes`.
   */
  async "tests.run"(params = {}, ctx) {
    ctx.onProgress("Запуск RAG-бенчмарку...", 0);
    return await runRagTests((msg, pct) => ctx.onProgress(msg, pct ?? null), {
      axes: params.axes ?? null,
      signal: ctx.signal,
    });
  },

  /** EXTERNAL-тести (intents, OOD, ambiguous). Матриця та сама, що й у tests.run. */
  async "tests.runExternal"(params = {}, ctx) {
    ctx.onProgress("Запуск EXTERNAL-тестів...", 0);
    return await runExternalTests((msg, pct) => ctx.onProgress(msg, pct ?? null), {
      axes: params.axes ?? null,
      signal: ctx.signal,
    });
  },

  /**
   * Ціна прогону ДО запуску: скільки режимів, скільки запитів до LLM і
   * скільки це приблизно триватиме. Панель смикає метод на кожну зміну осей,
   * тому він лише читає (кейси й оцінка темпу кешуються в процесі) і нічого
   * не запускає. Помилкові осі повертаються кадром `error` — тим самим
   * повідомленням, яке видав би сам прогін.
   */
  async "tests.plan"(params = {}) {
    return await planBenchmark({ kind: params.kind || "rag", axes: params.axes ?? null });
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
   * Модуль 2.5 (walkthrough). Чотири методи описано в
   * docs/contracts/walkthrough.md; уся логіка — в modules/walkthrough.
   * Тут, як і всюди в цьому файлі, лише прокидання params і ctx.
   */
  async "walkthrough.start"(params = {}, ctx) {
    return await walkthrough.start(params, {
      signal: ctx.signal,
      onProgress: (msg, pct = null) => ctx.onProgress(msg, pct),
    });
  },

  /**
   * Наступний крок за знімком екрана. Виклик зору довгий, тому ctx.signal
   * доходить до axios: job.cancel обриває саме його.
   *
   * Необов'язкові `frontmost` ({name, bundleId} від `frontmost_app()`),
   * `appRunning` і `debug` прокидаються модулю як є: рішення про них — його,
   * а не цього файла.
   */
  async "walkthrough.step"(params = {}, ctx) {
    return await walkthrough.step(params, {
      signal: ctx.signal,
      onProgress: (msg, pct = null) => ctx.onProgress(msg, pct),
    });
  },

  /** Повторний аналіз того самого екрана іншим промптом. */
  async "walkthrough.stuck"(params = {}, ctx) {
    return await walkthrough.stuck(params, {
      signal: ctx.signal,
      onProgress: (msg, pct = null) => ctx.onProgress(msg, pct),
    });
  },

  /**
   * Історія сесії: всі кроки з інструкціями, станами і сирими відповідями
   * моделі. Читання з пам'яті, тому синхронне і без прогресу.
   */
  "walkthrough.history"(params = {}) {
    return walkthrough.history(params);
  },

  /** Закриття сесії: звільняє пам'ять і видаляє знімки екрана. */
  async "walkthrough.finish"(params = {}) {
    return await walkthrough.finish(params);
  },

  /**
   * Скасування довгої операції: смикає AbortController задачі з реєстру.
   * Сам сигнал доходить у цикли пайплайна і в дочірній процес векторизації;
   * задача завершується власною фінальною відповіддю з `cancelled: true`.
   */
  "job.cancel"(params = {}) {
    const targetId = params.id;
    const job = jobs.get(targetId);
    if (!job) {
      return {
        cancelled: false,
        id: targetId ?? null,
        reason: `Задачі з id=${targetId} немає серед активних.`,
      };
    }

    const runningMs = Date.now() - job.startedAt;
    if (job.cancelled) {
      return {
        cancelled: true,
        alreadyCancelled: true,
        id: job.id,
        method: job.method,
        runningMs,
        reason: "Задачу вже скасовано раніше, чекаємо на її фінальну відповідь.",
      };
    }

    job.cancelled = true;
    job.controller.abort(new Error(`Задачу id=${job.id} скасовано через job.cancel.`));
    return {
      cancelled: true,
      alreadyCancelled: false,
      id: job.id,
      method: job.method,
      startedAt: job.startedAt,
      runningMs,
    };
  },
};
