/**
 * Файл: src/modules/walkthrough/index.js
 * Опис: Модуль 2.5 (серверна частина): аналіз знімка екрана і формування
 *       наступного кроку. Контракт — docs/contracts/walkthrough.md.
 *
 * Два режими, обидва робочі, перемикач `config.walkthrough.stepSource`:
 *
 *   vision — модель дивиться на кадр і сама вирішує, який крок наступний,
 *            спираючись на документацію. Основний шлях роботи.
 *   plan   — РУЧНИЙ режим: список кроків один раз готує звичайна чат-модель із
 *            довідки, а далі користувач іде по ньому сам. Зір не викликається
 *            взагалі: нуль очікування, нуль здогадів, нічого не ламається.
 *            Це запасний шлях, який працює завжди — зокрема тоді, коли зір
 *            зациклився або Ollama з vision-моделлю недоступна.
 *
 * Форма відповіді `step` однакова в обох режимах — її задає контракт, і
 * оверлей не має знати, звідки саме взявся крок (крім поля `source`).
 *
 * Просування вперед — окреме пряме питання, а не здогад. Модель, яку питають
 * лише «що робити ДАЛІ», дивиться на кожен кадр як на перший і повторює свій
 * же висновок; тому кожен крок після першого починається з питання «чи видно в
 * кадрі, що попередню інструкцію виконано» (`previous_done`), і лічильник
 * зсувається за відповіддю на нього. Останнє слово лишається за людиною:
 * `userConfirmed: true` рухає сесію вперед незалежно від того, що бачить модель.
 * Дві однакові інструкції поспіль — це не крок, а глухий кут: модуль сам
 * виставляє стан `loop` і пропонує ручний режим замість третього повтору.
 */

import { config } from "../../config/config.js";
import { logger } from "../../services/logger.service.js";
import { ollama } from "../../services/ollama.service.js";
import { findApp, loadAppDocs } from "./docs.js";
import {
  prepareScreenshot,
  purgeScreenshotsDir,
  screenshotExists,
  screenshotsDir,
} from "./image.js";
import {
  CONFIRMED_STATES,
  PLAN_SCHEMA,
  STATES,
  buildPlanPrompt,
  buildStuckPrompt,
  buildVerifyPrompt,
  buildVisionStepPrompt,
  visionStepSchema,
  visionVerifySchema,
} from "./prompts.js";
import { decideFromFrontmost, matchFrontmost } from "./frontmost.js";
import {
  activeSessions,
  createSession,
  dropSession,
  getSession,
  normalizeInstruction,
  trackFile,
} from "./session.js";
import { askVision, parseModelJson, toStepFields } from "./vision.js";

/** Дозволені джерела кроку. Невідоме значення — помилка, а не тихий фолбек. */
export const STEP_SOURCES = ["vision", "plan"];

/**
 * Стан, який виставляє САМ модуль, а не модель: та сама інструкція вдруге
 * поспіль. Моделі його немає в переліку навмисно — вона не може «обрати глухий
 * кут», його видно лише збоку, з історії сесії.
 */
export const LOOP_STATE = "loop";

/** Стани, після яких лічильник кроків не зсувається: корисного кроку не було. */
const STATES_WITHOUT_PROGRESS = ["unclear", LOOP_STATE];

/** Читає налаштування модуля з конфіга (їх можна перечитати через config.reload). */
function settings() {
  const w = config.walkthrough || {};
  return {
    enabled: w.enabled !== false,
    enableScreenAnalysis: w.enableScreenAnalysis !== false,
    stepSource: w.stepSource || "vision",
    // Ручний режим за замовчуванням НЕ звертається до зору. Прапорець лишає
    // старий шлях (план веде, зір звіряє кадр) доступним для експерименту.
    planVerify: w.planVerify === true,
    maxSteps: Number(w.maxStepsPerSession) || 12,
    maxImageWidth: Number(w.maxImageWidth) || 1280,
    visionTimeoutMs: (Number(w.visionTimeoutSec) || 120) * 1000,
    debug: w.debug === true,
  };
}

/**
 * Чи додавати до відповіді блок діагностики. Вмикає його `config.walkthrough.debug`;
 * явний `debug` у параметрах виклику має перевагу — так режим можна ввімкнути
 * з панелі розробника, не чіпаючи конфіг. Вимкнено — блока в відповіді немає
 * взагалі, щоб звичайна відповідь не роздувалась.
 */
function debugEnabled(params, cfg) {
  if (typeof params.debug === "boolean") return params.debug;
  return cfg.debug;
}

/** Сирий текст моделі буває довгим; в історії й діагностиці тримаємо початок. */
const MAX_RAW_CHARS = 8000;
function clampRaw(raw) {
  const text = String(raw ?? "");
  if (text.length <= MAX_RAW_CHARS) return text;
  return `${text.slice(0, MAX_RAW_CHARS)}\n…(сиру відповідь обрізано на ${MAX_RAW_CHARS} символах)`;
}

