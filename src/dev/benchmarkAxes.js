/**
 * Осі бенчмарку в інтерфейсі: опис полів, розбір введеного і форматування.
 *
 * Тут ЛИШЕ чиста логіка, без React і без rpc. Головне правило цього файлу:
 * він не рахує матрицю сам. Скільки буде режимів, скільки кейсів і скільки це
 * триватиме — каже бекенд (`tests.plan`), бо саме він потім і прогонятиме.
 * Другий підрахунок у фронтенді неминуче розійшовся б із першим (кількість
 * зовнішніх кейсів узагалі залежить від вмісту бази).
 *
 * Конфіг лишається джерелом за замовчуванням: у стані живуть тільки ті осі,
 * які людина справді змінила, і тільки вони їдуть у `tests.run({axes})`.
 */

/**
 * Осі для найпершого малювання, поки `tests.plan` ще не відповів.
 * Джерело правди — `sidecar/src/tests/benchmark-matrix.js` (DEFAULT_AXES);
 * щойно приходить відповідь методу, показуємо його `configAxes`, а не це.
 */
export const FALLBACK_AXES = {
  search: ["hybrid"],
  xml: [false, true],
  reorder: [false, true],
  systemPrompt: ["system"],
  seed: [42],
  temperature: [0.1],
};

/** Значення осі seed, за яким кожен запит отримує нове випадкове зерно. */
export const RANDOM_SEED = "random";

/**
 * Поля форми. Порядок той самий, що й у звіті та в описі матриці, щоб
 * очі не шукали вісь у двох різних порядках.
 */
export const AXIS_FIELDS = [
  {
    id: "search",
    label: "Пошук",
    type: "choice",
    options: [
      { value: "vector", label: "vector" },
      { value: "fts", label: "fts" },
      { value: "hybrid", label: "hybrid" },
    ],
  },
  {
    id: "xml",
    label: "XML-теги",
    type: "choice",
    options: [
      { value: false, label: "без XML" },
      { value: true, label: "з XML" },
    ],
  },
  {
    id: "reorder",
    label: "Переставляння контексту",
    type: "choice",
    options: [
      { value: false, label: "як є" },
      { value: true, label: "переставляти" },
    ],
  },
  {
    id: "systemPrompt",
    label: "Системний промпт",
    type: "choice",
    options: [
      { value: "system", label: "system" },
      { value: "inline", label: "inline" },
      { value: "none", label: "none" },
    ],
  },
  {
    id: "temperature",
    label: "Температура",
    type: "list",
    placeholder: "0.1",
    hint: "числа 0…2 через кому",
  },
  {
    id: "seed",
    label: "Seed",
    type: "list",
    placeholder: "42",
    hint: `числа через кому · «${RANDOM_SEED}» — нове зерно на КОЖЕН запит · «none» — без seed`,
  },
];

/** Ідентифікатори осей у порядку показу. */
export const AXIS_IDS = AXIS_FIELDS.map((field) => field.id);

/** Людське написання одного значення осі (і для поля вводу, і для підпису). */
export function formatAxisValue(axisId, value) {
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Значення осі одним рядком — саме те, що стоїть у полі вводу. */
export function formatAxisValues(axisId, values) {
  if (!Array.isArray(values)) return "";
  return values.map((value) => formatAxisValue(axisId, value)).join(", ");
}

/**
 * Розбір рядка з поля вводу.
 * Порожній рядок — це помилка, а не «як у конфізі»: повернення до конфіга
 * робиться окремою кнопкою, інакше стерте поле мовчки міняло б експеримент.
 *
 * @returns {{values: Array|null, error: string|null}}
 */
export function parseAxisInput(axisId, text) {
  const parts = String(text ?? "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return { values: null, error: "порожньо — потрібне хоча б одне значення" };

  const values = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (axisId === "seed") {
      if (lower === RANDOM_SEED) {
        values.push(RANDOM_SEED);
        continue;
      }
      if (lower === "none" || lower === "null") {
        values.push(null);
        continue;
      }
      const num = Number(part);
      if (!Number.isFinite(num)) {
        return { values: null, error: `«${part}» — не число, не «${RANDOM_SEED}» і не «none»` };
      }
      values.push(num);
      continue;
    }

    const num = Number(part);
    if (!Number.isFinite(num)) return { values: null, error: `«${part}» — не число` };
    if (axisId === "temperature" && (num < 0 || num > 2)) {
      return { values: null, error: `${num} поза межами 0…2` };
    }
    values.push(num);
  }

  // Дублі — це два однакові режими з однією назвою: звіт мовчки втратив би один.
  const seen = new Set(values.map((value) => formatAxisValue(axisId, value)));
  if (seen.size !== values.length) return { values: null, error: "є повтори" };

  return { values, error: null };
}

/** Перемикання одного значення в осі-переліку. */
export function toggleAxisValue(values, value) {
  const list = Array.isArray(values) ? values : [];
  return list.includes(value) ? list.filter((item) => item !== value) : list.concat([value]);
}

/** Осі, з якими піде прогін: конфіг знизу, зміни людини зверху. */
export function effectiveAxes(configAxes, overrides) {
  return { ...(configAxes || {}), ...(overrides || {}) };
}

/** Тривалість для людини, яка планує ніч: «1 год 43 хв», «12 хв», «45 с». */
export function formatDurationLong(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))} с`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} хв`;
  return minutes === 0 ? `${hours} год` : `${hours} год ${minutes} хв`;
}

/** Українська множина для слова «режим»/«прогін». */
export function pluralize(count, one, few, many) {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return many;
  const last = count % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
