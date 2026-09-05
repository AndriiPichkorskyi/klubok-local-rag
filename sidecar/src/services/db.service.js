/**
 * Файл: src/services/db.service.js
 * Опис: Сервіс для роботи з базами даних. Керує SQLite (для зберігання метаданих програм
 *       та викачаних веб-документів) та LanceDB (векторна база даних для семантичного пошуку).
 */

import fs from "fs/promises";
import { readFileSync, unlinkSync } from "fs";
import path from "path";
import { AsyncLocalStorage } from "async_hooks";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import * as lancedb from "@lancedb/lancedb";
import { config } from "../config/config.js";
import { formatBytes } from "../utils/format.js";

/**
 * Ім'я файла-замка. Лежить поруч із rag_metadata.sqlite, бо захищає саме її
 * (та LanceDB-теки): спільна chunks_fts — це те місце, де два паралельні
 * процеси векторизації затирали чанки одне одного.
 */
export const LOCK_FILE_NAME = "pipeline.lock";

/**
 * Кожні LOCK_HEARTBEAT_MS живий власник оновлює час модифікації файла-замка,
 * і замок без «сигналу життя» довше за LOCK_STALE_MS вважається протухлим.
 *
 * Навіщо це поверх перевірки PID: номер процесу переможе бути перевикористаний
 * після перезавантаження або обгортання лічильника PID, і тоді мертвий власник
 * виглядав би живим (спостерігалось у пісочниці). Перевірка PID лишається
 * головною і миттєвою (kill -9 → замок протухлий одразу), mtime — запобіжник.
 */
const LOCK_HEARTBEAT_MS = 5000;
const LOCK_STALE_MS = 30000;

/**
 * Контекст уже взятого замка. Потрібен, щоб відрізнити ЛЕГІТИМНУ вкладеність
 * (fullSync → runVectorize у тому самому ланцюжку викликів) від ДВОХ НЕЗАЛЕЖНИХ
 * операцій в одному процесі (два RPC-запити паралельно). Лічильник глибини тут
 * не годиться: він дозволив би другому запиту прослизнути.
 */
const lockContext = new AsyncLocalStorage();

/** Скільки минуло від часу ISO, у зрозумілому вигляді. */
function humanAge(startedAt) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "невідомо коли";
  const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (sec < 60) return `${sec} с тому`;
  if (sec < 3600) return `${Math.round(sec / 60)} хв тому`;
  return `${(sec / 3600).toFixed(1)} год тому`;
}

/**
 * Помилка «база зайнята». Текст пишемо так, щоб людина одразу зрозуміла, що
 * робити: хто тримає, з якого часу і як зняти замок.
 */
function lockedError(operation, lock) {
  const error = new Error(
    `Операцію «${operation}» не запущено: базу вже змінює процес ${lock.pid} ` +
      `(операція «${lock.operation}», запущений ${lock.startedAt}, ${humanAge(lock.startedAt)}). ` +
      `Зупиніть той процес або дочекайтесь завершення. Якщо ви впевнені, що він мертвий — ` +
      `викличте db.unlock (за потреби з {"force": true}) або видаліть файл ${lock.path}.`,
  );
  error.code = "PIPELINE_LOCKED";
  error.lock = lock;
  return error;
}

/**
 * Ім'я колонки-прапорця векторизації для моделі.
 * Беремо повну назву, а не лише тег після двокрапки: інакше дві різні
 * моделі з тегом `latest` ділили б один прапорець. Назви моделей у логіці немає:
 * вони приходять із конфіга або Ollama.
 */
export function vectorizedColumnFor(modelName) {
  const key = String(modelName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) throw new Error("Не вказано назву моделі ембедингу.");
  return `vectorized_${key}`;
}

/** Старе правило потрібне лише для одноразового перенесення наявних прапорців. */
function legacyVectorizedColumnFor(modelName) {
  const fullName = String(modelName || "");
  const tag = fullName.includes(":") ? fullName.split(":").pop() : fullName;
  const key = tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key ? `vectorized_${key}` : null;
}

/** Шлях до теки LanceDB конкретної моделі — те саме правило, що в config.js. */
export function lancedbPathFor(modelName) {
  return path.join(config.paths.dataDir, `lancedb_data_${String(modelName).replace(":", "_")}`);
}

class DbService {
  constructor() {
    this.sqliteDb = null;
    this.lanceDb = null;
    this.table = null;
    this.tableName = "app_chunks";
    /** Запис замка, який тримає САМЕ цей процес (для аварійного прибирання). */
    this.heldLock = null;
    /** Чи замок успадкований від батьківського процесу (його не знімаємо). */
    this.inheritedLock = false;
    this.exitHookInstalled = false;
    this.heartbeatTimer = null;
  }

  /** Шлях до файла-замка. Читаємо конфіг щоразу — його можна перезавантажити. */
  lockPath() {
    return path.join(path.dirname(config.db.sqlitePath), LOCK_FILE_NAME);
  }