/**
 * Блок діагностики для вікна підказки: усе сире, до розбору.
 *
 * Поля навмисно ПЛОСКІ й названі так, як їх шукає `src/walkthrough/diagnostics.js`
 * (`stateSource`, `raw`, `prompt`, `model`, `imagePath`, `imageBytes`, `sentWidth`,
 * `sentHeight`, `durationMs`, `dropped`): вікно підказки читає їх за списком
 * синонімів, і сходження назв позбавляє його здогадів.
 *
 * Тут є те, чого немає у звичайній відповіді: надісланий промпт, сирий текст
 * моделі ДО розбору, шлях і розмір кадру, спосіб визначення стану і нотатки
 * санітарії — що саме відкинули й чому.
 */
function buildDebug({
  stateSource,
  visionCalls,
  allowedStates = [],
  match = null,
  appRunning = null,
  promptPair = null,
  answer = null,
  image = null,
  fields,
  model = null,
  startedAt,
  progress = null,
  repeated = null,
  sessionVisionCalls = null,
}) {
  // Порожні поля з блока прибираємо: коли стан визначила ОС, кадру й промпта
  // просто не існує, і два десятки null-ів лише заважають читати сире.
  return dropEmpty({
    // Головне питання режиму розробника: стан визначила ОС чи зір.
    stateSource,
    visionCalls,
    // Скільки викликів зору коштувала сесія ЦІЛКОМ. У ручному режимі це нуль —
    // саме те число, заради якого запасний шлях і існує.
    sessionVisionCalls,
    // Відповідь на пряме питання про попередній крок і лічильник повторів:
    // з них видно, чому сесія зсунулась уперед або чому стала.
    progress,
    repeated,
    allowedStates,
    model,
    durationMs: Date.now() - startedAt,
    ollamaMs: answer ? answer.ollamaMs : 0,
    system: promptPair ? promptPair.system : null,
    prompt: promptPair ? promptPair.prompt : null,
    raw: answer ? clampRaw(answer.raw) : null,
    modelFailure: answer ? answer.failure : null,
    screenSummary: fields.screenSummary ?? null,
    imagePath: image ? image.path : null,
    imageBytes: image ? image.bytes : null,
    sentWidth: image ? image.width : null,
    sentHeight: image ? image.height : null,
    originalPath: image ? image.originalPath : null,
    originalWidth: image ? image.originalWidth : null,
    originalHeight: image ? image.originalHeight : null,
    originalBytes: image ? image.originalBytes : null,
    resized: image ? image.resized : null,
    // Санітарія: що саме відкинули й чому (рамку, стан, формат).
    dropped: fields.notes || [],
    frontmost: match
      ? {
          provided: match.provided,
          matched: match.matched,
          by: match.by,
          name: match.name,
          bundleId: match.bundleId,
          learnedAlias: match.learnedAlias,
          appRunning,
          reason: match.reason,
        }
      : null,
  });
}

