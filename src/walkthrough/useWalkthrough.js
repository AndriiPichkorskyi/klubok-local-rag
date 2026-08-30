/**
 * Уся машина стану однієї сесії підказки: start → step → step → finish,
 * плюс stuck, запуск програми і скасування довгого виклику зору.
 *
 * З бекендом говоримо через src/ipc.js (rpc), з ОС — через ./tauri.js.
 * Інтерфейс не блокується ніколи: кожен довгий виклик має мітку clientRef,
 * живий секундомір, рядок прогресу і кнопку «Скасувати» (job.cancel).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, jobCancel, onProgress, newRef, configGet } from "../ipc";
import { ACTION } from "./states";
import { buildEntry } from "./diagnostics";
import {
  screenCapture,
  launchApp,
  frontmostApp,
  overlayHighlight,
  MissingCommandError,
  ScreenPermissionError,
} from "./tauri";

/** Значення за замовчуванням — рівно ті, що в config/pipeline.config.json. */
export const DEFAULT_CONFIG = {
  captureMode: "window",
  enableHighlight: false,
  visionTimeoutSec: 120,
  maxStepsPerSession: 12,
  stepSource: "vision",
  visionModel: "",
  // Скільки чекати після активації цільової програми, поки вона вийде наперед.
  // `open` повертається раніше, ніж вікно з'явиться на екрані, тож без цієї
  // паузи знімок застає ще наш інтерфейс. Значення з конфіга
  // (`walkthrough.activationDelayMs`); 450 мс — з запасом на анімацію Spaces.
  activationDelayMs: 450,
  // Блок діагностики у відповіді кроку. Вмикає його бекенд.
  debug: false,
};

/** Скільки записів історії сесії тримаємо у вікні. */
const HISTORY_LIMIT = 40;

/** Пауза, яку можна перервати лише лічильником запусків (див. runRef). */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

/** Пауза активації з конфіга: чуже значення не має вішати вікно на хвилину. */
export function activationDelay(value, fallback = DEFAULT_CONFIG.activationDelayMs) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 5000);
}

/** Що саме зараз робимо — від цього залежить текст очікування. */
export const BUSY = {
  START: "start",
  ACTIVATE: "activate",
  CAPTURE: "capture",
  STEP: "step",
  STUCK: "stuck",
  LAUNCH: "launch",
  FINISH: "finish",
  MANUAL: "manual",
  MODE: "mode",
};

const BUSY_TEXT = {
  [BUSY.START]: "Готуємо підказку…",
  [BUSY.ACTIVATE]: "Виводимо програму наперед…",
  [BUSY.CAPTURE]: "Робимо знімок екрана…",
  [BUSY.STEP]: "Дивимось, що зараз на екрані…",
  [BUSY.STUCK]: "Шукаємо той самий елемент інакше…",
  [BUSY.LAUNCH]: "Запускаємо програму…",
  [BUSY.FINISH]: "Закриваємо сесію…",
  [BUSY.MANUAL]: "Наступний крок зі списку…",
  [BUSY.MODE]: "Готуємо список кроків із довідки…",
};

const UNKNOWN_METHOD_RE = /unknown\s*method|невідомий метод|немає методу|method\s+.*\s+not/i;

/**
 * Технічна помилка → пояснення для людини. Стек не показуємо ніколи.
 * Три випадки мають власний вигляд, бо мають різні дії людини.
 */
