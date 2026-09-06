/**
 * Модуль 2.1 з боку користувача: чи готова система до роботи.
 *
 * Перевірок ДВІ, і вони різні за природою:
 *   1) `bootstrap.check` — ОС, Ollama, моделі. Бази не чіпає навмисно: мусить
 *      працювати навіть тоді, коли все інше зламане.
 *   2) векторна база ПОТОЧНОЇ моделі ембедингу (`db.stats`). Без неї пошук не
 *      падає — `db.searchSimilar` тихо повертає порожньо, і гібридний режим
 *      віддає результат самого лише FTS. Тобто перемикання на модель без бази
 *      виглядає як робоча система, хоча пошуку за змістом уже немає. Саме тому
 *      цей стан треба показати людині й дати вибір: побудувати базу зараз або
 *      свідомо шукати за ключовими словами.
 *
 * Один `bootstrap.check` при відкритті вікна — і далі лише на вимогу. Викликати
 * його на кожен запит не можна: метод питає Ollama по HTTP, і платити за це
 * кожним пошуком безглуздо. Форма відповіді — docs/contracts/rpc.md.
 *
 * Метод не кидає винятків через відсутню Ollama чи модель — це нормальні стани
 * з `ready: false` і списком `actions`. Виняток означає інше: не піднявся сам
 * міст до sidecar, і тоді ми чекаємо на з'єднання і питаємо ще раз.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bootstrapCheck,
  dbStats,
  jobCancel,
  rpc,
  onProgress,
  onStatus,
  onConfigChanged,
  sidecarStatus,
  newRef,
} from "../ipc";

/** Як часто перепитувати, поки бекенд піднімається. */
const RETRY_MS = 1500;
/**
 * Скільки чекати на бекенд, перш ніж називати це поломкою. Зібраний застосунок
 * стартує node, той вантажить нативні модулі й піднімає WebSocket — це секунди,
 * і показувати в цей час «немає зв'язку» означає лякати людину справністю.
 */
const STARTUP_GRACE_MS = 25000;

/** Текст помилки без стека. */
function errorText(error) {
  if (typeof error === "string") return error;
  return String(error?.message ?? error ?? "");
}

/**
 * Стан векторної бази ПОТОЧНОЇ моделі за даними `db.stats`.
 *
 * `null` означає «не змогли дізнатись» (база недоступна або метод упав) — і це
 * не привід замикати вікно: помилку самого пошуку людина побачить із його ж
 * повідомлення, а вигадувати за бекенд ми не будемо.
 */
async function readVectorState() {
  try {
    const stats = await dbStats();
    const model = stats?.currentModel || null;
    if (!model) return null;
    const entry = (stats.models || []).find((item) => item.model === model) || null;
    const chunks = Number(entry?.lancedb?.chunks || 0);
    const covered = Number(entry?.vectorizedApps || entry?.lancedb?.apps || 0);
    const total = Number(stats.appsCount || 0);
    return {
      model,
      chunks,
      apps: covered,
      appsTotal: total,
      // Наявність таблиці ще не означає готовність: перервана індексація лишає
      // частину програм необробленими, і пошук їх просто не знаходить. Повнота
      // рахується покриттям програм — це те саме, що `ready` в `db.stats`.
      complete: Boolean(entry?.ready) || (total > 0 && covered >= total),
      // Чи є ЩО векторизувати. На порожній базі `pipeline.vectorize` дав би нуль
      // чанків — там потрібен увесь пайплайн, і людині треба сказати про це
      // прямо, бо це години, а не хвилини.
      hasCorpus: Number(stats.webDocumentsCount || 0) > 0 || Number(stats.chunksFtsTotal || 0) > 0,
      // Порожня тека LanceDB створюється сама при першому підключенні, тож
      // «існує» — це саме наявна таблиця з чанками, а не наявна тека.
      exists: Boolean(entry?.lancedb?.tableExists) && chunks > 0,
    };
  } catch {
    return null;
  }
}

/** Чи підключений міст до sidecar. Питаємо Rust, а не вгадуємо по тексту помилки. */
async function bridgeConnected() {
  try {
    return Boolean((await sidecarStatus())?.connected);
  } catch {
    return false;
  }
}

