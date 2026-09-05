/**
 * Файл: src/services/logger.service.js
 * Опис: Сервіс журналювання sidecar. Тримає дві незалежні речі:
 *
 *   1. Історію запитів користувача з фідбеком — `logs/queries.log` (як і раніше).
 *   2. ДІАГНОСТИЧНИЙ ЖУРНАЛ процесу — `logs/sidecar.N.log` з ротацією
 *      (символьне посилання `logs/current.log` завжди вказує на активний файл).
 *
 * Навіщо другий журнал. 26.08 sidecar зник посеред RAG-бенчмарку, і причини
 * встановити не вдалося: RPC-сервер писав діагностику лише в stdout, який
 * зник разом зі скролом термінала. Тепер усе, що потрібно для розтину —
 * старт процесу, кожен RPC-виклик, розриви з'єднань, зрізи пам'яті і причина
 * завершення — лягає у файл.
 *
 * ЧОМУ САМЕ pino + pino-roll з `sync: true`.
 * Процес, убитий OOM-killer'ом (SIGKILL) або аварією нативного модуля, не
 * отримує жодного шансу дописати буфер. Тому запис має бути синхронним:
 * `sync: true` змушує sonic-boom викликати `fs.writeSync` на кожному рядку,
 * і після SIGKILL у файлі лишається все, що встигло статися (перевірено).
 * Ротацію дає pino-roll: розмір файла і кількість копій обмежені, тож прогін
 * на тисячі викликів не породжує журнал на гігабайт.
 *
 * Налаштування (змінні оточення, дефолти в дужках):
 *   SIDECAR_LOG_DIR       — тека журналів (<тека даних>/logs)
 *   SIDECAR_LOG_LEVEL     — рівень pino (info)
 *   SIDECAR_LOG_MAX_SIZE  — максимальний розмір одного файла (5m)
 *   SIDECAR_LOG_KEEP      — скільки старих файлів тримати, крім активного (5)
 *   SIDECAR_LOG_MEMORY_MS — період зрізу пам'яті (5000)
 *   SIDECAR_LOG_HEAP_WARN — частка heap_size_limit для попередження (0.8)
 *   SIDECAR_LOG_HEAP_CRIT — частка heap_size_limit для критичного стану (0.92)
 */

import fs from "fs/promises";
import path from "path";
import v8 from "v8";
import pino from "pino";
import roll from "pino-roll";

import { config } from "../config/config.js";

/** Період зрізу пам'яті. */
const MEMORY_SAMPLE_MS = Number(process.env.SIDECAR_LOG_MEMORY_MS || 5000);
/** Частки heap_size_limit, на яких піднімається тривога. */
const HEAP_WARN_RATIO = Number(process.env.SIDECAR_LOG_HEAP_WARN || 0.8);
const HEAP_CRITICAL_RATIO = Number(process.env.SIDECAR_LOG_HEAP_CRIT || 0.92);
/**
 * Коли роботи немає, пульс пишемо не щоп'ять секунд, а раз на стільки зрізів.
 * Так журнал простою не з'їдає ротацію, але «процес був живий о 10:07:30»
 * у файлі лишається завжди.
 */
const IDLE_HEARTBEAT_EVERY = 12;
/** Наскільки має підрости частка купи, щоб повторити попередження. */
const WARN_REPEAT_STEP = 0.05;

/**
 * Ключі, які в журнал сесії walkthrough не потрапляють НІКОЛИ: у них лежить
 * саме зображення. У журналі мають бути лише шляхи до кадрів — дублювати екран
 * користувача на диску не можна (правило 1 контракту модуля 2.5).
 */
const JOURNAL_FORBIDDEN_KEYS = ["base64", "imageBase64", "image64", "images", "bytesBase64"];
/** Стеля довжини одного рядка в журналі: промпт і сира відповідь потрібні цілі, решта — ні. */
const JOURNAL_MAX_STRING = Number(process.env.SIDECAR_JOURNAL_MAX_STRING || 20000);

/** Байти → мегабайти з одним знаком. */
function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