export function describeFailure(error, stage = "") {
  if (error instanceof MissingCommandError) {
    return {
      kind: "missing-command",
      title: "Ця частина застосунку ще не готова",
      hint:
        `Вікно підказки просить у застосунку команду «${error.command}», ` +
        "а її в цій збірці ще немає. Підказка не зможе бачити екран, поки команду не додадуть.",
      detail: error.command,
    };
  }
  if (error instanceof ScreenPermissionError) {
    return {
      kind: "screen-permission",
      title: "Немає дозволу на запис екрана",
      hint:
        "Системні параметри → Конфіденційність і безпека → Запис екрана: увімкніть цей застосунок " +
        "і запустіть його наново. Без дозволу підказка не бачить, що у вас на екрані.",
      detail: "",
    };
  }
  const raw = typeof error === "string" ? error : String(error?.message ?? error ?? "");
  if (UNKNOWN_METHOD_RE.test(raw)) {
    return {
      kind: "missing-method",
      title: "Бекенд ще не вміє вести по кроках",
      hint:
        "Sidecar відповів, що методу walkthrough немає. Модуль покрокової підказки на бекенді " +
        "ще не під'єднано — інтерфейс готовий і запрацює, щойно метод з'явиться.",
      detail: raw.trim(),
    };
  }
  if (/ollama|11434|econnrefused|fetch failed/i.test(raw)) {
    return {
      kind: "ollama",
      title: "Схоже, Ollama не запущена",
      hint: "Модель зору працює локально. Виконайте «ollama serve» і спробуйте ще раз.",
      detail: raw.trim(),
    };
  }
  return {
    kind: "error",
    title: stage ? `Не вдалося: ${stage}` : "Не вдалося продовжити",
    hint: raw.trim() ? `Бекенд повідомив: ${raw.trim()}` : "Спробуйте ще раз.",
    detail: raw.trim(),
  };
}

const IDLE_PROGRESS = { msg: "", pct: null };

/**
 * @param request завдання сесії
 * @param options `{debug}` — чи просити в бекенда блок діагностики. Вмикається
 *        перемикачем «сире» у шапці: `walkthrough.step` приймає явний `debug`,
 *        і він має перевагу над `config.walkthrough.debug`, тож автор бачить
 *        сире, не правлячи конфіг.
 */
