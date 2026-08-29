/**
 * Поле `state` з відповіді `walkthrough.step` (docs/contracts/walkthrough.md).
 *
 * Контракт каже прямо: state важливіший за instruction. Тому не «крок і крапка»,
 * а п'ять різних виглядів вікна — з різним заголовком, тоном і головною дією.
 * Модель, яка помилилась вікном, не має вести людину до кнопки, якої там немає.
 */

/** Дії, які вміє виконати панель. Символічні назви, щоб опис лишався даними. */
export const ACTION = {
  NEXT: "next", // зробити новий знімок і попросити наступний крок
  RECHECK: "recheck", // те саме, але змістом «я виправив стан, подивись ще раз»
  LAUNCH: "launch", // запустити програму (launch_app), потім перевірити
  RETRY: "retry", // повторити аналіз того самого екрана
  FINISH: "finish", // закрити сесію
};

const DESCRIPTORS = {
  ready: {
    key: "ready",
    tone: "go",
    title: "", // заголовка немає навмисно: героєм картки є сама інструкція
    hint: "",
    primary: { action: ACTION.NEXT, label: "Далі" },
    showStuck: true,
    showInstruction: true,
  },
  wrong_window: {
    key: "wrong_window",
    tone: "warn",
    title: "Спершу відкрийте потрібне вікно",
    hint: "Поки попереду інша програма, вести нікуди: кнопок із підказки на екрані немає.",
    primary: { action: ACTION.RECHECK, label: "Я перейшов — перевірити" },
    showStuck: false,
    showInstruction: true,
  },
  app_not_started: {
    key: "app_not_started",
    tone: "warn",
    title: "Програму ще не запущено",
    hint: "Запустимо її — і продовжимо з першого кроку.",
    primary: { action: ACTION.LAUNCH, label: "Запустити програму" },
    showStuck: false,
    showInstruction: true,
  },
  done: {
    key: "done",
    tone: "done",
    title: "Готово",
    hint: "Мету досягнуто. Вікно підказки можна закрити.",
    primary: { action: ACTION.FINISH, label: "Завершити" },
    showStuck: false,
    showInstruction: true,
  },
  unclear: {
    key: "unclear",
    tone: "unsure",
    title: "Не розібрав, що зараз на екрані",
    hint: "Буває на нестандартних вікнах. Можна подивитись ще раз або сказати, що кнопки не видно.",
    primary: { action: ACTION.RETRY, label: "Подивитись ще раз" },
    showStuck: true,
    showInstruction: true,
  },
};

/**
 * Опис вигляду для значення `state`. Невідоме значення — це не привід
 * показати порожнечу: поводимось як з «unclear», але чесно кажемо, що прийшло.
 */
export function describeState(state) {
  const key = typeof state === "string" ? state.trim() : "";
  if (DESCRIPTORS[key]) return DESCRIPTORS[key];
  return {
    ...DESCRIPTORS.unclear,
    key: "unknown",
    title: "Незнайомий стан підказки",
    hint: key
      ? `Бекенд повернув state «${key}», якого немає в контракті. Показуємо інструкцію як є.`
      : "Бекенд не повернув поле state. Показуємо інструкцію як є.",
  };
}

export const KNOWN_STATES = Object.keys(DESCRIPTORS);
