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
  { id: "scan", method: "pipeline.scanApps", label: "Сканування програм" },
  { id: "web", method: "pipeline.fetchDocs", label: "Веб-довідка" },
  { id: "local", method: "pipeline.fetchLocalDocs", label: "Локальна довідка" },
  { id: "keywords", method: "pipeline.keywordAugmentation", label: "Наміри (keywords)" },
  { id: "vectors", method: "pipeline.vectorize", label: "Вектори" },
  { id: "intentVectors", method: "pipeline.vectorizeIntents", label: "Вектори намірів" },
];

/**
 * Тести виконуються після пайплайна. За замовчуванням вимкнені.
 * `kind` — вид бенчмарку в `tests.plan`: за ним крок бере свою ціну прогону
 * (скільки режимів і скільки це триватиме) і своє попередження про maxModes.
 */
export const TEST_STEPS = [
  { id: "ragTests", method: "tests.run", label: "RAG-бенчмарк", kind: "rag" },
  { id: "externalTests", method: "tests.runExternal", label: "EXTERNAL-тести", kind: "external" },
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
        label: configModel ? `Вектори · ${configModel} (з конфіга)` : "Вектори · модель з конфіга",
      },
    ];
  }

  const steps = [];
  if (configModel && chosen.includes(configModel)) {
    steps.push({
      key: "full:vectors",
      method: "pipeline.vectorize",
      params: {},
      label: `Вектори · ${configModel}`,
    });
  }

  const foreign = chosen.filter((model) => model !== configModel);
  if (foreign.length > 0) {
    steps.push({
      key: "full:vectors-foreign",
      method: "pipeline.fullSync",
      params: { models: foreign },
      label: `Вектори · ${foreign.join(", ")}`,
      warn:
        "pipeline.vectorize вміє лише модель із конфіга, тому для цих моделей " +
        "викликається pipeline.fullSync({models}) — він повторює кроки 1–4 всередині себе.",
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
    plan.push({ key: `full:${step.id}`, method: step.method, params: {}, label: step.label });
  }

  for (const step of TEST_STEPS) {
    if (!tests[step.id]) continue;
    
    // Якщо вибрані моделі для тестів, створюємо крок для кожної пари.
    // null означає «не перевизначати»: фактичне значення візьме sidecar із конфіга.
    const chosenChat = Array.isArray(chatModels) && chatModels.length > 0
      ? chatModels
      : [configChatModel || null];
    const chosenEmbed = Array.isArray(models) && models.length > 0
      ? models
      : [configModel || null];

    for (const embed of chosenEmbed) {
      for (const chat of chosenChat) {
        const params = { ...testParams };
        if (chat) params.overrideChatModel = chat;
        if (embed) params.overrideEmbedModel = embed;
        const modelLabel = [embed, chat].filter(Boolean).join(" · ");
        const label = modelLabel ? `${step.label} · ${modelLabel}` : step.label;
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
      if (num(result.newApps) !== undefined) lines.push(`нових: ${result.newApps}`);
      break;
    case "pipeline.fetchDocs":
    case "pipeline.fetchLocalDocs":
      if (num(result.docsCount) !== undefined) lines.push(`документів: ${result.docsCount}`);
      if (result.mbDownloaded) lines.push(`${result.mbDownloaded} МБ`);
      break;
    case "pipeline.keywordAugmentation":
      if (num(result.generated) !== undefined) lines.push(`згенеровано: ${result.generated}`);
      break;
    case "pipeline.vectorize":
    case "pipeline.vectorizeIntents":
      if (num(result.chunks) !== undefined) lines.push(`чанків: ${result.chunks}`);
      break;
    case "pipeline.fullSync":
      if (result.stoppedAt) lines.push(`спинився на кроці: ${result.stoppedAt}`);
      if (num(result.newApps) !== undefined) lines.push(`нових програм: ${result.newApps}`);
      if (num(result.docsCount) !== undefined) lines.push(`документів: ${result.docsCount}`);
      if (num(result.generated) !== undefined) lines.push(`намірів: ${result.generated}`);
      if (result.perModel && typeof result.perModel === "object") {
        for (const [model, value] of Object.entries(result.perModel)) {
          const text =
            value === "done"
              ? "виконано окремим процесом"
              : value === "cancelled"
                ? "зупинено — модель НЕ векторизовано"
                : `${value} чанків`;
          lines.push(`• ${model}: ${text}`);
        }
      }
      break;
    case "tests.run":
    case "tests.runExternal": {
      const passed = num(result.passed);
      const total = num(result.totalCases);
      if (passed !== undefined && total !== undefined) lines.push(`пройдено ${passed} з ${total}`);
      if (num(result.failed) !== undefined) lines.push(`провалено ${result.failed}`);
      if (num(result.passRate) !== undefined) lines.push(`${result.passRate}%`);
      if (result.reportPath) lines.push(`звіт: ${result.reportPath}`);
      break;
    }
    default:
      break;
  }

  if (lines.length === 0) {
    const plain = Object.entries(result)
      .filter(([, value]) => value === null || typeof value !== "object")
      .map(([key, value]) => `${key}=${value}`);
    return plain.length > 0 ? plain : ["готово"];
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