  /**
   * Чи живий процес із таким PID. Сигнал 0 нічого не надсилає, лише перевіряє
   * існування; EPERM означає «живий, але чужий», і це теж «живий».
   */
  isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }

  /**
   * Читає файл-замок. Повертає null, якщо замка немає або він нечитабельний.
   * `alive` — чи живий власник (протухлий замок можна перехопити).
   */
  async readLock() {
    const file = this.lockPath();
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
    let heartbeatAgeMs = null;
    try {
      heartbeatAgeMs = Date.now() - (await fs.stat(file)).mtimeMs;
    } catch {
      heartbeatAgeMs = null;
    }

    let info;
    try {
      info = JSON.parse(raw);
    } catch {
      return {
        pid: null, operation: null, startedAt: null, alive: false,
        heartbeatAgeMs, path: file, broken: true,
      };
    }
    if (!Number.isInteger(info.pid)) {
      return { ...info, pid: null, alive: false, heartbeatAgeMs, path: file, broken: true };
    }

    const alive = this.isProcessAlive(info.pid);
    // Живий PID без свіжого сигналу життя — це майже напевно чужий процес,
    // якому дістався номер мертвого власника.
    const heartbeatLost = heartbeatAgeMs !== null && heartbeatAgeMs > LOCK_STALE_MS;
    return {
      ...info,
      alive,
      heartbeatAgeMs,
      heartbeatLost,
      stale: !alive || heartbeatLost,
      path: file,
      broken: false,
    };
  }

  /**
   * Стан замка для db.stats: без секретів, у формі, зручній для інтерфейсу.
   */
  async lockStatus() {
    const lock = await this.readLock();
    if (!lock) return { locked: false, path: this.lockPath() };
    return {
      locked: true,
      pid: lock.pid,
      operation: lock.operation ?? null,
      startedAt: lock.startedAt ?? null,
      ageMs: Number.isFinite(Date.parse(lock.startedAt)) ? Date.now() - Date.parse(lock.startedAt) : null,
      alive: lock.alive,
      heartbeatAgeMs: lock.heartbeatAgeMs ?? null,
      // Протухлий = мертвий PID АБО втрачений сигнал життя (перевикористаний PID).
      stale: Boolean(lock.broken || lock.stale),
      broken: Boolean(lock.broken),
      self: lock.pid === process.pid,
      path: lock.path,
    };
  }

  /**
   * Сигнал життя: доки операція триває, оновлюємо mtime файла-замка.
   * `unref()` — щоб таймер не тримав процес живим після завершення роботи.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const now = new Date();
      fs.utimes(this.lockPath(), now, now).catch(() => {
        // Замок могли зняти примусово — наступне звернення це побачить.
      });
    }, LOCK_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * Аварійне прибирання: якщо процес помирає штатно (навіть через process.exit),
   * замок не має лишатися. Для kill -9 працює перевірка протухлості за PID.
   */
  installExitHook() {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on("exit", () => {
      if (!this.heldLock || this.inheritedLock) return;
      try {
        const raw = readFileSync(this.lockPath(), "utf8");
        if (JSON.parse(raw).pid === process.pid) unlinkSync(this.lockPath());
      } catch {
        // Замка вже немає або він чужий — прибирати нічого.
      }
    });
  }

  /**
   * Бере файл-замок на операцію запису.
   * Кидає помилку з кодом PIPELINE_LOCKED, якщо база зайнята живим процесом:
   * тихе очікування ховало б проблему, а мовчазний паралельний запис саме її й
   * створює (дублі чанків, витіснена документація).
   *
   * @param {string} operation - назва операції для повідомлення.
   * @returns {Promise<{acquired: boolean, mode: string, pid: number}>}
   */
  async acquireLock(operation) {
    const file = this.lockPath();

    // Замок, узятий батьківським процесом (pipeline.fullSync → run-vectorize.js):
    // дочірній процес не бере власного, інакше система блокувала б сама себе.
    const inheritedPid = Number(process.env.PIPELINE_LOCK_OWNER_PID || 0);
    if (inheritedPid) {
      const current = await this.readLock();
      if (current && current.pid === inheritedPid && current.alive && !current.stale) {
        this.inheritedLock = true;
        this.heldLock = current;
        return { acquired: false, mode: "inherited", pid: current.pid };
      }
    }

    // Три спроби: між читанням протухлого замка і створенням свого може
    // втрутитись інший процес — тоді просто перечитуємо стан.
    for (let attempt = 0; attempt < 3; attempt++) {
      const payload = {
        pid: process.pid,
        operation,
        startedAt: new Date().toISOString(),
        argv: process.argv.slice(1, 3),
      };
      try {
        // "wx" — атомарне створення: якщо файл є, отримаємо EEXIST.
        await fs.writeFile(file, JSON.stringify(payload, null, 2), { flag: "wx" });
        this.heldLock = { ...payload, path: file };
        this.inheritedLock = false;
        this.startHeartbeat();
        this.installExitHook();
        return { acquired: true, mode: "acquired", pid: process.pid };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;

        const current = await this.readLock();
        if (!current) continue; // зник між EEXIST і читанням — пробуємо ще раз

        if (current.broken || current.stale) {
          // Протухлий (власника вбито або він давно не подавав ознак життя)
          // чи зіпсований замок перехоплюємо.
          const why = current.broken
            ? "файл зіпсовано"
            : current.alive
              ? `немає сигналу життя ${Math.round((current.heartbeatAgeMs ?? 0) / 1000)} с (PID перевикористано)`
              : "власник мертвий";
          console.warn(
            `[lock] Знайдено протухлий замок процесу ${current.pid ?? "?"} (${why}) — перехоплюємо.`,
          );
          try {
            await fs.rm(file, { force: true });
          } catch (removeError) {
            // Найчастіше це права на теку. Голий EPERM нічого не пояснює людині.
            const failure = new Error(
              `Не вдалося прибрати протухлий замок ${file} (власник ${current.pid ?? "?"} мертвий): ` +
                `${removeError.message}. Видаліть файл вручну або перевірте права на теку.`,
            );
            failure.code = "PIPELINE_LOCK_STALE";
            failure.lock = current;
            throw failure;
          }
          continue;
        }
        throw lockedError(operation, current);
      }
    }
    throw new Error(
      `Не вдалося взяти замок ${file} за 3 спроби: його одночасно перехоплює інший процес.`,
    );
  }

  /** Віддає замок. Чужий файл не чіпає: знімаємо лише свій запис. */
  async releaseLock() {
    this.stopHeartbeat();
    if (this.inheritedLock) {
      this.inheritedLock = false;
      this.heldLock = null;
      return false;
    }
    if (!this.heldLock) return false;
    this.heldLock = null;
    const file = this.lockPath();
    try {
      const raw = await fs.readFile(file, "utf8");
      if (JSON.parse(raw).pid !== process.pid) return false;
    } catch {
      return false;
    }
    try {
      await fs.rm(file, { force: true });
    } catch (error) {
      // Не вдалося зняти — операція вже завершилась успішно, тому це
      // попередження, а не помилка. Замок протухне сам: PID більше не живий.
      console.warn(`[lock] Не вдалося зняти замок ${file}: ${error.message}`);
      return false;
    }
    return true;
  }

  /**
   * Виконує операцію запису під замком.
   * Вкладений виклик у межах уже взятого замка (fullSync → runVectorize)
   * виконується без повторного захоплення; незалежна операція в тому самому
   * процесі замка НЕ отримає — вона побачить звичайну відмову.
   */
  async withWriteLock(operation, fn) {
    if (lockContext.getStore()) return await fn();

    const token = await this.acquireLock(operation);
    return await lockContext.run({ operation, token }, async () => {
      try {
        return await fn();
      } finally {
        await this.releaseLock();
      }
    });
  }

  /**
   * Примусове зняття замка (RPC db.unlock).
   * Живого власника без `force` не чіпаємо: зняти замок у працюючого процесу
   * означає повернути саме ту гонку, від якої замок і захищає.
   */
  async forceUnlock({ force = false } = {}) {
    const lock = await this.readLock();
    if (!lock) return { unlocked: false, wasLocked: false, path: this.lockPath(), lock: null };

    // Протухлий замок (мертвий PID або втрачений сигнал життя) знімаємо без питань.
    if (!lock.stale && !lock.broken && !force) {
      return {
        unlocked: false,
        wasLocked: true,
        refused: true,
        lock: await this.lockStatus(),
        reason:
          `Замок тримає ЖИВИЙ процес ${lock.pid} (операція «${lock.operation}», ` +
          `запущений ${lock.startedAt}, ${humanAge(lock.startedAt)}). Спочатку зупиніть його. ` +
          `Якщо це не потрібний вам процес — повторіть виклик з {"force": true}.`,
      };
    }

    const previous = await this.lockStatus();
    await fs.rm(this.lockPath(), { force: true });
    if (this.heldLock && this.heldLock.pid === lock.pid) {
      this.heldLock = null;
      this.inheritedLock = false;
    }
    return {
      unlocked: true,
      wasLocked: true,
      forced: Boolean(force && !lock.stale && !lock.broken),
      lock: previous,
    };
  }

  /**
   * Ініціалізує обидві бази даних (створює файли та таблиці, якщо їх немає).
   */
  async init() {
    try {
      // Створюємо теку для файлу БД, якщо її немає.
      // Раніше тут був відносний шлях "data", який залежав від cwd процесу.
      await fs.mkdir(path.dirname(config.db.sqlitePath), { recursive: true });

      // 1. Ініціалізація SQLite (для метаданих та стану індексації)
      this.sqliteDb = await open({
        filename: config.db.sqlitePath,
        driver: sqlite3.Database,
      });

      await this.sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS apps (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          version TEXT,
          hpd_project_identifier TEXT,
          helpBookFolder TEXT,
          lastIndexed DATETIME,
          toc_fetched BOOLEAN DEFAULT 0
        );
        
        CREATE TABLE IF NOT EXISTS document_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_id TEXT,
          title TEXT,
          uri TEXT UNIQUE,
          FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS web_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          link_id INTEGER UNIQUE,
          content TEXT,
          FOREIGN KEY (link_id) REFERENCES document_links (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS raw_html (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          link_id INTEGER UNIQUE,
          html TEXT,
          FOREIGN KEY (link_id) REFERENCES document_links (id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          appName UNINDEXED,
          docId UNINDEXED,
          docTitle,
          text,
          sourceType UNINDEXED
        );

        CREATE TABLE IF NOT EXISTS schema_migrations (
          key TEXT PRIMARY KEY,
          appliedAt DATETIME NOT NULL
        );
      `);

      // Міграції для старих баз. Єдина помилка, яку тут можна ігнорувати, —
      // «колонка вже існує»; решта мусить бути видимою.
      await this.addColumnIfMissing("apps", "toc_fetched BOOLEAN DEFAULT 0");
      await this.addColumnIfMissing("apps", "keywords TEXT");
      await this.addColumnIfMissing("apps", "helpBookFolder TEXT");
      await this.addColumnIfMissing("document_links", "sourceType TEXT DEFAULT 'WEB'");
      
      // Колонки всіх моделей створюються з конфіга, а старі прапорці
      // один раз переносяться без прив'язки до конкретних назв моделей.
      await this.migrateVectorizedColumns([
        config.embedModelName,
        ...(config.embedModels || []),
      ]);

      // 2. Ініціалізація LanceDB (для векторів)
      this._currentLanceDbPath = config.db.lancedbPath;
      this.lanceDb = await lancedb.connect(this._currentLanceDbPath);

      // Перевіряємо, чи існує таблиця
      const tableNames = await this.lanceDb.tableNames();

      if (tableNames.includes(this.tableName)) {
        this.table = await this.lanceDb.openTable(this.tableName);
      } else {
        // Створюємо порожню таблицю з правию схемою
        // Зверніть увагу: LanceDB автоматично визначає схему з першого запису,
        // але ми можемо ініціалізувати з порожнім масивом та схемою, якщо потрібно
        // Для простоти, ми створимо її під час першого додавання даних, якщо її немає.
      }
    } catch (error) {
      console.error("Помилка ініціалізації баз даних:", error);
      throw error;
    }
  }

  /**
   * Перевіряє, чи не змінилася модель векторів (шлях до LanceDB).
   * Якщо змінилася (через зміну config у тестах), перепідключає LanceDB.
   */
  async ensureLanceDbConnected() {
    const expectedPath = config.db.lancedbPath;
    if (this._currentLanceDbPath !== expectedPath) {
      this.lanceDb = await lancedb.connect(expectedPath);
      this.table = null;
      const tableNames = await this.lanceDb.tableNames();
      if (tableNames.includes(this.tableName)) {
        this.table = await this.lanceDb.openTable(this.tableName);
      }
      this._currentLanceDbPath = expectedPath;
      
      // Також створюємо колонку в SQLite для нової моделі, щоб уникнути помилок `no such column`
      const currentCol = vectorizedColumnFor(config.embedModelName);
      await this.addColumnIfMissing("apps", `${currentCol} BOOLEAN DEFAULT 0`);
    }
  }

  /**
   * Додає колонку, якщо її ще немає. Помилку «duplicate column name»
   * ігноруємо (база вже мігрована), будь-яку іншу прокидаємо далі.
   */
  async addColumnIfMissing(table, definition) {
    try {
      await this.sqliteDb.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message)) throw error;
    }
  }

  /**
   * Скидає прапорці всіх моделей, які реально є у схемі. Нову модель можна
   * додати конфігом без правок цього методу.
   */
  async resetVectorizedFlags(appIds = null, modelNames = null) {
    const schemaColumns = await this.vectorizedColumns();
    const requestedColumns = Array.isArray(modelNames)
      ? modelNames.map(vectorizedColumnFor)
      : schemaColumns;
    const columns = [...new Set(requestedColumns)].filter(
      (name) => /^vectorized_[a-z0-9_]+$/i.test(name) && schemaColumns.includes(name),
    );
    if (columns.length === 0) return;

    const assignments = columns.map((name) => `"${name}" = 0`).join(", ");
    if (appIds === null) {
      await this.sqliteDb.exec(`UPDATE apps SET ${assignments}`);
      return;
    }

    const ids = [...new Set(appIds.filter(Boolean))];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    await this.sqliteDb.run(
      `UPDATE apps SET ${assignments} WHERE id IN (${placeholders})`,
      ids,
    );
  }

  /**
   * Одноразово переносить стан із коротких легасі-колонок у колонки з повною
   * назвою моделі. Якщо кілька моделей мають однаковий тег, неоднозначний старий
   * прапорець не копіюється жодній із них.
   */
  async migrateVectorizedColumns(modelNames) {
    const models = [...new Set(modelNames.filter(Boolean))];
    const legacyOwners = new Map();
    for (const model of models) {
      const legacy = legacyVectorizedColumnFor(model);
      if (!legacy) continue;
      legacyOwners.set(legacy, (legacyOwners.get(legacy) || 0) + 1);
    }

    for (const model of models) {
      const column = vectorizedColumnFor(model);
      await this.addColumnIfMissing("apps", `${column} BOOLEAN DEFAULT 0`);

      const migrationKey = `vectorized-column-v2:${column}`;
      const applied = await this.sqliteDb.get(
        `SELECT 1 AS applied FROM schema_migrations WHERE key = ?`,
        [migrationKey],
      );
      if (applied) continue;

      const legacy = legacyVectorizedColumnFor(model);
      const columns = await this.vectorizedColumns();
      if (
        legacy &&
        legacy !== column &&
        legacyOwners.get(legacy) === 1 &&
        columns.includes(legacy)
      ) {
        await this.sqliteDb.exec(
          `UPDATE apps SET "${column}" = 1 WHERE "${legacy}" = 1`,
        );
      }

      await this.sqliteDb.run(
        `INSERT INTO schema_migrations (key, appliedAt) VALUES (?, ?)`,
        [migrationKey, new Date().toISOString()],
      );
    }
  }

  /**
   * Зберігає чанки з векторами в LanceDB та їх текст у FTS.
   *
   * @param {Object[]} chunks - чанки, за замовчуванням однієї програми.
   * @param {{replaceAppChunks?: boolean}} options - replaceAppChunks: false лише додає
   *        чанки, не видаляючи наявні. Потрібно для пакетів із чанками різних
   *        програм (векторизація намірів), інакше стиралася документація першої з них.
   */
  async saveChunks(chunks, { replaceAppChunks = true } = {}) {
    if (chunks.length === 0) return;

    await this.ensureLanceDbConnected();

    const appName = chunks[0]?.appName;

    // Зберігаємо в LanceDB (вектори)
    if (!this.table) {
      this.table = await this.lanceDb.createTable(this.tableName, chunks);
    } else {
      if (replaceAppChunks && appName) {
         try {
            await this.table.delete(`appName = '${appName.replace(/'/g, "''")}'`);
         } catch (e) {
            console.error('Помилка видалення старих векторів LanceDB:', e);
         }
      }
      await this.table.add(chunks);
    }

    // Зберігаємо в SQLite FTS (чистий текст)
    // Видаляємо попередні чанки для цієї програми, щоб уникнути дублювання
    // при послідовному запуску для 0.6b та 4b
    if (replaceAppChunks && appName) {
       await this.sqliteDb.run(`DELETE FROM chunks_fts WHERE appName = ?`, [appName]);
    }
    
    const insertStmt = await this.sqliteDb.prepare(
      `INSERT INTO chunks_fts (appName, docId, docTitle, text, sourceType) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const chunk of chunks) {
      await insertStmt.run([chunk.appName, chunk.docId, chunk.docTitle, chunk.text, chunk.sourceType || 'WEB']);
    }
    await insertStmt.finalize();
  }

  // Пошук найбільш схожих чанків за вектором запиту
  async searchSimilar(queryVector, limit = config.rag.topK, excludeLocal = false) {
    await this.ensureLanceDbConnected();
    if (!this.table) return [];

    let q = this.table.search(queryVector).limit(limit);
    if (excludeLocal) {
       q = q.where("sourceType != 'LOCAL'");
    }
    
    return await q.toArray();
  }

  // Пошук за допомогою Full-Text Search (SQLite FTS5)
  async searchSimilarFts(queryText, limit = config.rag.topK, excludeLocal = false) {
    // Очищаємо запит для FTS (прибираємо спецсимволи і додаємо * для fuzzy/prefix пошуку)
    const safeQuery = queryText.replace(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9\s]/g, "").trim();
    if (!safeQuery) return [];

    const terms = safeQuery
      .split(/\s+/)
      .map((t) => `"${t}"*`)
      .join(" OR ");

    let query = `
      SELECT appName, docId, docTitle, text
      FROM chunks_fts 
      WHERE chunks_fts MATCH ? 
    `;
    
    if (excludeLocal) {
      query += ` AND sourceType != 'LOCAL' `;
    }
    
    query += ` ORDER BY rank LIMIT ?`;

    const rows = await this.sqliteDb.all(query, [terms, limit]);
    return rows;
  }

  /**
   * Зберігає або оновлює метадані програми.
   */
  async saveAppMetadata(appId, name, appPath, version, hpd_id, helpBookFolder = null) {
    await this.sqliteDb.run(
      `INSERT INTO apps (id, name, path, version, hpd_project_identifier, helpBookFolder, lastIndexed) 
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET 
         name=excluded.name, 
         path=excluded.path, 
         version=excluded.version, 
         hpd_project_identifier=excluded.hpd_project_identifier, 
         helpBookFolder=excluded.helpBookFolder,
         lastIndexed=excluded.lastIndexed`,
      [appId, name, appPath, version, hpd_id, helpBookFolder, new Date().toISOString()],
    );
  }

  /**
   * Позначає, що зміст (TOC) для програми вже завантажено.
   */
  async markTocFetched(appId) {
    await this.sqliteDb.run(`UPDATE apps SET toc_fetched = 1 WHERE id = ?`, [appId]);
  }

  async saveAppKeywords(appId, keywords) {
    await this.sqliteDb.run(`UPDATE apps SET keywords = ? WHERE id = ?`, [keywords, appId]);
  }

  async saveDocumentLink(appId, title, uri) {
    await this.sqliteDb.run(
      `INSERT OR IGNORE INTO document_links (app_id, title, uri) VALUES (?, ?, ?)`,
      [appId, title, uri],
    );
  }

  /**
   * Отримує повний текст веб-документа за його ID (для Parent Document Retrieval)
   */
  async getRawHtmlByDocId(docId) {
    if (docId === 0 || docId === -1) return null;
    const row = await this.sqliteDb.get(
      'SELECT r.html FROM raw_html r JOIN web_documents w ON r.link_id = w.link_id WHERE w.id = ?',
      [docId]
    );
    return row ? row.html : null;
  }

  async getWebDocumentById(docId) {
    if (docId === 0) return null; // Це метадані, немає повного документа
    return await this.sqliteDb.get(`SELECT content FROM web_documents WHERE id = ?`, [docId]);
  }

  async saveWebDocument(linkId, content) {
    await this.sqliteDb.run(
      `INSERT OR REPLACE INTO web_documents (link_id, content) VALUES (?, ?)`,
      [linkId, content],
    );
  }

  async saveRawHtml(linkId, html) {
    await this.sqliteDb.run(`INSERT OR IGNORE INTO raw_html (link_id, html) VALUES (?, ?)`, [
      linkId,
      html,
    ]);
  }

  async getRawHtml(linkId) {
    const row = await this.sqliteDb.get(`SELECT html FROM raw_html WHERE link_id = ?`, [linkId]);
    return row ? row.html : null;
  }

  // Очищення специфічних таблиць. Це теж запис, тому — під замком: пункти
  // очищення є і в CLI, а не лише в RPC-методі db.clear.
  async clearTable(tableName) {
    return await this.withWriteLock(`clearTable(${tableName})`, () =>
      this.clearTableUnlocked(tableName),
    );
  }

  async clearTableUnlocked(tableName) {
    if (tableName === "lancedb") {
      await this.ensureLanceDbConnected();
      const tableNames = await this.lanceDb.tableNames();
      if (tableNames.includes(this.tableName)) {
        await this.lanceDb.dropTable(this.tableName);
        this.table = null;
      }
      // Коли видаляємо вектори, також треба видалити текстовий пошуковий індекс (бо він містить ті ж самі чанки)
      await this.sqliteDb.exec(`DELETE FROM chunks_fts`);
      // Видалено LanceDB лише поточної моделі — її прапорець і скидаємо.
      await this.resetVectorizedFlags(null, [config.embedModelName]);
    } else {
      await this.sqliteDb.exec(`DELETE FROM ${tableName}`);
    }
  }

  // Очищення баз даних
  async clearAll() {
    return await this.withWriteLock("clearAll", () => this.clearAllUnlocked());
  }

  async clearAllUnlocked() {
    await this.clearTable("apps");
    await this.clearTable("document_links");
    await this.clearTable("web_documents");
    await this.clearTable("lancedb");
  }

  // Очистити лише наміри та ключові слова
  
  async clearDocumentsByType(type) {
    return await this.withWriteLock(`clearDocumentsByType(${type})`, () =>
      this.clearDocumentsByTypeUnlocked(type),
    );
  }

  async clearDocumentsByTypeUnlocked(type) {
    if (type !== 'WEB' && type !== 'LOCAL') return;
    
    // 1. Знаходимо всі програми, які будуть зачеплені
    const appsToUpdate = await this.sqliteDb.all(`
      SELECT DISTINCT app_id FROM document_links WHERE sourceType = ?
    `, [type]);
    
    // 2. Скидаємо їм прапорці векторизації всіх моделей
    await this.resetVectorizedFlags(appsToUpdate.map((app) => app.app_id));
    
    // 3. Видаляємо з FTS та LanceDB
    await this.sqliteDb.run("DELETE FROM chunks_fts WHERE sourceType = ?", [type]);
    await this.ensureLanceDbConnected();
    if (this.table) {
      try {
        await this.table.delete(`sourceType = '${type}'`);
      } catch (e) {
        console.error("LanceDB delete error:", e.message);
      }
    }
    
    // 4. Видаляємо зв'язані web_documents та document_links
    await this.sqliteDb.run(`
      DELETE FROM web_documents WHERE link_id IN (
        SELECT id FROM document_links WHERE sourceType = ?
      )
    `, [type]);
    await this.sqliteDb.run("DELETE FROM document_links WHERE sourceType = ?", [type]);
  }

  /**
   * Прибирає чанки намірів (docId = -1) з FTS та з LanceDB-таблиці ПОТОЧНОЇ
   * моделі. `apps.keywords` навмисно не чіпає: ключові слова спільні для всіх
   * моделей і потрібні, щоб одразу записати наміри заново.
   * chunks_fts спільна для обох моделей, тому чистити її треба на кожному
   * прогоні — інакше другий прогін додав би другий комплект рядків.
   */
  async clearIntentChunks() {
    await this.ensureLanceDbConnected();
    if (this.table) {
      try {
        await this.table.delete("docId = -1");
      } catch (e) {
        console.error("Не вдалося видалити вектори намірів з LanceDB:", e.message);
      }
    }
    await this.sqliteDb.exec(`DELETE FROM chunks_fts WHERE docId = -1`);
  }

  async clearIntents() {
    return await this.withWriteLock("clearIntents", () => this.clearIntentsUnlocked());
  }

  async clearIntentsUnlocked() {
    await this.clearIntentChunks();
    await this.sqliteDb.exec(`UPDATE apps SET keywords = NULL`);
  }

  /**
   * Розмір теки в байтах (рекурсивно) і кількість файлів у ній.
   * Теки може не бути — це не помилка, а відповідь «для цієї моделі
   * векторної бази ще немає»; тоді повертаємо null.
   */
  async dirSize(dir) {
    let bytes = 0;
    let files = 0;
    try {
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
        try {
          const stat = await fs.stat(full);
          bytes += stat.size;
          files += 1;
        } catch {
          // Файл зник між readdir і stat — для статистики це неістотно.
        }
      }
    } catch {
      return null;
    }
    return { bytes, files };
  }

  /** Колонки прапорців векторизації з РЕАЛЬНОЇ схеми таблиці apps. */
  async vectorizedColumns() {
    const columns = await this.sqliteDb.all(`PRAGMA table_info(apps)`);
    return columns.map((c) => c.name).filter((name) => /^vectorized_/.test(name));
  }

  /**
   * Кандидати в ембединг-моделі — з конфіга: поточна модель плюс усе, що
   * перелічено в config.bootstrap. Модель вважається ембединговою тоді, коли
   * у схемі apps є її колонка-прапорець (або це поточна модель векторизації).
   */
  modelsFromConfig() {
    const listed = [
      config.embedModelName,
      ...(config.embedModels || []),
      ...(config.rag?.benchmark?.axes?.embedModel || []),
    ];
    return [...new Set(listed.filter((name) => typeof name === "string" && name.trim()))];
  }

  /** Відновлює назву Ollama-моделі з імені теки, де `:` було замінено на `_`. */
  modelFromLancedbDir(dirName) {
    const encoded = dirName.slice("lancedb_data_".length);
    const separator = encoded.lastIndexOf("_");
    if (separator < 1 || separator === encoded.length - 1) return encoded;
    return `${encoded.slice(0, separator)}:${encoded.slice(separator + 1)}`;
  }

  /**
   * Моделі з конфіга плюс реальні теки LanceDB. Це дозволяє побачити базу,
   * створену старим конфігом або окремим експериментом.
   */
  async modelCandidates() {
    const candidates = new Map(
      this.modelsFromConfig().map((model) => [
        model,
        { model, dir: lancedbPathFor(model), discoveredOnDisk: false },
      ]),
    );

    let entries = [];
    try {
      entries = await fs.readdir(config.paths.dataDir, { withFileTypes: true });
    } catch {
      return [...candidates.values()];
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("lancedb_data_")) continue;
      const exact = [...candidates.values()].find(
        (candidate) => path.basename(candidate.dir) === entry.name,
      );
      const model = exact?.model || this.modelFromLancedbDir(entry.name);
      candidates.set(model, {
        model,
        dir: path.join(config.paths.dataDir, entry.name),
        discoveredOnDisk: true,
      });
    }

    return [...candidates.values()];
  }

  /** Фактичний вміст однієї LanceDB без завантаження векторів у пам'ять. */
  async lanceDbSummary(dir) {
    const size = await this.dirSize(dir);
    if (!size) {
      return {
        path: dir,
        exists: false,
        tableExists: false,
        sizeBytes: 0,
        sizeMb: formatBytes(0),
        files: 0,
        chunks: 0,
        apps: null,
        sourceTypes: {},
      };
    }

    const result = {
      path: dir,
      exists: true,
      tableExists: false,
      sizeBytes: size.bytes,
      sizeMb: formatBytes(size.bytes),
      files: size.files,
      chunks: 0,
      apps: null,
      sourceTypes: {},
    };

    try {
      const lance = await lancedb.connect(dir);
      const tableNames = await lance.tableNames();
      if (!tableNames.includes(this.tableName)) return result;

      const table = await lance.openTable(this.tableName);
      result.tableExists = true;
      result.chunks = await table.countRows();

      // `select` не читає важкий vector; для 15k чанків лишаються два короткі поля.
      let rows;
      try {
        rows = await table.query().select(["appName", "sourceType"]).toArray();
      } catch {
        rows = await table.query().select(["appName"]).toArray();
      }
      const appNames = new Set();
      for (const row of rows) {
        if (typeof row.appName === "string" && row.appName.trim()) appNames.add(row.appName);
        const sourceType = row.sourceType || "WEB";
        result.sourceTypes[sourceType] = (result.sourceTypes[sourceType] || 0) + 1;
      }
      result.apps = appNames.size;
    } catch (error) {
      result.error = error.message;
    }

    return result;
  }

  /**
   * Готовність кожної моделі окремо: фактичні програми й чанки у LanceDB,
   * наявність таблиці та розмір теки. SQLite-прапорець лишається діагностикою.
   */
  async getModelReadiness(appsCount) {
    const schemaColumns = await this.vectorizedColumns();
    const models = [];

    for (const candidate of await this.modelCandidates()) {
      const { model, dir, discoveredOnDisk } = candidate;
      const column = vectorizedColumnFor(model);
      const isCurrent = model === config.embedModelName;
      // Чат-модель без колонки й без LanceDB до статистики не входить.
      if (!schemaColumns.includes(column) && !isCurrent && !discoveredOnDisk) continue;

      let sqliteVectorizedApps = null;
      if (schemaColumns.includes(column)) {
        const row = await this.sqliteDb.get(
          `SELECT COUNT(*) as count FROM apps WHERE ${column} = 1`,
        );
        sqliteVectorizedApps = row.count;
      }

      const lanceSummary = await this.lanceDbSummary(dir);
      // Фактичні унікальні appName у LanceDB точніші за старі SQLite-прапорці.
      const vectorizedApps = lanceSummary.apps ?? sqliteVectorizedApps;
      const ready =
        lanceSummary.tableExists &&
        vectorizedApps !== null &&
        appsCount > 0 &&
        vectorizedApps === appsCount;

      models.push({
        model,
        column,
        columnExists: schemaColumns.includes(column),
        isCurrent,
        discoveredOnDisk,
        vectorizedApps,
        sqliteVectorizedApps,
        vectorizedSource: lanceSummary.apps === null ? "sqlite" : "lancedb",
        notVectorizedApps: vectorizedApps === null ? null : appsCount - vectorizedApps,
        chunks: lanceSummary.chunks,
        ready,
        lancedb: lanceSummary,
      });
    }

    return models;
  }

  /**
   * Статистика бази. Крім старих полів (appsCount, chunksCount) віддає все,
   * чого бракувало інтерфейсу, щоб показати готовність: розклад по моделях,
   * чанки в розрізі sourceType і програми без ключових слів.
   */
  async getStats() {
    const appsRow = await this.sqliteDb.get("SELECT COUNT(*) as count FROM apps");
    const appsCount = appsRow.count;

    // Чанки в розрізі типу джерела: WEB / LOCAL / META / INTENT.
    const ftsRows = await this.sqliteDb.all(
      "SELECT sourceType, COUNT(*) as count FROM chunks_fts GROUP BY sourceType",
    );
    const chunksBySourceType = {};
    let chunksFtsTotal = 0;
    for (const row of ftsRows) {
      chunksBySourceType[row.sourceType || "WEB"] = row.count;
      chunksFtsTotal += row.count;
    }

    const linkRows = await this.sqliteDb.all(
      "SELECT sourceType, COUNT(*) as count FROM document_links GROUP BY sourceType",
    );
    const documentLinksBySourceType = {};
    for (const row of linkRows) {
      documentLinksBySourceType[row.sourceType || "WEB"] = row.count;
    }

    const webDocsRow = await this.sqliteDb.get("SELECT COUNT(*) as count FROM web_documents");
    const noKeywordsRow = await this.sqliteDb.get(
      "SELECT COUNT(*) as count FROM apps WHERE keywords IS NULL OR TRIM(keywords) = ''",
    );

    // Чанки LanceDB поточної моделі — поле лишається таким, як було.
    await this.ensureLanceDbConnected();
    let chunksCount = 0;
    if (this.table) {
      chunksCount = await this.table.countRows();
    }

    let sqliteSizeBytes = 0;
    try {
      sqliteSizeBytes = (await fs.stat(config.db.sqlitePath)).size;
    } catch {
      sqliteSizeBytes = 0;
    }

    return {
      appsCount,
      chunksCount,
      currentModel: config.embedModelName,
      // Стан файла-замка: панель має показувати «зараз працює процес N».
      lock: await this.lockStatus(),
      models: await this.getModelReadiness(appsCount),
      chunksBySourceType,
      chunksFtsTotal,
      documentLinksBySourceType,
      webDocumentsCount: webDocsRow.count,
      appsWithoutKeywords: noKeywordsRow.count,
      sqlite: {
        path: config.db.sqlitePath,
        sizeBytes: sqliteSizeBytes,
        sizeMb: formatBytes(sqliteSizeBytes),
      },
      collectedAt: new Date().toISOString(),
    };
  }
}

export const db = new DbService();
