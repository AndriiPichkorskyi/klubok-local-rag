/**
 * Файл: src/modules/walkthrough/index.js
 * Опис: Модуль 2.5 (серверна частина): аналіз знімка екрана і формування
 *       наступного кроку. Контракт — docs/contracts/walkthrough.md.
 *
 * Два режими, обидва робочі, перемикач `config.walkthrough.stepSource`:
 *
 *   vision — модель дивиться на кадр і сама вирішує, який крок наступний,
 *            спираючись на документацію. Основний шлях роботи.
 *   plan   — кроки один раз готує звичайна чат-модель із документації, а зір
 *            лише звіряє, чи екран той. Запасний шлях: якщо зір підводить,
 *            демонстрація все одно проходить.
 *
 * Форма відповіді `step` однакова в обох режимах — її задає контракт, і
 * оверлей не має знати, звідки саме взявся крок (крім поля `source`).
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
  PLAN_SCHEMA,
  VISION_STEP_SCHEMA,
  VISION_VERIFY_SCHEMA,
  buildPlanPrompt,
  buildStuckPrompt,
  buildVerifyPrompt,
  buildVisionStepPrompt,
} from "./prompts.js";
import { activeSessions, createSession, dropSession, getSession, trackFile } from "./session.js";
import { askVision, parseModelJson, toStepFields } from "./vision.js";

/** Дозволені джерела кроку. Невідоме значення — помилка, а не тихий фолбек. */
export const STEP_SOURCES = ["vision", "plan"];

/** Стани, після яких лічильник кроків не зсувається: корисного кроку не було. */
const STATES_WITHOUT_PROGRESS = ["unclear"];

/** Читає налаштування модуля з конфіга (їх можна перечитати через config.reload). */
function settings() {
  const w = config.walkthrough || {};
  return {
    enabled: w.enabled !== false,
    enableScreenAnalysis: w.enableScreenAnalysis !== false,
    stepSource: w.stepSource || "vision",
    maxSteps: Number(w.maxStepsPerSession) || 12,
    maxImageWidth: Number(w.maxImageWidth) || 1280,
    visionTimeoutMs: (Number(w.visionTimeoutSec) || 120) * 1000,
  };
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

/** Збирає відповідь рівно тієї форми, що описана в контракті. */
function buildStepResponse(session, fields, { source, startedAt }) {
  return {
    stepIndex: session.stepIndex,
    totalSteps: session.stepSource === "plan" ? session.plan.length : null,
    instruction: fields.instruction,
    target: fields.target,
    state: fields.state,
    source,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Записує крок в історію і зсуває лічильник, якщо крок був корисним. */
function commitStep(session, fields, { advance = true } = {}) {
  session.history.push({
    stepIndex: session.stepIndex,
    instruction: fields.instruction,
    state: fields.state,
    at: Date.now(),
  });
  if (advance && !STATES_WITHOUT_PROGRESS.includes(fields.state)) {
    session.stepIndex += 1;
  }
}

/**
 * `walkthrough.step` — наступний крок за поточним знімком.
 * @param {{sessionId: string, screenshotPath: string}} params
 * @param {{signal: AbortSignal, onProgress: Function}} ctx
 */
export async function step(params = {}, ctx = {}) {
  const startedAt = Date.now();
  const cfg = settings();

  // Ліміт кроків на сесію перевіряємо ДО роботи з кадром: інакше ми дарма
  // зменшували б знімок і лишали в теці тимчасовий файл заради відмови.
  const known = getSession(params.sessionId);
  if (known.stepIndex >= cfg.maxSteps) {
    const fields = {
      state: "unclear",
      instruction: `Досягнуто ліміт кроків на сесію (${cfg.maxSteps}). Завершіть підказку і почніть заново з уточненою метою.`,
      target: null,
      notes: ["ліміт maxStepsPerSession"],
    };
    return buildStepResponse(known, fields, { source: known.stepSource, startedAt });
  }

  const { session, image, blocked } = await prepareTurn(params, ctx, "step");

  if (blocked) {
    const response = buildStepResponse(session, blocked, { source: session.stepSource, startedAt });
    commitStep(session, blocked, { advance: false });
    return response;
  }

  const sent = { width: image.width, height: image.height };
  let fields;
  let source;

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
      const { system, prompt } = buildVerifyPrompt(session, sent, planStep);
      const answer = await askVision({
        prompt,
        system,
        schema: VISION_VERIFY_SCHEMA,
        image,
        signal: ctx.signal,
        onProgress: ctx.onProgress || (() => {}),
      });
      const checked = toStepFields(answer.parsed, { sent, failure: answer.failure });

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
    const { system, prompt } = buildVisionStepPrompt(session, sent);
    const answer = await askVision({
      prompt,
      system,
      schema: VISION_STEP_SCHEMA,
      image,
      signal: ctx.signal,
      onProgress: ctx.onProgress || (() => {}),
    });
    fields = toStepFields(answer.parsed, { sent, failure: answer.failure });
    source = "vision";
  }

  const response = buildStepResponse(session, fields, { source, startedAt });
  commitStep(session, fields);

  logger.event(
    "info",
    "walkthrough.step",
    {
      sessionId: session.sessionId,
      stepIndex: response.stepIndex,
      state: response.state,
      source,
      hasTarget: Boolean(response.target),
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
 */
export async function stuck(params = {}, ctx = {}) {
  const startedAt = Date.now();
  const cfg = settings();
  const { session, image, blocked } = await prepareTurn(params, ctx, "stuck");

  if (blocked) {
    return buildStepResponse(session, blocked, { source: session.stepSource, startedAt });
  }
  if (!cfg.enableScreenAnalysis) {
    throw new Error(
      "walkthrough.stuck потребує walkthrough.enableScreenAnalysis = true: повторна підказка будується саме зі знімка.",
    );
  }

  const sent = { width: image.width, height: image.height };
  const { system, prompt } = buildStuckPrompt(session, sent);
  const answer = await askVision({
    prompt,
    system,
    schema: VISION_STEP_SCHEMA,
    image,
    signal: ctx.signal,
    onProgress: ctx.onProgress || (() => {}),
  });

  const fields = toStepFields(answer.parsed, { sent, failure: answer.failure });
  const response = buildStepResponse(session, fields, { source: "vision", startedAt });
  commitStep(session, fields, { advance: false });

  logger.event(
    "info",
    "walkthrough.stuck",
    {
      sessionId: session.sessionId,
      stepIndex: response.stepIndex,
      state: response.state,
      hasTarget: Boolean(response.target),
      notes: fields.notes,
    },
    `Повторний аналіз кроку ${response.stepIndex} (${response.state})`,
  );

  return response;
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