/** Прибирає з блока діагностики порожні поля (null/undefined і порожні масиви). */
function dropEmpty(block) {
  return Object.fromEntries(
    Object.entries(block).filter(
      ([, value]) =>
        value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  );
}

/**
 * Складає план кроків звичайною чат-моделлю (режим `plan`).
 * Робиться ОДИН раз на сесію, у walkthrough.start.
 */
async function buildPlan({ appName, goal, docsText, maxSteps, signal, onProgress }) {
  const { system, prompt } = buildPlanPrompt(appName, goal, docsText, maxSteps);
  onProgress(`Готуємо план кроків моделлю ${config.ollama.chatModel}...`);

  const response = await ollama.generateStructuredResponse({
    prompt,
    system,
    format: PLAN_SCHEMA,
    signal,
    timeoutMs: settings().visionTimeoutMs,
  });

  const parsed = parseModelJson(response?.response);
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  return steps
    .map((step) => ({
      instruction: String(step?.instruction || "").trim(),
      expect: String(step?.expect || "").trim(),
    }))
    .filter((step) => step.instruction)
    .slice(0, maxSteps);
}

/**
 * `walkthrough.start` — створює сесію і готує документацію.
 * @param {{appId: string, goal: string, docId?: number}} params
 * @param {{signal: AbortSignal, onProgress: Function}} ctx
 */
export async function start(params = {}, ctx = {}) {
  const onProgress = ctx.onProgress || (() => {});
  const cfg = settings();

  if (!cfg.enabled) {
    throw new Error("Модуль walkthrough вимкнено в конфізі (walkthrough.enabled = false).");
  }
  if (!STEP_SOURCES.includes(cfg.stepSource)) {
    throw new Error(
      `Невідомий walkthrough.stepSource «${cfg.stepSource}». Дозволені: ${STEP_SOURCES.join(", ")}.`,
    );
  }
  if (cfg.stepSource === "vision" && !cfg.enableScreenAnalysis) {
    throw new Error(
      "Режим stepSource=vision потребує walkthrough.enableScreenAnalysis = true: без аналізу знімка кроків узяти нізвідки.",
    );
  }

  const goal = String(params.goal || "").trim();
  if (!goal) throw new Error("Не вказано параметр `goal` — мету користувача.");

  const app = await findApp(params.appId);
  if (!app) {
    throw new Error(
      `Програми «${params.appId}» немає в базі. Перевірте appId (це bundleId з таблиці apps).`,
    );
  }

  // Знімки попередньої сесії не мають пережити початок нової: це екран
  // користувача (правило 1 контракту модуля).
  const purged = await purgeScreenshotsDir();

  onProgress(`Готуємо документацію програми «${app.name}»...`);
  const docs = await loadAppDocs({ app, goal, docId: params.docId ?? null });

  let plan = [];
  if (cfg.stepSource === "plan") {
    plan = await buildPlan({
      appName: app.name,
      goal,
      docsText: docs.text,
      maxSteps: cfg.maxSteps,
      signal: ctx.signal,
      onProgress,
    });
    if (plan.length === 0) {
      throw new Error(
        `Не вдалося скласти план кроків для «${app.name}» із документації (модель ${config.ollama.chatModel} не повернула жодного кроку).`,
      );
    }
  }

  const session = createSession({
    appId: app.id,
    appName: app.name,
    appPath: app.path,
    goal,
    docId: params.docId ?? null,
    docsText: docs.text,
    docs: docs.docs,
    docsSource: docs.source,
    stepSource: cfg.stepSource,
    plan,
  });

  logger.event(
    "info",
    "walkthrough.start",
    {
      sessionId: session.sessionId,
      appId: app.id,
      stepSource: cfg.stepSource,
      docs: docs.docs.length,
      docsSource: docs.source,
      plannedSteps: plan.length,
      purgedScreenshots: purged,
    },
    `Сесію walkthrough відкрито для «${app.name}»`,
  );

  return {
    sessionId: session.sessionId,
    appName: app.name,
    // Контракт: у режимі vision плану немає — масив порожній, і totalSteps
    // у кроках буде null.
    planned: plan.map((step) => step.instruction),
    // Довідкові поля (за межами обов'язкових): звідки взято документацію.
    stepSource: cfg.stepSource,
    docs: docs.docs,
    docsSource: docs.source,
    screenshotDir: screenshotsDir(),
  };
}

/**
 * Спільна частина `step` і `stuck`: перевірка сесії, підготовка кадру.
 * @returns {{session, image}|{session, blocked}} blocked — готова відповідь.
 */
async function prepareTurn(params, ctx, kind) {
  const session = getSession(params.sessionId);
  const screenshotPath = String(params.screenshotPath || "").trim();

  if (!screenshotPath || !(await screenshotExists(screenshotPath))) {
    // Знімка немає — найчастіше це не наданий дозвіл на запис екрана.
    // Контракт прямо каже: відмова macOS — стан, а не помилка.
    return {
      session,
      blocked: {
        state: "unclear",
        instruction:
          "Немає знімка екрана. Якщо система не дала дозволу, відкрийте «Системні параметри» → «Конфіденційність і безпека» → «Запис екрана» і дозвольте його цій програмі.",
        target: null,
        notes: [`знімка «${screenshotPath || "(порожній шлях)"}» не існує або він порожній`],
      },
    };
  }

  trackFile(session, screenshotPath);
  // Ім'я зменшеної копії містить номер кроку: інакше кадри сесії затирали б
  // один одного, і в теці лишався б слід лише останнього.
  const image = await prepareScreenshot(screenshotPath, {
    sessionId: session.sessionId,
    step: `${kind}${session.stepIndex}`,
  });
  trackFile(session, image.temporaryFile);

  (ctx.onProgress || (() => {}))(
    `Знімок ${image.originalWidth}×${image.originalHeight} зменшено до ${image.width}×${image.height} ` +
      `(${Math.round(image.originalBytes / 1024)} → ${Math.round(image.bytes / 1024)} КБ).`,
  );

  return { session, image };
}

/**
 * Збирає відповідь рівно тієї форми, що описана в контракті.
 *
 * Поля контракту (`stepIndex`, `totalSteps`, `instruction`, `target`, `state`,
 * `source`, `elapsedMs`) лишились як були — жодного не перейменовано. Нижче
 * лише ДОПОВНЕННЯ, кожне з яких оверлей має право не знати:
 *   `stepSource` — режим сесії зараз (vision | plan); змінюється на льоту;
 *   `planIndex`  — позиція в списку кроків довідки, null у режимі зору;
 *   `expect`     — що має бути видно на екрані (є лише в ручному режимі);
 *   `progress`   — відповідь на пряме питання про ПОПЕРЕДНІЙ крок;
 *   `repeated`   — вкотре поспіль модель дає ту саму інструкцію (1 = вперше).
 *
 * `debug` — необов'язковий блок: коли режим вимкнено, ключа в відповіді немає.
 */
function buildStepResponse(
  session,
  fields,
  { source, startedAt, debug = null, progress = null, expect = null, planIndex = null, repeated = null },
) {
  const response = {
    stepIndex: session.stepIndex,
    totalSteps: session.stepSource === "plan" ? session.plan.length : null,
    instruction: fields.instruction,
    target: fields.target,
    state: fields.state,
    source,
    elapsedMs: Date.now() - startedAt,
    stepSource: session.stepSource,
    planIndex: session.stepSource === "plan" ? planIndex : null,
  };
  if (expect) response.expect = expect;
  if (progress) response.progress = progress;
  if (Number.isFinite(repeated)) response.repeated = repeated;
  if (debug) response.debug = debug;
  return response;
}

/**
 * Остання ЗМІСТОВНА інструкція сесії — та, про яку має сенс питати «чи виконано».
 *
 * Кроки, які виставила ОС із `frontmost` («перейдіть у вікно програми»),
 * навмисно пропускаємо: до моменту виклику зору вікно вже точно те, і питати
 * про них немає про що. Питати треба про останню дію В САМІЙ програмі.
 */
function lastMeaningfulInstruction(session) {
  for (let i = session.history.length - 1; i >= 0; i -= 1) {
    const entry = session.history[i];
    if (entry.kind !== "step" && entry.kind !== "stuck") continue;
    if (entry.decidedBy === "frontmost") continue;
    const text = String(entry.instruction || "").trim();
    if (text) return text;
  }
  return null;
}

/**
 * «Я це зробив» від людини. Її слово остаточне: крок іде в список підтверджених
 * (звідти він потрапляє в промпт як заборона повторювати), а лічильник повторів
 * скидається — після втручання людини попередній глухий кут більше не рахується.
 */
function confirmPreviousStep(session) {
  const last = lastMeaningfulInstruction(session);
  if (last && !session.confirmedSteps.includes(last)) session.confirmedSteps.push(last);
  session.lastInstruction = null;
  session.repeatCount = 0;
  return last;
}

/**
 * Просування і захист від зациклення — одним місцем, бо це одне рішення.
 *
 * 1. Просування спирається на пряму відповідь моделі про ПОПЕРЕДНІЙ крок
 *    (`previousDone`). «Не виконано» зупиняє лічильник; «невідомо» (модель
 *    мовчить або зір не вдався) не зупиняє — інакше збій Ollama вішав би сесію.
 * 2. Слово користувача важливіше за будь-яку відповідь моделі.
 * 3. Та сама інструкція вдруге поспіль (або та, яку користувач уже підтвердив
 *    як виконану) — це не крок, а глухий кут.
 */
function applyProgressGuard(session, fields, { previousInstruction, userConfirmed }) {
  const norm = normalizeInstruction(fields.instruction);
  const sameAsLast = Boolean(norm) && norm === session.lastInstruction;
  const alreadyConfirmed =
    Boolean(norm) && session.confirmedSteps.some((text) => normalizeInstruction(text) === norm);

  session.repeatCount = sameAsLast ? session.repeatCount + 1 : 0;
  session.lastInstruction = norm || null;

  const done = userConfirmed ? true : (fields.previousDone ?? null);
  const progress = {
    previousInstruction: previousInstruction || null,
    done,
    by: userConfirmed ? "user" : done === null ? "none" : "vision",
    note: userConfirmed
      ? "користувач сказав, що вже виконав цей крок"
      : fields.previousEvidence || null,
  };

  return {
    progress,
    // «Не виконано» від моделі зупиняє лічильник; людина його перебиває.
    advance: userConfirmed || done !== false,
    looping: !userConfirmed && (sameAsLast || alreadyConfirmed),
    loopReason: sameAsLast
      ? "та сама інструкція вдруге поспіль"
      : "модель повторює крок, який користувач уже підтвердив як виконаний",
    repeated: session.repeatCount + 1,
  };
}

/**
 * Записує крок в історію і зсуває лічильник, якщо крок був корисним.
 * В історії тримаємо і сиру відповідь моделі: саме її просить режим розробника,
 * і саме по ній видно, чи модель узагалі відповідала на цьому кроці.
 */
function commitStep(
  session,
  fields,
  {
    advance = true,
    kind = "step",
    source = null,
    decidedBy = null,
    raw = null,
    elapsedMs = null,
  } = {},
) {
  session.history.push({
    stepIndex: session.stepIndex,
    kind,
    instruction: fields.instruction,
    state: fields.state,
    source,
    decidedBy,
    target: fields.target,
    screenSummary: fields.screenSummary ?? null,
    notes: fields.notes || [],
    raw: raw === null ? null : clampRaw(raw),
    elapsedMs,
    at: Date.now(),
  });
  if (advance && !STATES_WITHOUT_PROGRESS.includes(fields.state)) {
    session.stepIndex += 1;
  }
}

/**
 * Перемикання режиму ПОСЕРЕД сесії — головний запасний шлях автора.
 *
 * Зір застряг → людина натискає «ручний режим» у вікні підказки, і сесія
 * триває далі списком кроків із довідки. Пройдене не втрачається: `stepIndex`,
 * `history` і `confirmedSteps` лишаються як були, обнуляється лише курсор
 * плану — список довідки завжди читається з першого пункту, бо вгадувати,
 * якому його пункту відповідав п'ятий крок зору, нема з чого.
 *
 * План будується тут же, якщо сесія почалась у режимі зору і плану ще немає.
 * Це ОДИН виклик звичайної чат-моделі без зображення — не зір.
 *
 * @returns {Promise<{switched: boolean, notes: string[]}>}
 */
async function switchStepSource(session, next, ctx) {
  const onProgress = ctx.onProgress || (() => {});
  if (!STEP_SOURCES.includes(next)) {
    throw new Error(
      `Невідомий stepSource «${next}». Дозволені: ${STEP_SOURCES.join(", ")}.`,
    );
  }
  if (next === session.stepSource) return { switched: false, notes: [] };

  const notes = [];
  if (next === "plan" && session.plan.length === 0) {
    const plan = await buildPlan({
      appName: session.appName,
      goal: session.goal,
      docsText: session.docsText,
      maxSteps: settings().maxSteps,
      signal: ctx.signal,
      onProgress,
    });
    if (plan.length === 0) {
      throw new Error(
        `Не вдалося скласти план кроків для «${session.appName}» із документації: модель ${config.ollama.chatModel} не повернула жодного кроку. Ручний режим без списку кроків не має сенсу.`,
      );
    }
    session.plan = plan;
    notes.push(`план на ${plan.length} кроків складено при перемиканні`);
  }

  const from = session.stepSource;
  session.stepSource = next;
  session.planCursor = 0;
  // Лічильник повторів належав попередньому режиму — у новому він порожній.
  session.lastInstruction = null;
  session.repeatCount = 0;
  notes.push(`режим кроків змінено: ${from} → ${next}`);

  session.history.push({
    stepIndex: session.stepIndex,
    kind: "mode",
    instruction: `Режим кроків змінено: ${from} → ${next}.`,
    state: "ready",
    source: next,
    decidedBy: "user",
    target: null,
    screenSummary: null,
    notes,
    raw: null,
    elapsedMs: 0,
    at: Date.now(),
  });

  logger.event(
    "info",
    "walkthrough.mode",
    { sessionId: session.sessionId, from, to: next, stepIndex: session.stepIndex, plan: session.plan.length },
    `Режим кроків сесії змінено: ${from} → ${next}`,
  );
  return { switched: true, notes };
}

/**
 * Крок РУЧНОГО режиму: пункт списку, складеного з довідки, і нічого більше.
 *
 * Зору тут немає взагалі — ні кадру, ні зменшення, ні виклику моделі. Тому
 * крок коштує ~1 мс і не може «не спрацювати»: саме цим цей шлях і цінний.
 * Просування підтверджує сам користувач натисканням «далі» — питати про це
 * модель, яка на екран не дивиться, було б здогадом.
 */
function manualStep(session, { startedAt, wantDebug, switchNotes = [] }) {
  const cursor = session.planCursor;
  const previous = cursor > 0 ? session.plan[cursor - 1] : null;
  const planStep = cursor < session.plan.length ? session.plan[cursor] : null;

  const fields = planStep
    ? {
        state: "ready",
        instruction: planStep.instruction,
        target: null,
        notes: [...switchNotes, "ручний режим: зір не викликався"],
      }
    : {
        state: "done",
        instruction:
          "Це були всі кроки з довідки. Перевірте результат і завершіть підказку.",
        target: null,
        notes: [...switchNotes, "ручний режим: список кроків вичерпано"],
      };

  const progress = {
    previousInstruction: previous ? previous.instruction : null,
    done: previous ? true : null,
    by: previous ? "user" : "none",
    note: previous
      ? "у ручному режимі просування підтверджує сам користувач, а не модель"
      : null,
  };

  const response = buildStepResponse(session, fields, {
    source: "plan",
    startedAt,
    progress,
    expect: planStep ? planStep.expect || null : null,
    planIndex: Math.min(cursor, session.plan.length),
    repeated: 1,
    debug: wantDebug
      ? buildDebug({
          stateSource: "plan",
          visionCalls: 0,
          sessionVisionCalls: session.visionCalls,
          progress,
          repeated: 1,
          fields,
          startedAt,
        })
      : null,
  });

  if (planStep) session.planCursor += 1;
  commitStep(session, fields, {
    source: "plan",
    decidedBy: "plan",
    elapsedMs: response.elapsedMs,
  });

  logger.event(
    "info",
    "walkthrough.step",
    {
      sessionId: session.sessionId,
      stepIndex: response.stepIndex,
      state: response.state,
      source: "plan",
      visionCalls: 0,
      planIndex: response.planIndex,
      totalSteps: response.totalSteps,
      sessionVisionCalls: session.visionCalls,
    },
    `Крок ${response.stepIndex} (ручний режим, пункт ${response.planIndex + 1} з ${session.plan.length}, без зору)`,
  );

  return response;
}

/**
 * `walkthrough.step` — наступний крок за поточним знімком.
 *
 * Порядок рішень навмисно такий: спершу те, що ОС знає точно, і лише потім
 * зір. `frontmost` (`{name, bundleId}` від `frontmost_app()`) дозволяє
 * виставити `wrong_window`/`app_not_started` БЕЗ жодного звернення до моделі:
 * підказка «перейдіть у вікно Фотографій» не потребує аналізу зображення.
 * Коли ж ОС підтвердила потрібне вікно, задача зору звужується — він більше
 * не вирішує «чи та це програма» (див. prompts.js, пункт 3).
 *
 * @param {{sessionId: string, screenshotPath?: string,
 *          frontmost?: {name?: string, bundleId?: string, isSelf?: boolean},
 *          appRunning?: boolean, debug?: boolean,
 *          stepSource?: "vision"|"plan", userConfirmed?: boolean}} params
 *   `stepSource` — перемикання режиму просто в цьому виклику (вікно підказки
 *   має перемикач, і посеред сесії він не має коштувати окремого методу).
 *   `userConfirmed` — «я це зробив»: слово людини про попередній крок.
 *   `screenshotPath` обов'язковий лише для зору; ручний режим кадру не просить.
 * @param {{signal: AbortSignal, onProgress: Function}} ctx
 */
export async function step(params = {}, ctx = {}) {
  const startedAt = Date.now();
  const cfg = settings();
  const wantDebug = debugEnabled(params, cfg);
  const onProgress = ctx.onProgress || (() => {});

  // Ліміт кроків на сесію перевіряємо ДО роботи з кадром: інакше ми дарма
  // зменшували б знімок і лишали в теці тимчасовий файл заради відмови.
  const known = getSession(params.sessionId);

  // Перемикач режиму з вікна підказки. Робиться ПЕРШИМ: далі вся гілка коду
  // залежить від того, який режим у сесії зараз.
  let switchNotes = [];
  if (params.stepSource) {
    const result = await switchStepSource(known, String(params.stepSource).trim(), ctx);
    switchNotes = result.notes;
  }

  // «Я це зробив» — слово людини про ПОПЕРЕДНІЙ крок. Читаємо його до всього
  // іншого: воно скидає лічильник повторів і поповнює список підтверджених.
  const userConfirmed = params.userConfirmed === true;

  if (known.stepIndex >= cfg.maxSteps) {
    const fields = {
      state: "unclear",
      instruction: `Досягнуто ліміт кроків на сесію (${cfg.maxSteps}). Завершіть підказку і почніть заново з уточненою метою.`,
      target: null,
      notes: ["ліміт maxStepsPerSession"],
    };
    return buildStepResponse(known, fields, {
      source: known.stepSource,
      startedAt,
      debug: wantDebug
        ? buildDebug({ stateSource: "fallback", visionCalls: 0, fields, startedAt })
        : null,
    });
  }

  // Ручний режим — найкоротший шлях у файлі, і це навмисно: ні кадру, ні
  // frontmost, ні моделі. Гілка стоїть ПЕРЕД усім, що може не спрацювати,
  // саме тому, що вона мусить працювати завжди.
  if (known.stepSource === "plan" && !cfg.planVerify) {
    if (userConfirmed) confirmPreviousStep(known);
    return manualStep(known, { startedAt, wantDebug, switchNotes });
  }

  if (userConfirmed) confirmPreviousStep(known);

  // Яка програма попереду — питання до ОС, а не до зору (docs/contracts/walkthrough.md).
  const match = matchFrontmost(known, params.frontmost);
  const appRunning =
    typeof params.appRunning === "boolean"
      ? params.appRunning
      : typeof params.frontmost?.running === "boolean"
        ? params.frontmost.running
        : null;
  const decided = decideFromFrontmost({
    session: known,
    match,
    appRunning,
    isSelf: params.frontmost?.isSelf === true,
  });

  if (decided) {
    // Стан відомий достеменно — зору тут немає що робити, і кадр можна навіть
    // не зменшувати. Але сам знімок від Rust усе одно належить сесії й мусить
    // зникнути разом із нею: це екран користувача.
    const rawShot = String(params.screenshotPath || "").trim();
    if (rawShot) trackFile(known, rawShot);
    onProgress(
      `Попереду не «${known.appName}» (${match.reason}) — стан визначено без звернення до моделі.`,
    );
    // Гак у бік («перейдіть у вікно програми») не робить із наступної інструкції
    // повтор: людина ще не мала змоги виконати ту, що була до гака.
    known.lastInstruction = null;
    known.repeatCount = 0;

    const response = buildStepResponse(known, decided, {
      source: "frontmost",
      startedAt,
      debug: wantDebug
        ? buildDebug({
            stateSource: "frontmost",
            visionCalls: 0,
            match,
            appRunning,
            fields: decided,
            startedAt,
          })
        : null,
    });
    commitStep(known, decided, {
      source: "frontmost",
      decidedBy: "frontmost",
      elapsedMs: response.elapsedMs,
    });

    logger.event(
      "info",
      "walkthrough.step",
      {
        sessionId: known.sessionId,
        stepIndex: response.stepIndex,
        state: response.state,
        source: "frontmost",
        visionCalls: 0,
        frontmost: { name: match.name, bundleId: match.bundleId, by: match.by },
        notes: decided.notes,
        elapsedMs: response.elapsedMs,
      },
      `Крок ${response.stepIndex} (${response.state}, визначено з frontmost, без зору)`,
    );

    return response;
  }

  const { session, image, blocked } = await prepareTurn(params, ctx, "step");

  if (blocked) {
    const response = buildStepResponse(session, blocked, {
      source: session.stepSource,
      startedAt,
      debug: wantDebug
        ? buildDebug({
            stateSource: "fallback",
            visionCalls: 0,
            match,
            appRunning,
            fields: blocked,
            startedAt,
          })
        : null,
    });
    commitStep(session, blocked, { advance: false, source: session.stepSource });
    return response;
  }

  const sent = { width: image.width, height: image.height };
  // ОС підтвердила потрібне вікно — забираємо з задачі зору те, що вже вирішено.
  const confirmedApp = match.matched === true ? session.appName : null;
  const allowedStates = confirmedApp ? CONFIRMED_STATES : STATES;
  let fields;
  let source;
  let promptPair = null;
  let answer = null;
  let guard = null;
  let previousInstruction = null;

  if (session.stepSource === "plan") {
    const planStep = session.plan[Math.min(session.stepIndex, session.plan.length - 1)];

    if (!cfg.enableScreenAnalysis) {
      // Аналіз екрана вимкнено — план веде наосліп, і це чесно видно в логах.
      fields = {
        state: "ready",
        instruction: planStep.instruction,
        target: null,
        notes: ["зір вимкнено (enableScreenAnalysis=false)"],
      };
      source = "plan";
    } else {
      promptPair = buildVerifyPrompt(session, sent, planStep, { confirmedApp });
      answer = await askVision({
        prompt: promptPair.prompt,
        system: promptPair.system,
        schema: visionVerifySchema(allowedStates),
        image,
        signal: ctx.signal,
        onProgress,
      });
      const checked = toStepFields(answer.parsed, {
        sent,
        failure: answer.failure,
        allowedStates,
      });

      if (checked.state === "ready" || checked.state === "done") {
        // Екран той — інструкцію дає план.
        fields = { ...checked, instruction: planStep.instruction };
        source = "plan";
      } else {
        // Екран не той — веде стан, а не план: інакше ми відправили б людину
        // до кнопки у вікні, якого зараз немає.
        fields = checked;
        source = "vision";
      }
    }
  } else {
    // Пряме питання про попередній крок ставиться лише тоді, коли той крок є:
    // на першому кроці питати нема про що, і зайве поле в схемі лише плутало б.
    previousInstruction = lastMeaningfulInstruction(session);
    promptPair = buildVisionStepPrompt(session, sent, { confirmedApp, previousInstruction });
    answer = await askVision({
      prompt: promptPair.prompt,
      system: promptPair.system,
      schema: visionStepSchema(allowedStates, { askPrevious: Boolean(previousInstruction) }),
      image,
      signal: ctx.signal,
      onProgress,
    });
    fields = toStepFields(answer.parsed, { sent, failure: answer.failure, allowedStates });
    source = "vision";

    // Просування і глухий кут — одне рішення, ухвалене з відповіді про
    // попередній крок, а не з припущення, що новий кадр означає новий крок.
    guard = applyProgressGuard(session, fields, { previousInstruction, userConfirmed });

    if (guard.looping && fields.state === "ready") {
      // Третій однаковий повтор нічого не додасть. Кажемо про це прямо і
      // лишаємо людині два виходи: підтвердити крок або перейти в ручний режим.
      fields = {
        ...fields,
        state: LOOP_STATE,
        target: null,
        notes: [...(fields.notes || []), guard.loopReason],
      };
    }
  }

  const visionCalls = answer ? 1 : 0;
  session.visionCalls += visionCalls;
  const response = buildStepResponse(session, fields, {
    source,
    startedAt,
    progress: guard ? guard.progress : null,
    repeated: guard ? guard.repeated : null,
    planIndex: null,
    debug: wantDebug
      ? buildDebug({
          stateSource: source === "plan" && !answer ? "fallback" : source,
          visionCalls,
          allowedStates,
          match,
          appRunning,
          promptPair,
          answer,
          image,
          fields,
          model: answer ? config.ollama.visionModel : null,
          startedAt,
          progress: guard ? guard.progress : null,
          repeated: guard ? guard.repeated : null,
          sessionVisionCalls: session.visionCalls,
        })
      : null,
  });
  commitStep(session, fields, {
    advance: guard ? guard.advance : true,
    source,
    decidedBy: visionCalls ? "vision" : source,
    raw: answer ? answer.raw : null,
    elapsedMs: response.elapsedMs,
  });

  logger.event(
    "info",
    "walkthrough.step",
    {
      sessionId: session.sessionId,
      stepIndex: response.stepIndex,
      state: response.state,
      source,
      visionCalls,
      confirmedApp: Boolean(confirmedApp),
      hasTarget: Boolean(response.target),
      previousDone: guard ? guard.progress.done : null,
      advanced: guard ? guard.advance : true,
      repeated: guard ? guard.repeated : 1,
      sessionVisionCalls: session.visionCalls,
      sent,
      original: { width: image.originalWidth, height: image.originalHeight },
      notes: fields.notes,
      elapsedMs: response.elapsedMs,
    },
    `Крок ${response.stepIndex} (${response.state}, ${source})`,
  );

  return response;
}

/**
 * `walkthrough.stuck` — користувач не знайшов елемент. Повторний аналіз того
 * самого екрана ІНШИМ промптом: перелічити видимі елементи і або уточнити
 * орієнтири, або чесно визнати, що елемента немає, і запропонувати обхідний шлях.
 * Лічильник кроків не зсувається: крок той самий, підказка інша.
 *
 * `frontmost` тут теж приймається, але лише щоб звузити промпт: людина просить
 * подивитись на екран ще раз, тож зір викликаємо в будь-якому разі.
 */
export async function stuck(params = {}, ctx = {}) {
  const startedAt = Date.now();
  const cfg = settings();
  const wantDebug = debugEnabled(params, cfg);
  const { session, image, blocked } = await prepareTurn(params, ctx, "stuck");

  if (blocked) {
    return buildStepResponse(session, blocked, {
      source: session.stepSource,
      startedAt,
      debug: wantDebug
        ? buildDebug({ stateSource: "fallback", visionCalls: 0, fields: blocked, startedAt })
        : null,
    });
  }
  if (!cfg.enableScreenAnalysis) {
    throw new Error(
      "walkthrough.stuck потребує walkthrough.enableScreenAnalysis = true: повторна підказка будується саме зі знімка.",
    );
  }

  const match = matchFrontmost(session, params.frontmost);
  const confirmedApp = match.matched === true ? session.appName : null;
  const allowedStates = confirmedApp ? CONFIRMED_STATES : STATES;
  const sent = { width: image.width, height: image.height };
  const promptPair = buildStuckPrompt(session, sent, { confirmedApp });
  const answer = await askVision({
    prompt: promptPair.prompt,
    system: promptPair.system,
    schema: visionStepSchema(allowedStates),
    image,
    signal: ctx.signal,
    onProgress: ctx.onProgress || (() => {}),
  });

  const fields = toStepFields(answer.parsed, { sent, failure: answer.failure, allowedStates });
  session.visionCalls += 1;
  const response = buildStepResponse(session, fields, {
    source: "vision",
    startedAt,
    debug: wantDebug
      ? buildDebug({
          stateSource: "vision",
          visionCalls: 1,
          sessionVisionCalls: session.visionCalls,
          allowedStates,
          match,
          promptPair,
          answer,
          image,
          fields,
          model: config.ollama.visionModel,
          startedAt,
        })
      : null,
  });
  commitStep(session, fields, {
    advance: false,
    kind: "stuck",
    source: "vision",
    decidedBy: "vision",
    raw: answer.raw,
    elapsedMs: response.elapsedMs,
  });

  logger.event(
    "info",
    "walkthrough.stuck",
    {
      sessionId: session.sessionId,
      stepIndex: response.stepIndex,
      state: response.state,
      hasTarget: Boolean(response.target),
      confirmedApp: Boolean(confirmedApp),
      notes: fields.notes,
    },
    `Повторний аналіз кроку ${response.stepIndex} (${response.state})`,
  );

  return response;
}

/**
 * `walkthrough.history` — уся сесія одним викликом: кожен крок з інструкцією,
 * станом, способом визначення стану і СИРОЮ відповіддю моделі до розбору.
 *
 * Це другий бік режиму розробника: блок `debug` показує поточний крок, а цей
 * метод — весь прогін, зокрема кроки, на яких моделі не питали взагалі
 * (`decidedBy: "frontmost"`, `raw: null`). Саме по ньому видно, скільки
 * викликів зору сесія зекономила.
 */
export function history(params = {}) {
  const session = getSession(params.sessionId);
  const steps = session.history.map((entry, index) => ({ index, ...entry }));

  return {
    sessionId: session.sessionId,
    appId: session.appId,
    appName: session.appName,
    goal: session.goal,
    stepSource: session.stepSource,
    stepIndex: session.stepIndex,
    // Позиція в списку кроків довідки і сам список: у ручному режимі саме вони
    // описують, де людина зараз.
    planCursor: session.planCursor,
    plan: session.plan.map((entry) => entry.instruction),
    // Кроки, про які людина сказала «я це зробив». Її слово в сесії остаточне.
    confirmedSteps: [...session.confirmedSteps],
    // Назви, під якими ми впізнаємо цю програму (локалізовані — вивчені на льоту).
    appAliases: [...(session.appAliases || [])],
    createdAt: session.createdAt,
    durationMs: Date.now() - session.createdAt,
    totalSteps: steps.length,
    // Лічильник викликів зору за сесію. Веде його сам модуль у місці виклику,
    // а не рахує заднім числом з історії: саме це число доводить, що ручний
    // режим проходить сесію з нулем звернень до vision-моделі.
    visionCalls: session.visionCalls,
    deterministicSteps: steps.filter((entry) => entry.decidedBy === "frontmost").length,
    manualSteps: steps.filter((entry) => entry.decidedBy === "plan").length,
    steps,
  };
}

/**
 * `walkthrough.finish` — закриває сесію і прибирає знімки.
 * Знімок не має лишатися на диску довше за сесію: це екран користувача.
 */
export async function finish(params = {}) {
  const session = getSession(params.sessionId);
  const { removedFiles } = await dropSession(session);
  const purged = await purgeScreenshotsDir();

  logger.event(
    "info",
    "walkthrough.finish",
    {
      sessionId: session.sessionId,
      steps: session.stepIndex,
      removedFiles,
      purgedScreenshots: purged,
      durationMs: Date.now() - session.createdAt,
    },
    `Сесію walkthrough закрито (${session.stepIndex} кроків)`,
  );

  return {
    finished: true,
    sessionId: session.sessionId,
    steps: session.stepIndex,
    removedFiles,
    purgedScreenshots: purged,
    durationMs: Date.now() - session.createdAt,
    screenshotDir: screenshotsDir(),
  };
}

export { activeSessions };