class LoggerService {
  constructor() {
    this.queryLogBuffer = [];
    this.walkthroughJournalBuffer = new Map();
    // Раніше тут був path.resolve("logs") — тека залежала від cwd процесу.
    // З CLI (npm --prefix sidecar) виходило sidecar/logs, а під Tauri, який
    // стартує node з кореня проєкта, логи розповзались у другу теку.
    this.logsDir = process.env.SIDECAR_LOG_DIR || path.join(config.paths.dataDir, "logs");
    this.queryLogFile = path.join(this.logsDir, "queries.log");
    /** Базове ім'я діагностичного журналу; pino-roll додає номер: sidecar.1.log */
    this.diagLogFile = path.join(this.logsDir, "sidecar.log");

    /** Потік sonic-boom (синхронний) і сам pino. */
    this.destination = null;
    this.pino = null;

    /** Хто зараз в роботі: постачальник заповнює server.js зі своєї мапи jobs. */
    this.inflightProvider = () => [];
    /** Довільні «етапи» (наприклад, поточний режим бенчмарку) — name → об'єкт. */
    this.stages = new Map();

    this.memoryTimer = null;
    this.memoryTicks = 0;
    this.lastWarnedRatio = 0;
    this.memoryWarningListeners = new Set();

    /** sessionId → шлях до файла журналу сесії walkthrough. */
    this.journalFiles = new Map();

    this.handlersInstalled = false;
    /** Межа купи V8 у байтах — беремо з рушія, а не з константи в коді. */
    this.heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
  }

