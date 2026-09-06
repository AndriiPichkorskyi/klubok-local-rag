/**
 * План комбінованого прогону «пайплайн + тести».
 *
 * Нового методу на бекенді немає і не буде: прогін — це послідовні виклики
 * наявних `pipeline.*` і `tests.*` (docs/contracts/rpc.md). Тут лише чиста
 * логіка — з набору прапорців будується список кроків, який далі виконує
 * useFullRun.js. Жодних викликів rpc у цьому файлі.
 */

/** Кроки пайплайна в тому ж порядку, що й у CLI та в pipeline.fullSync. */
export const PIPELINE_STEPS = [
  { id: "scan", method: "pipeline.scanApps", labelKey: "fullRun.steps.scan" },
  { id: "web", method: "pipeline.fetchDocs", labelKey: "fullRun.steps.web" },
  { id: "local", method: "pipeline.fetchLocalDocs", labelKey: "fullRun.steps.local" },
  {
    id: "keywords",
    method: "pipeline.keywordAugmentation",
    labelKey: "fullRun.steps.keywords",
  },
  { id: "vectors", method: "pipeline.vectorize", labelKey: "fullRun.steps.vectors" },
  {
    id: "intentVectors",
    method: "pipeline.vectorizeIntents",
    labelKey: "fullRun.steps.intentVectors",
  },
];

/**
 * Тести виконуються після пайплайна. За замовчуванням вимкнені.
 * `kind` — вид бенчмарку в `tests.plan`: за ним крок бере свою ціну прогону
 * (скільки режимів і скільки це триватиме) і своє попередження про maxModes.
 */
export const TEST_STEPS = [
  { id: "ragTests", method: "tests.run", labelKey: "fullRun.steps.rag", kind: "rag" },
  {
    id: "externalTests",
    method: "tests.runExternal",
    labelKey: "fullRun.steps.external",
    kind: "external",
  },
];

/** Прапорці за замовчуванням: усі кроки пайплайна, жодного тесту. */
export function defaultSelection() {
  const steps = {};
  for (const step of PIPELINE_STEPS) steps[step.id] = true;
  const tests = {};
  for (const step of TEST_STEPS) tests[step.id] = false;
  return { steps, tests };
}

/**
 * Кроки векторизації. Тут єдине місце, де план відхиляється від «один прапорець —
 * один виклик», і на те є причина з бекенда: `pipeline.vectorize` ігнорує params
 * і завжди бере `config.embedModelName` (EMBED_MODEL читається один раз при старті
 * процесу — docs/improvements.md). Чужу модель уміє лише `pipeline.fullSync({models})`,
 * який запускає окремий процес на кожну модель. Тому:
 *   - модель з конфіга  → pipeline.vectorize;
 *   - решта моделей     → один pipeline.fullSync({models: [...інші]}).
 * Про те, що fullSync повторює кроки 1–4 всередині себе, крок чесно попереджає —
 * мовчазна підміна ховала б годину зайвої роботи.
 */
function vectorSteps(models, configModel) {
  const chosen = Array.isArray(models) ? models.filter(Boolean) : [];
  if (chosen.length === 0) {
    return [
      {
        key: "full:vectors",
        method: "pipeline.vectorize",
        params: {},
        label: configModel
          ? dt("fullRun.vectorsConfig", { model: configModel })
          : dt("fullRun.vectorsDefault"),
      },
    ];
  }

  const steps = [];
  if (configModel && chosen.includes(configModel)) {
    steps.push({
      key: "full:vectors",
      method: "pipeline.vectorize",
      params: {},
      label: `${dt("fullRun.steps.vectors")} · ${configModel}`,
    });
  }

  const foreign = chosen.filter((model) => model !== configModel);
  if (foreign.length > 0) {
    steps.push({
      key: "full:vectors-foreign",
      method: "pipeline.fullSync",
      params: { models: foreign },
      label: `${dt("fullRun.steps.vectors")} · ${foreign.join(", ")}`,
      warn: dt("fullRun.foreignWarning"),
    });
  }
  return steps;
}

/**
 * Побудова плану. `selection` = {steps:{id:bool}, tests:{id:bool}}.
 * `testParams` — параметри кроків тестування (осі бенчмарку з інтерфейсу);
 * порожньо = бекенд бере матрицю з конфіга, як і було до появи форми осей.
 * Повертає масив {key, method, params, label, warn} у порядку виконання.
 */