export function useReadiness() {
  // starting — бекенд ще піднімається; checking — питаємо; ready — можна
  // працювати; blocked — ready:false; novectors — оточення готове, але для
  // обраної моделі немає векторної бази; failed — виклик не вдався і чекати вже
  // немарно (минув STARTUP_GRACE_MS або міст підключений, а метод усе одно впав).
  const [phase, setPhase] = useState("starting");
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  // Стан завантаження моделі: {model, msg, pct, error}. null — нічого не тягнемо.
  const [pull, setPull] = useState(null);
  // Векторна база поточної моделі: {model, exists, chunks, apps}. null — стан
  // невідомий (база недоступна), і це НЕ причина замикати вікно.
  const [vectors, setVectors] = useState(null);
  // Стан побудови бази: {msg, pct, error, cancelled}. null — не будуємо.
  const [build, setBuild] = useState(null);

  const inFlightRef = useRef(false);
  const startedAtRef = useRef(Date.now());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // Мітка активного pullModel. Прогрес чужих операцій приходить у те саме
  // вікно, тож беремо лише свій (див. правило про `ref` у контракті).
  const pullRefRef = useRef(null);
  // Те саме для побудови векторної бази, плюс серверний id: `job.cancel`
  // приймає саме його, а дізнатись його можна лише з події прогресу.
  const buildRefRef = useRef(null);
  const buildIdRef = useRef(null);
  /**
   * Модель, для якої людина СВІДОМО пропустила побудову бази. Поки обрана
   * модель та сама — більше не питаємо; змінилась — питаємо знову.
   */
  const skippedModelRef = useRef(null);

  const check = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("checking");
    setError(null);
    try {
      const result = await bootstrapCheck();
      setReport(result);
      if (!result?.ready) {
        setPhase("blocked");
        return;
      }

      const state = await readVectorState();
      setVectors(state);
      // Незавершена індексація — теж привід нагадати: пошук працює, але знайде
      // не все, і мовчати про це так само нечесно, як і про повну відсутність.
      const incomplete = state && (!state.exists || !state.complete);
      const skipped = state && skippedModelRef.current === state.model;
      setPhase(incomplete && !skipped ? "novectors" : "ready");
    } catch (caught) {
      // Різниця принципова: якщо мосту ще немає — це запуск, а не поломка.
      // Якщо міст є, а метод усе одно впав — це справжня помилка, її й показуємо.
      const connected = await bridgeConnected();
      const waitedTooLong = Date.now() - startedAtRef.current > STARTUP_GRACE_MS;
      setError(errorText(caught));
      setPhase(connected || waitedTooLong ? "failed" : "starting");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  // Поки бекенд піднімається — перепитуємо самі. Людині не треба тиснути
  // «Перевірити ще раз» лише тому, що вона відкрила вікно на секунду раніше.
  useEffect(() => {
    if (phase !== "starting") return undefined;
    const timer = setInterval(() => check(), RETRY_MS);
    return () => clearInterval(timer);
  }, [phase, check]);

  // Міст піднімається не миттєво: перша перевірка може впасти на «sidecar не
  // підключений». Щойно з'єднання з'явилось — питаємо ще раз, самі. Повторні
  // перепідключення (sidecar --watch) перевірку не смикають: вона потрібна
  // лише тим, хто відповіді ще не отримав.
  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    const subscription = onStatus((status) => {
      const waiting = phaseRef.current === "failed" || phaseRef.current === "starting";
      if (status?.connected && waiting) check();
    });
    subscription
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [check]);

  // Конфіг змінили в панелі розробника (модель або режим пошуку) — перевіряємо
  // заново одразу. Перемикач, який діє лише після перезапуску вікна, — не
  // перемикач, а записка на майбутнє.
  useEffect(() => onConfigChanged(() => check()), [check]);

  // Прогрес завантаження моделі: `ollama pull` тягне гігабайти, і людина мусить
  // бачити відсотки, а не застиглий екран.
  useEffect(() => {
    let unlisten = null;
    let disposed = false;

    const subscription = onProgress((payload) => {
      if (!payload) return;
      const merge = (prev) =>
        prev
          ? {
              ...prev,
              msg: typeof payload.msg === "string" ? payload.msg : prev.msg,
              pct: typeof payload.pct === "number" ? payload.pct : null,
            }
          : prev;

      if (pullRefRef.current && payload.ref === pullRefRef.current) {
        setPull(merge);
        return;
      }
      if (buildRefRef.current && payload.ref === buildRefRef.current) {
        // Серверний id приходить лише тут — без нього нічого не скасувати.
        if (typeof payload.id === "number") buildIdRef.current = payload.id;
        setBuild(merge);
      }
    });
    subscription
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  /** Завантажити модель і одразу перепитати готовність. */
  const pullModel = useCallback(
    async (model) => {
      if (!model || pullRefRef.current) return;
      const ref = newRef("gate-pull");
      pullRefRef.current = ref;
      setPull({ model, msg: "", pct: null, error: null });
      try {
        await rpc("bootstrap.pullModel", { model }, ref);
        pullRefRef.current = null;
        setPull(null);
        await check();
      } catch (caught) {
        pullRefRef.current = null;
        setPull({ model, msg: null, pct: null, error: errorText(caught) });
      }
    },
    [check],
  );

  /**
   * Побудувати векторну базу для поточної моделі.
   *
   * Це `pipeline.vectorize` — саме він працює з моделлю з конфіга, а вона після
   * перемикання і є поточною. Довідку заново не скачуємо: вона вже в базі.
   */
  const buildVectors = useCallback(async () => {
    if (buildRefRef.current) return;
    // Порожня база — це весь пайплайн (сканування, довідка, вектори), інакше
    // достатньо векторизації: довідка вже лежить у базі.
    const method = vectors?.hasCorpus === false ? "pipeline.fullSync" : "pipeline.vectorize";
    const ref = newRef("gate-vectorize");
    buildRefRef.current = ref;
    buildIdRef.current = null;
    setBuild({ msg: "", pct: null, error: null, cancelled: false });
    try {
      const result = await rpc(method, {}, ref);
      buildRefRef.current = null;
      // Скасована операція повертається УСПІШНИМ результатом із cancelled:true
      // (контракт, «Скасування — не помилка»), і виглядати має інакше за збій.
      //
      // Окремо — «успіх, але нуль»: крок може завершитись без помилки й не
      // створити жодного вектора (наприклад, векторизувати нічого). Мовчки
      // повертати той самий екран не можна: людина натиснула кнопку і має
      // право знати, що саме сталось.
      const produced = Number(result?.chunks ?? 0);
      setBuild(
        result?.cancelled
          ? { msg: null, pct: null, error: null, cancelled: true }
          : produced > 0
            ? null
            : { msg: null, pct: null, error: null, empty: true },
      );
      await check();
    } catch (caught) {
      buildRefRef.current = null;
      setBuild({ msg: null, pct: null, error: errorText(caught), cancelled: false });
    }
  }, [check, vectors]);

  /** Зупинити побудову. Поки не було жодної події прогресу — зупиняти нічого. */
  const cancelBuild = useCallback(async () => {
    const id = buildIdRef.current;
    if (typeof id !== "number") return;
    try {
      await jobCancel(id);
    } catch {
      // Відмову бекенда покаже сама операція: вона завершиться як завершиться.
    }
  }, []);

  /** Свідомо працювати без векторів: пошук лишається на ключових словах. */
  const skipVectors = useCallback(() => {
    skippedModelRef.current = vectors?.model || null;
    setBuild(null);
    setPhase("ready");
  }, [vectors]);

  return {
    phase,
    report,
    error,
    pull,
    vectors,
    build,
    // Правда для інтерфейсу після пропуску: векторів немає, і це варто показати
    // поруч із результатом, а не забути до наступного запуску.
    vectorsMissing: Boolean(vectors && !vectors.exists),
    check,
    pullModel,
    buildVectors,
    cancelBuild,
    skipVectors,
  };
}