export function useWalkthrough(request, options = {}) {
  const [phase, setPhase] = useState("idle"); // idle | busy | step | error | finished
  const [busyKind, setBusyKind] = useState(null);
  const [step, setStep] = useState(null);
  const [session, setSession] = useState(null); // {sessionId, appName, planned}
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(IDLE_PROGRESS);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [note, setNote] = useState("");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [frontmost, setFrontmost] = useState(null);
  const [history, setHistory] = useState([]); // сирі дані всіх кроків сесії
  // Режим кроків САМЕ ЦІЄЇ сесії. У конфізі лежить лише стартове значення:
  // перемикач у вікні підказки міняє режим посеред сесії, і джерелом правди
  // стає те, що відповів бекенд у полі `stepSource`.
  const [stepSource, setStepSource] = useState(DEFAULT_CONFIG.stepSource);
  // Скільки разів за сесію вікно справді ходило до зору (кадр + виклик моделі).
  // У ручному режимі лишається нулем — це і є доказ, що зір не задіяний.
  const [visionCalls, setVisionCalls] = useState(0);

  const runRef = useRef(0); // лічильник запусків: відповідь застарілого виклику ігноруємо
  const activeRef = useRef(false);
  const jobIdRef = useRef(null); // id задачі на бекенді бачимо лише в кадрах progress
  const clientRefRef = useRef(null);
  const startedAtRef = useRef(0);
  const sessionIdRef = useRef(null);
  const configRef = useRef(DEFAULT_CONFIG);
  const stepSourceRef = useRef(DEFAULT_CONFIG.stepSource);
  const wantDebugRef = useRef(false);
  wantDebugRef.current = options.debug === true;

  // Конфіг читаємо один раз: звідти режим знімка, ліміт очікування і прапорець рамки.
  useEffect(() => {
    let alive = true;
    configGet()
      .then((full) => {
        if (!alive || !full || typeof full !== "object") return;
        const wt = full.walkthrough && typeof full.walkthrough === "object" ? full.walkthrough : {};
        const next = {
          ...DEFAULT_CONFIG,
          ...wt,
          activationDelayMs: activationDelay(wt.activationDelayMs),
          debug: wt.debug === true,
          visionModel: full.ollama?.visionModel || "",
        };
        configRef.current = next;
        setConfig(next);
        // Стартове значення режиму. Далі його перебиває відповідь бекенда.
        if (!sessionIdRef.current) {
          stepSourceRef.current = next.stepSource;
          setStepSource(next.stepSource);
        }
      })
      .catch(() => {
        /* конфіг недоступний — працюємо на значеннях за замовчуванням */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Живий прогрес довгих викликів. Фільтруємо СВОЇ кадри за міткою ref:
  // прогрес чужої операції не має переписувати рядок стану підказки.
  useEffect(() => {
    const sub = onProgress((payload) => {
      if (!activeRef.current || !payload) return;
      if (!clientRefRef.current || payload.ref !== clientRefRef.current) return;
      if (typeof payload.id === "number") jobIdRef.current = payload.id;
      setProgress({
        msg: typeof payload.msg === "string" ? payload.msg : "",
        pct: typeof payload.pct === "number" ? payload.pct : null,
      });
    });
    return () => {
      sub.then?.((un) => un()).catch(() => {});
    };
  }, []);

  // Секундомір очікування. Зір триває десятки секунд — порожнеча в цей час
  // читається як зависання, тож час має йти на очах.
  useEffect(() => {
    if (phase !== "busy") return undefined;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
    return () => clearInterval(timer);
  }, [phase]);

  const beginBusy = useCallback((kind) => {
    const runId = ++runRef.current;
    activeRef.current = true;
    jobIdRef.current = null;
    clientRefRef.current = newRef(`wt-${kind}`);
    startedAtRef.current = Date.now();
    setBusyKind(kind);
    setNote("");
    setError(null);
    setElapsedMs(0);
    setProgress({ msg: BUSY_TEXT[kind] || "", pct: null });
    setPhase("busy");
    return runId;
  }, []);

  const settle = useCallback((runId) => {
    if (runRef.current !== runId) return false; // виклик скасовано або замінено новим
    activeRef.current = false;
    setProgress(IDLE_PROGRESS);
    return true;
  }, []);

  const fail = useCallback(
    (runId, err, stage) => {
      if (!settle(runId)) return;
      setError(describeFailure(err, stage));
      setBusyKind(null);
      setPhase("error");
    },
    [settle],
  );

  /**
   * Запис у історію сесії. Пишемо і вдалий крок, і невдалий: сесія, що впала
   * на третьому кроці, розповідає авторові більше за успішну.
   */
  const pushEntry = useCallback((payload) => {
    setHistory((list) => [...list, buildEntry(payload)].slice(-HISTORY_LIMIT));
  }, []);

  /** Прийом кроку: однаковий для walkthrough.step і walkthrough.stuck. */
  const acceptStep = useCallback((result) => {
    const safe = result && typeof result === "object" ? result : {};
    // Режим сесії тримає бекенд: він же будує план і знає, чи перемикання
    // вдалося. Вікно лише відображає те, що прийшло.
    if (safe.stepSource === "vision" || safe.stepSource === "plan") {
      stepSourceRef.current = safe.stepSource;
      setStepSource(safe.stepSource);
    }
    setStep(safe);
    setBusyKind(null);
    setPhase("step");
    // Рамка поверх екрана — другий етап. Точка виклику є, вмикає її конфіг.
    if (configRef.current.enableHighlight && safe.target?.box) {
      overlayHighlight(safe.target.box);
    }
  }, []);

  /**
   * Один крок цілком. Порядок тут — головне виправлення модуля і прямо
   * прописаний у контракті («Знімок робиться після активації цільової програми»):
   *
   *   активувати цільову програму → дати їй мить вийти наперед → знімок →
   *   спитати ОС, хто попереду → віддати кадр і frontmost у walkthrough.step.
   *
   * Причина: натискання «Далі» в цьому вікні щойно вивело НАШ застосунок на
   * передній план. Знімок без активації ловить саме його, і модель чесно
   * повідомляє, що потрібної програми немає, — скільки б вікно не відсували
   * убік: справа у фокусі, а не в перекритті.
   *
   * Один шлях на «Далі», «перевірити», «ще раз» і «запустити»: різниця лише в
   * підписі кнопки й у назві методу, дія та сама — подивитись на екран зараз.
   */
  const advance = useCallback(
    async ({
      method = "walkthrough.step",
      busy = BUSY.STEP,
      activateBusy = BUSY.ACTIVATE,
      // «Я це зробив»: слово людини про попередній крок.
      userConfirmed = false,
      // Перемикання режиму просто в цьому виклику; null — лишити як є.
      stepSource: wantSource = null,
    } = {}) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      const cfg = configRef.current;
      const mode = wantSource || stepSourceRef.current;

      // ── РУЧНИЙ РЕЖИМ ──────────────────────────────────────────────────
      // Найкоротший шлях у файлі, і це навмисно: ні активації, ні знімка, ні
      // frontmost, ні очікування моделі — лише наступний пункт списку з
      // довідки. Саме тому він працює завжди і не має чого ламати на захисті.
      if (mode === "plan" && method === "walkthrough.step") {
        const startedAtManual = Date.now();
        const runId = beginBusy(wantSource === "plan" ? BUSY.MODE : BUSY.MANUAL);
        const params = { sessionId };
        if (wantSource) params.stepSource = wantSource;
        if (userConfirmed) params.userConfirmed = true;
        if (wantDebugRef.current) params.debug = true;
        try {
          const result = await rpc(method, params, clientRefRef.current);
          if (!settle(runId)) return;
          pushEntry({
            method,
            step: result && typeof result === "object" ? result : null,
            clientMs: Date.now() - startedAtManual,
          });
          acceptStep(result);
        } catch (err) {
          pushEntry({
            method,
            clientMs: Date.now() - startedAtManual,
            error: describeFailure(err, "список кроків із довідки"),
          });
          fail(runId, err, "список кроків із довідки");
        }
        return;
      }

      const appId = request?.appId || "";
      const delayMs = activationDelay(cfg.activationDelayMs);
      const startedAt = Date.now();
      const runId = beginBusy(appId ? activateBusy : BUSY.CAPTURE);
      let activation = null;

      // 1. Цільова програма — наперед. Вона вже запущена, тож `launch_app` тут
      //    працює саме як активація (Rust робить те саме `open`).
      if (appId) {
        try {
          const result = await launchApp(appId);
          activation = {
            ok: true,
            appId,
            ...(result && typeof result === "object" ? result : {}),
          };
        } catch (err) {
          // Активація не вдалась — крок не зриваємо. Знімок усе одно робимо, а
          // бекенд за frontmost сам виставить wrong_window: це його робота.
          activation = { ok: false, appId, error: String(err?.message ?? err) };
        }
        if (runRef.current !== runId) return;

        // 2. Мить на вихід наперед: `open` повертається раніше, ніж вікно
        //    справді з'явиться на екрані.
        await wait(delayMs);
        if (runRef.current !== runId) return;
        setBusyKind(BUSY.CAPTURE);
        setProgress({ msg: BUSY_TEXT[BUSY.CAPTURE], pct: null });
      }

      // 3. Знімок — уже з цільовою програмою в кадрі.
      let shot;
      try {
        shot = await screenCapture(cfg.captureMode);
      } catch (err) {
        pushEntry({
          method,
          activation,
          activationDelayMs: delayMs,
          clientMs: Date.now() - startedAt,
          error: describeFailure(err, "знімок екрана"),
        });
        fail(runId, err, "знімок екрана");
        return;
      }
      if (runRef.current !== runId) return;

      // 4. Хто попереду НАСПРАВДІ. Це відповідь ОС, а не здогад зору: модель не
      //    бачила іконок цих програм і відрізнити їх не може, а `frontmost_app`
      //    знає точно. З цієї відповіді бекенд і виставляє wrong_window.
      const front = await frontmostApp();
      if (runRef.current !== runId) return;
      setFrontmost(front?.name || null);

      const params = { sessionId, screenshotPath: shot.path };
      // Повернення в режим зору з ручного — тим самим викликом, що й крок.
      if (wantSource) params.stepSource = wantSource;
      // Слово людини про попередній крок: бекенд рухає сесію навіть тоді, коли
      // модель не впевнена. Людина бачить свій екран краще за неї.
      if (userConfirmed) params.userConfirmed = true;
      // Контракт дає `frontmost` саме методу walkthrough.step; walkthrough.stuck
      // приймає лише сесію і кадр, тож туди зайвого не шлемо.
      const frontmostSent = Boolean(front) && method === "walkthrough.step";
      if (frontmostSent) {
        params.frontmost = { name: front.name ?? null, bundleId: front.bundleId ?? null };
      }
      // Розгорнутий режим розробника — це і є запит на сире. Блок діагностики
      // роздуває відповідь, тож просимо його лише тоді, коли його читатимуть.
      if (wantDebugRef.current) params.debug = true;

      setBusyKind(busy);
      setProgress({ msg: BUSY_TEXT[busy] || "", pct: null });
      try {
        const result = await rpc(method, params, clientRefRef.current);
        if (!settle(runId)) return;
        // Лічильник викликів зору вікна. Рахуємо лише те, за що модель справді
        // бралась: коли стан визначила ОС із frontmost, зору не було.
        if (result?.source === "vision" || result?.debug?.visionCalls > 0) {
          setVisionCalls((n) => n + 1);
        }
        // Знімок і його метадані тримаємо разом із кроком: без widthPx/heightPx/
        // scaleFactor нормалізовані координати нема з чого переводити в точки екрана.
        const safe =
          result && typeof result === "object" ? { ...result, capture: shot } : result;
        pushEntry({
          method,
          step: safe,
          capture: shot,
          frontmost: front,
          frontmostSent,
          activation,
          activationDelayMs: delayMs,
          clientMs: Date.now() - startedAt,
        });
        acceptStep(safe);
      } catch (err) {
        pushEntry({
          method,
          capture: shot,
          frontmost: front,
          frontmostSent,
          activation,
          activationDelayMs: delayMs,
          clientMs: Date.now() - startedAt,
          error: describeFailure(err, "аналіз екрана"),
        });
        fail(runId, err, "аналіз екрана");
      }
    },
    [acceptStep, beginBusy, fail, pushEntry, request, settle],
  );

  /**
   * Перемикач режиму просто посеред сесії — головний запасний шлях вікна.
   *
   * Пройдені кроки не втрачаються: сесія на бекенді та сама, `stepIndex` і
   * історія лишаються, змінюється лише те, звідки береться наступна інструкція.
   * Перехід у ручний режим одразу показує перший пункт списку, тож натискати
   * щось іще після перемикання не треба.
   */
  const switchMode = useCallback(
    (next) => {
      if (next !== "vision" && next !== "plan") return undefined;
      if (!sessionIdRef.current || next === stepSourceRef.current) return undefined;
      return advance({ stepSource: next });
    },
    [advance],
  );

  /** «Я це зробив» — останнє слово людини про попередній крок. */
  const confirmDone = useCallback(() => advance({ userConfirmed: true }), [advance]);

  /** Створення сесії і перший крок. */
  const start = useCallback(async () => {
    if (!request) return;
    const runId = beginBusy(BUSY.START);
    try {
      const result = await rpc(
        "walkthrough.start",
        { appId: request.appId, goal: request.goal, docId: request.docId || undefined },
        clientRefRef.current,
      );
      if (!settle(runId)) return;
      const safe = result && typeof result === "object" ? result : {};
      sessionIdRef.current = safe.sessionId ?? null;
      setSession({
        sessionId: safe.sessionId ?? null,
        appName: safe.appName || request.appName,
        planned: Array.isArray(safe.planned) ? safe.planned : [],
        stepSource: safe.stepSource || configRef.current.stepSource,
      });
      if (safe.stepSource === "vision" || safe.stepSource === "plan") {
        stepSourceRef.current = safe.stepSource;
        setStepSource(safe.stepSource);
      }
      if (!sessionIdRef.current) {
        setError(describeFailure(new Error("Бекенд не повернув sessionId"), "створення сесії"));
        setBusyKind(null);
        setPhase("error");
        return;
      }
      await advance();
    } catch (err) {
      fail(runId, err, "створення сесії");
    }
  }, [advance, beginBusy, fail, request, settle]);

  /** «Я не бачу цієї кнопки» — головний рятівний шлях сесії. */
  const stuck = useCallback(
    () => advance({ method: "walkthrough.stuck", busy: BUSY.STUCK }),
    [advance],
  );

  /**
   * «Запустити програму». Окремого виклику `launch_app` тут більше немає:
   * крок сам починається з активації, і другий запуск був би зайвим. Різниця
   * лише в підписі очікування — людина натиснула саме «запустити».
   */
  const launch = useCallback(() => advance({ activateBusy: BUSY.LAUNCH }), [advance]);

  /** Закриття сесії: бекенд звільняє ресурси і прибирає знімки з диска. */
  const finish = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    runRef.current += 1;
    activeRef.current = false;
    setPhase("finished");
    setBusyKind(null);
    setProgress(IDLE_PROGRESS);
    if (sessionId) {
      try {
        await rpc("walkthrough.finish", { sessionId });
      } catch {
        /* сесія все одно вважається закритою: знімки прибере старт наступної */
      }
    }
  }, []);

  /** Скасування довгого виклику. Останній крок лишається на екрані. */
  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    runRef.current += 1;
    activeRef.current = false;
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    if (typeof jobId === "number") jobCancel(jobId).catch(() => {});
    setProgress(IDLE_PROGRESS);
    setBusyKind(null);
    setNote("Аналіз скасовано. Можна спробувати ще раз.");
    setPhase(step ? "step" : "idle");
  }, [step]);

  /** Головна дія поточного стану (описи — у states.js). */
  const runAction = useCallback(
    (action) => {
      switch (action) {
        case ACTION.LAUNCH:
          return launch();
        case ACTION.FINISH:
          return finish();
        case ACTION.CONFIRM:
          return confirmDone();
        case ACTION.MANUAL:
          return switchMode("plan");
        case ACTION.NEXT:
        case ACTION.RECHECK:
        case ACTION.RETRY:
        default:
          return advance();
      }
    },
    [advance, confirmDone, finish, launch, switchMode],
  );

  // Закриття вікна не має лишати сесію і знімки живими на диску.
  useEffect(() => {
    const onUnload = () => {
      const sessionId = sessionIdRef.current;
      if (sessionId) rpc("walkthrough.finish", { sessionId })?.catch?.(() => {});
    };
    if (typeof window !== "undefined") window.addEventListener("beforeunload", onUnload);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("beforeunload", onUnload);
      onUnload();
    };
  }, []);

  return {
    phase,
    busyKind,
    busyText: BUSY_TEXT[busyKind] || "",
    step,
    session,
    error,
    progress,
    elapsedMs,
    note,
    config,
    frontmost,
    history,
    // Режим цієї сесії і скільки разів вікно ходило до зору. Друге потрібне і
    // діагностиці, і звіту: у ручному режимі число лишається нулем.
    stepSource,
    visionCalls,
    start,
    stuck,
    cancel,
    finish,
    retry: () => advance(),
    runAction,
    switchMode,
    confirmDone,
  };
}