export function buildPlan(
  selection,
  models,
  configModel,
  testParams = null,
  chatModels = [],
  configChatModel = null,
) {
  const steps = selection?.steps || {};
  const tests = selection?.tests || {};
  const plan = [];

  for (const step of PIPELINE_STEPS) {
    if (!steps[step.id]) continue;
    if (step.id === "vectors") {
      plan.push(...vectorSteps(models, configModel));
      continue;
    }
    plan.push({
      key: `full:${step.id}`,
      method: step.method,
      params: {},
      label: dt(step.labelKey),
    });
  }

  for (const step of TEST_STEPS) {
    if (!tests[step.id]) continue;

    // Якщо вибрані моделі для тестів, створюємо крок для кожної пари.
    // null означає «не перевизначати»: фактичне значення візьме sidecar із конфіга.
    const chosenChat =
      Array.isArray(chatModels) && chatModels.length > 0
        ? chatModels
        : [configChatModel || null];
    const chosenEmbed =
      Array.isArray(models) && models.length > 0
        ? models
        : [configModel || null];

    for (const embed of chosenEmbed) {
      for (const chat of chosenChat) {
        const params = { ...testParams };
        if (chat) params.overrideChatModel = chat;
        if (embed) params.overrideEmbedModel = embed;
        const modelLabel = [embed, chat].filter(Boolean).join(" · ");
        const stepLabel = dt(step.labelKey);
        const label = modelLabel ? `${stepLabel} · ${modelLabel}` : stepLabel;
        plan.push({
          key: `full:${step.id}:${embed || "config"}:${chat || "config"}`,
          method: step.method,
          params,
          label,
        });
      }
    }
  }
  return plan;
}

/**
 * Опис результату кроку. Повертає масив рядків.
 */
export function describeStepResult(method, result) {
  if (!result || typeof result !== "object") return [String(result)];
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const lines = [];

  switch (method) {
    case "pipeline.scanApps":
      if (num(result.newApps) !== undefined)
        lines.push(dt("fullRun.results.new", { count: result.newApps }));
      break;
    case "pipeline.fetchDocs":
    case "pipeline.fetchLocalDocs":
      if (num(result.docsCount) !== undefined)
        lines.push(dt("fullRun.results.documents", { count: result.docsCount }));
      if (result.mbDownloaded) lines.push(`${result.mbDownloaded} MB`);
      break;
    case "pipeline.keywordAugmentation":
      if (num(result.generated) !== undefined)
        lines.push(dt("fullRun.results.generated", { count: result.generated }));
      break;
    case "pipeline.vectorize":
    case "pipeline.vectorizeIntents":
      if (num(result.chunks) !== undefined)
        lines.push(dt("fullRun.results.chunks", { count: result.chunks }));
      break;
    case "pipeline.fullSync":
      if (result.stoppedAt)
        lines.push(dt("fullRun.results.stoppedAt", { step: result.stoppedAt }));
      if (num(result.newApps) !== undefined)
        lines.push(dt("fullRun.results.newApps", { count: result.newApps }));
      if (num(result.docsCount) !== undefined)
        lines.push(dt("fullRun.results.documents", { count: result.docsCount }));
      if (num(result.generated) !== undefined)
        lines.push(dt("fullRun.results.intents", { count: result.generated }));
      if (result.perModel && typeof result.perModel === "object") {
        for (const [model, value] of Object.entries(result.perModel)) {
          const text =
            value === "done"
              ? dt("fullRun.results.separateDone")
              : value === "cancelled"
                ? dt("fullRun.results.notVectorized")
                : dt("fullRun.results.chunks", { count: value });
          lines.push(`• ${model}: ${text}`);
        }
      }
      break;
    case "tests.run":
    case "tests.runExternal": {
      const passed = num(result.passed);
      const total = num(result.totalCases);
      if (passed !== undefined && total !== undefined)
        lines.push(dt("tests.passed", { passed, total }));
      if (num(result.failed) !== undefined)
        lines.push(dt("tests.failed", { count: result.failed }));
      if (num(result.passRate) !== undefined) lines.push(`${result.passRate}%`);
      if (result.reportPath) lines.push(dt("fullRun.results.report", { path: result.reportPath }));
      break;
    }
    default:
      break;
  }

  if (lines.length === 0) {
    const plain = Object.entries(result)
      .filter(([, value]) => value === null || typeof value !== "object")
      .map(([key, value]) => `${key}=${value}`);
    return plain.length > 0 ? plain : [dt("common.ready")];
  }
  return lines;
}

/** Чи провалив крок тести (для підсвітки підсумку). */
export function testsFailed(method, result) {
  if (method !== "tests.run" && method !== "tests.runExternal") return false;
  if (typeof result === "boolean") return result === false;
  if (result && typeof result === "object") {
    if (typeof result.ok === "boolean") return !result.ok;
    if (typeof result.failed === "number") return result.failed > 0;
  }
  return false;
}
import { dt } from "./i18n";