  /**
   * Створює теку журналів і піднімає діагностичний журнал з ротацією.
   * Ідемпотентний: повторний виклик нічого не переробляє.
   */
  async init() {
    if (!this.fileLoggingEnabled()) return null;
    await fs.mkdir(this.logsDir, { recursive: true });
    if (this.pino) return this.pino;

    this.destination = await roll({
      file: this.diagLogFile,
      extension: ".log",
      size: process.env.SIDECAR_LOG_MAX_SIZE || "5m",
      limit: { count: Number(process.env.SIDECAR_LOG_KEEP || 5) },
      symlink: true, // logs/current.log → активний файл
      mkdir: true,
      sync: true, // головна вимога: пережити kill -9
    });

    this.pino = pino(
      {
        level: process.env.SIDECAR_LOG_LEVEL || "info",
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      this.destination,
    );
    return this.pino;
  }

  /** Шлях до активного файла журналу (для банера і діагностики). */
  get currentLogPath() {
    if (!this.fileLoggingEnabled()) return "вимкнено (config.logging.enabled=false)";
    return this.destination?.file || this.diagLogFile;
  }

  /** Чи дозволені саме файли sidecar/logs. Walkthrough-журнал має окремий тумблер. */
  fileLoggingEnabled() {
    return config.logging?.enabled !== false;
  }

  // ────────────────────────── діагностичний журнал ──────────────────────────

  /**
   * Один структурований запис. Пишеться синхронно, тож після повернення
   * з цієї функції рядок уже у файлі (точніше — у сторінковому кеші ОС,
   * який переживає смерть процесу).
   *
   * @param {"debug"|"info"|"warn"|"error"|"fatal"} level
   * @param {string} event - машинна назва події (rpc.call.start тощо)
   * @param {Object} fields - додаткові поля
   * @param {string} [message] - людський текст українською
   */
  event(level, event, fields = {}, message = "") {
    if (!this.fileLoggingEnabled()) return;
    if (!this.pino) {
      // До init() (або якщо він упав) не втрачаємо подію зовсім.
      console.error(`[log:${level}] ${event} ${message}`);
      return;
    }
    this.pino[level]({ event, ...fields }, message || event);
  }

  /** Скидає буфери на диск. При sync:true — запобіжник, не більше. */
  flush() {
    try {
      if (
        this.fileLoggingEnabled() &&
        this.queryLogBuffer &&
        this.queryLogBuffer.length > 0 &&
        this.queryLogFile
      ) {
        require("fs").appendFileSync(this.queryLogFile, this.queryLogBuffer.join(""), "utf8");
        this.queryLogBuffer = [];
      } else if (!this.fileLoggingEnabled()) {
        this.queryLogBuffer = [];
      }
      if (this.walkthroughJournalBuffer) {
        for (const [file, buf] of this.walkthroughJournalBuffer.entries()) {
          if (buf.length > 0) {
            require("fs").appendFileSync(file, buf.join(""), "utf8");
          }
        }
        this.walkthroughJournalBuffer.clear();
      }
      this.destination?.flushSync?.();
    } catch {
      /* журнал не має права валити процес */
    }
  }

  /** Хто постачає список задач «у польоті» (server.js віддає свою мапу jobs). */
  setInflightProvider(fn) {
    this.inflightProvider = typeof fn === "function" ? fn : () => [];
  }

  /**
   * Реєструє або знімає етап роботи, який має бути видно в пульсі.
   * Саме завдяки цьому запис перед раптовою смертю показує не просто
   * «процес жив», а «йшов режим vector+XML, кейс 52 з 312».
   */
  setStage(name, fields) {
    if (fields === null || fields === undefined) this.stages.delete(name);
    else this.stages.set(name, fields);
  }

  /** Безпечно питає постачальника, що зараз виконується. */
  _inflight() {
    try {
      const list = this.inflightProvider();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** Знімок етапів у вигляді звичайного об'єкта. */
  _stages() {
    return this.stages.size ? Object.fromEntries(this.stages) : undefined;
  }

  // ─────────────────────────────── пам'ять ───────────────────────────────

  /**
   * Зріз пам'яті. Межа купи береться з v8.getHeapStatistics(), тому
   * значення правильне і за замовчуванням, і під --max-old-space-size.
   */
  memorySnapshot() {
    const m = process.memoryUsage();
    const limit = this.heapLimitBytes;
    return {
      rssMb: mb(m.rss),
      heapUsedMb: mb(m.heapUsed),
      heapTotalMb: mb(m.heapTotal),
      externalMb: mb(m.external),
      arrayBuffersMb: mb(m.arrayBuffers ?? 0),
      heapLimitMb: mb(limit),
      heapUsedPct: Math.round((m.heapUsed / limit) * 1000) / 10,
    };
  }

  /** Підписка на попередження про пам'ять. Повертає функцію відписки. */
  onMemoryWarning(fn) {
    this.memoryWarningListeners.add(fn);
    return () => this.memoryWarningListeners.delete(fn);
  }

  /**
   * Запускає періодичний зріз пам'яті. Ідемпотентний: скільки б разів
   * його не викликали (RPC-сервер і тест окремо), таймер один.
   */
  startMemoryWatch() {
    if (this.memoryTimer) return;
    this.event(
      "info",
      "memory.watch.start",
      { intervalMs: MEMORY_SAMPLE_MS, ...this.memorySnapshot() },
      "Спостереження за пам'яттю увімкнено",
    );
    this.memoryTimer = setInterval(() => this._memoryTick(), MEMORY_SAMPLE_MS);
    // unref: спостереження не має тримати процес живим саме по собі.
    this.memoryTimer.unref?.();
  }

  /** Зупиняє спостереження (штатне завершення). */
  stopMemoryWatch() {
    if (!this.memoryTimer) return;
    clearInterval(this.memoryTimer);
    this.memoryTimer = null;
  }

  /** Один такт спостереження: пульс у журнал + тривога, якщо купа підповзає до межі. */
  _memoryTick() {
    this.memoryTicks += 1;
    const memory = this.memorySnapshot();
    const inflight = this._inflight();
    const stages = this._stages();
    const ratio = memory.heapUsedPct / 100;

    let level = "info";
    if (ratio >= HEAP_CRITICAL_RATIO) level = "error";
    else if (ratio >= HEAP_WARN_RATIO) level = "warn";

    // Пульс пишемо, коли є робота, коли тривога, або раз на хвилину в простої.
    const busy = inflight.length > 0 || Boolean(stages);
    const idleBeat = this.memoryTicks % IDLE_HEARTBEAT_EVERY === 0;
    if (level === "info" && !busy && !idleBeat) return;

    this.event(
      level,
      "heartbeat",
      { memory, inflight, stages },
      level === "info"
        ? "Пульс процесу"
        : `Купа V8 зайнята на ${memory.heapUsedPct}% (${memory.heapUsedMb} з ${memory.heapLimitMb} МБ)`,
    );

    if (level === "info") {
      this.lastWarnedRatio = 0;
      return;
    }

    // Тривогу назовні повторюємо лише коли стало відчутно гірше,
    // інакше прогрес перетворився б на потік однакових рядків.
    if (ratio < this.lastWarnedRatio + WARN_REPEAT_STEP) return;
    this.lastWarnedRatio = ratio;

    const text =
      `⚠️ Пам'ять: купа V8 зайнята на ${memory.heapUsedPct}% ` +
      `(${memory.heapUsedMb} з ${memory.heapLimitMb} МБ, RSS ${memory.rssMb} МБ). ` +
      `Ще трохи — і процес буде вбито.`;
    for (const listener of this.memoryWarningListeners) {
      try {
        listener(text, memory);
      } catch {
        /* слухач попередження не має права валити процес */
      }
    }
  }

  // ───────────────────────── причина завершення ─────────────────────────

  /**
   * Ставить обробники, які фіксують причину завершення процесу.
   * Ідемпотентний.
   *
   * Що ловимо і що НЕ ловимо:
   *   exit / сигнали / uncaughtException / unhandledRejection — ловимо;
   *   SIGKILL (OOM-killer) і аварію нативного модуля (SIGSEGV) не ловить ніхто —
   *   саме для них існує пульс: останній запис показує, що робилося в цю мить.
   *
   * @param {Object} options
   * @param {string} options.role - хто ставить обробники ("rpc", "test-rag", ...)
   */
  installProcessHandlers({ role = "sidecar" } = {}) {
    if (this.handlersInstalled) return;
    this.handlersInstalled = true;

    process.on("exit", (code) => {
      this.event(
        "info",
        "process.exit",
        {
          role,
          code,
          uptimeSec: Math.round(process.uptime()),
          memory: this.memorySnapshot(),
          inflight: this._inflight(),
          stages: this._stages(),
        },
        `Процес завершується з кодом ${code}`,
      );
      this.flush();
    });

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
      process.on(signal, () => {
        this.event(
          "warn",
          "process.signal",
          {
            role,
            signal,
            memory: this.memorySnapshot(),
            inflight: this._inflight(),
            stages: this._stages(),
          },
          `Отримано сигнал ${signal}`,
        );
        this.flush();
        // Додавши слухача, ми скасували типову реакцію Node на сигнал.
        // Якщо інших слухачів немає (термінальний запуск тесту) — завершуємо
        // процес самі, інакше Ctrl+C перестав би працювати. Якщо слухач не
        // один, зупинку виконує він (у server.js це shutdown()).
        if (process.listenerCount(signal) === 1) process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }

    // Поведінка навмисно та сама, що була в server.js: логуємо і працюємо далі.
    // Помилка одного методу не має вбивати сервер (docs/contracts/rpc.md, правило 4).
    process.on("uncaughtException", (error, origin) => {
      this.event(
        "error",
        "process.uncaughtException",
        {
          role,
          origin,
          error: { message: error?.message, stack: error?.stack },
          memory: this.memorySnapshot(),
          inflight: this._inflight(),
          stages: this._stages(),
        },
        `Неперехоплена помилка: ${error?.message || error}`,
      );
      console.error("[rpc] uncaughtException:", error);
    });

    process.on("unhandledRejection", (reason) => {
      const error =
        reason instanceof Error
          ? { message: reason.message, stack: reason.stack }
          : { message: String(reason), stack: null };
      this.event(
        "error",
        "process.unhandledRejection",
        {
          role,
          error,
          memory: this.memorySnapshot(),
          inflight: this._inflight(),
          stages: this._stages(),
        },
        `Необроблена відмова проміса: ${error.message}`,
      );
      console.error("[rpc] unhandledRejection:", reason);
    });

    // Попередження рушія (наприклад, MaxListenersExceededWarning) теж корисні:
    // саме вони зазвичай передують витоку пам'яті.
    process.on("warning", (warning) => {
      this.event(
        "warn",
        "process.warning",
        { role, name: warning.name, message: warning.message },
        `Попередження Node: ${warning.name}`,
      );
    });
  }

  /** Записує стартовий рядок: версії, межі пам'яті, аргументи. */
  logProcessStart(fields = {}) {
    const heap = v8.getHeapStatistics();
    this.event(
      "info",
      "process.start",
      {
        pid: process.pid,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cwd: process.cwd(),
        argv: process.argv.slice(1),
        execArgv: process.execArgv,
        heapLimitMb: mb(heap.heap_size_limit),
        totalAvailableMb: mb(heap.total_available_size),
        memory: this.memorySnapshot(),
        logFile: this.currentLogPath,
        ...fields,
      },
      "Старт процесу sidecar",
    );
  }

  // ────────────────────── журнал сесій walkthrough ──────────────────────

  /**
   * Другий бік модуля 2.5: після сесії має лишитись файл, за яким її можна
   * РОЗІБРАТИ. Блок `debug` у відповіді живе рівно один крок і зникає разом із
   * вікном підказки; `walkthrough.history` живе рівно стільки, скільки живе
   * процес sidecar. Обидва не годяться, коли питання ставлять наступного дня:
   * «чому на третьому кроці модель повернула саме це».
   *
   * Формат — JSONL: один запис на рядок. Він читається і людиною (`less`,
   * `grep`), і програмою (`jq`, `JSON.parse` по рядках), і дописується без
   * переписування файла, тож обірвана сесія лишає все, що встигло статися.
   *
   * ЗНІМКІВ У ЖУРНАЛІ НЕМАЄ. Кадри прибираються у `walkthrough.finish` (це
   * екран користувача, правило 1 контракту модуля), і дублювати їх у журналі
   * означало б обійти власне правило. У записі лишаються тільки ШЛЯХИ і
   * розміри; `_stripBinary()` окремо викидає з запису все, що схоже на
   * закодоване зображення.
   */

  /** Тека журналів (шлях із конфіга відносний до теки даних). */
  walkthroughJournalDir() {
    const configured = config.walkthrough?.journalDir || "data/walkthrough-journal";
    return path.resolve(config.paths.dataDir, configured);
  }

  /** Чи вести журнал сесій. Вимикається одним ключем конфіга. */
  walkthroughJournalEnabled() {
    return config.walkthrough?.journal !== false;
  }

  /** Шлях до журналу відкритої сесії (null, якщо журнал не ведеться). */
  walkthroughJournalPath(sessionId) {
    return this.journalFiles.get(String(sessionId)) || null;
  }

  /**
   * Викидає з запису все, що не має права потрапити у файл:
   * поля із закодованим зображенням, надто довгі рядки і випадкові буфери.
   * Це запобіжник, а не форматування: жоден виклик не має покластись на те,
   * що передав «правильний» об'єкт.
   */
  _stripBinary(value, depth = 0) {
    if (depth > 8) return "…(занадто глибока структура)";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      // Довгий рядок з самих лише символів base64 — це майже напевно кадр.
      if (value.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
        return `…(двійкові дані пропущено, ${value.length} символів)`;
      }
      if (value.length > JOURNAL_MAX_STRING) {
        return `${value.slice(0, JOURNAL_MAX_STRING)}\n…(обрізано на ${JOURNAL_MAX_STRING} символах)`;
      }
      return value;
    }
    if (typeof value !== "object") return value;
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      return `…(двійкові дані пропущено, ${value.length} байт)`;
    }
    if (Array.isArray(value)) return value.map((item) => this._stripBinary(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (JOURNAL_FORBIDDEN_KEYS.includes(key)) continue;
      out[key] = this._stripBinary(item, depth + 1);
    }
    return out;
  }

  /**
   * Лишає в теці не більше `keep` файлів журналу, найстаріші видаляє.
   * Імена починаються з часової позначки, тож звичайне сортування за іменем —
   * це сортування за часом.
   */
  async rotateWalkthroughJournals(keep) {
    const dir = this.walkthroughJournalDir();
    const limit = Math.max(1, Number(keep) || 20);
    let names = [];
    try {
      names = (await fs.readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
    } catch {
      return 0;
    }
    let removed = 0;
    // Мінус один: одразу після ротації буде створено новий файл.
    for (const name of names.slice(0, Math.max(0, names.length - (limit - 1)))) {
      try {
        await fs.unlink(path.join(dir, name));
        removed += 1;
      } catch {
        /* чужий або вже видалений файл не має валити сесію */
      }
    }
    return removed;
  }

  /**
   * Відкриває журнал сесії: ротація теки + перший запис із метаданими сесії
   * (мета, програма, обрані статті з назвами, звідки вони взялись, план).
   * @returns {Promise<{path: string|null, rotated: number}>}
   */
  async walkthroughJournalOpen(sessionId, header = {}) {
    if (!this.walkthroughJournalEnabled()) return { path: null, rotated: 0 };
    const id = String(sessionId);
    try {
      const dir = this.walkthroughJournalDir();
      await fs.mkdir(dir, { recursive: true });
      const rotated = await this.rotateWalkthroughJournals(config.walkthrough?.journalKeep);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `${stamp}-${id.slice(0, 8)}.jsonl`);
      this.journalFiles.set(id, file);
      await this.walkthroughJournalWrite(id, "session.start", header);
      return { path: file, rotated };
    } catch (error) {
      this.event(
        "warn",
        "walkthrough.journal.error",
        { sessionId: id, error: error.message },
        "Не вдалося відкрити журнал сесії walkthrough",
      );
      this.journalFiles.delete(id);
      return { path: null, rotated: 0 };
    }
  }

  /**
   * Один рядок журналу. Журнал — інструмент налагодження і НЕ має права
   * зупинити сесію, тож будь-яка помилка запису тут гаситься.
   */
  async walkthroughJournalWrite(sessionId, kind, record = {}) {
    const file = this.journalFiles.get(String(sessionId));
    if (!file) return false;
    try {
      const line =
        JSON.stringify({
          at: new Date().toISOString(),
          kind,
          sessionId: String(sessionId),
          ...this._stripBinary(record),
        }) + "\n";
      
      let buf = this.walkthroughJournalBuffer.get(file) || [];
      buf.push(line);
      
      if (buf.length >= 10 || kind === "session.finish") {
        await fs.appendFile(file, buf.join(""), "utf8");
        this.walkthroughJournalBuffer.set(file, []);
      } else {
        this.walkthroughJournalBuffer.set(file, buf);
      }
      return true;
    } catch (error) {
      this.event(
        "warn",
        "walkthrough.journal.error",
        { sessionId: String(sessionId), kind, error: error.message },
        "Не вдалося дописати журнал сесії walkthrough",
      );
      return false;
    }
  }

  /** Закриває журнал сесії підсумковим записом. @returns {Promise<string|null>} */
  async walkthroughJournalClose(sessionId, summary = {}) {
    const id = String(sessionId);
    const file = this.journalFiles.get(id);
    if (!file) return null;
    await this.walkthroughJournalWrite(id, "session.finish", summary);
    this.journalFiles.delete(id);
    return file;
  }

  // ─────────────────────── сумісність зі старим API ───────────────────────

  /**
   * Логує інформацію про запит, відповідь та зворотній зв'язок.
   * Формат файла queries.log лишився незмінним — його читає історія запитів.
   */
  async logQueryWithFeedback(query, contextApps, recommendedApp, response, rawLlmOutput, retrievalStats, feedback) {
    if (!this.fileLoggingEnabled()) return false;
    try {
      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        query, contextApps, recommendedApp, response, rawLlmOutput, retrievalStats, feedback
      }) + "\n";
      
      this.queryLogBuffer.push(logEntry);
      if (this.queryLogBuffer.length >= 10) {
        await fs.appendFile(this.queryLogFile, this.queryLogBuffer.join(""), "utf8");
        this.queryLogBuffer = [];
      }

      return true;

    } catch (err) {
      console.error("Помилка запису логу:", err.message);
      this.event(
        "warn",
        "queries.log.error",
        { error: err.message },
        "Не вдалося дописати queries.log",
      );
      return false;
    }
  }

  /**
   * Логує системні події (запуск, помилки тощо).
   * Тепер це той самий діагностичний журнал з ротацією, а не окремий
   * system.log без обмеження розміру.
   */
  async logSystem(message) {
    this.event("info", "system", { message }, String(message));
  }
}

export const logger = new LoggerService();
