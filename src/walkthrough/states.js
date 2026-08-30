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
  CONFIRM: "confirm", // «я це зробив»: слово людини рухає сесію попри модель
  MANUAL: "manual", // перейти на список кроків із довідки (ручний режим)
};

const DESCRIPTORS = {
  ready: {
    key: "ready",
    tone: "go",
    title: "", // заголовка немає навмисно: героєм картки є сама інструкція
    hint: "",
    primary: { action: ACTION.NEXT, label: "Далі" },
    showStuck: true,
    showConfirm: true,
    showInstruction: true,
  },
  wrong_window: {
    key: "wrong_window",
    tone: "warn",
    title: "Спершу відкрийте потрібне вікно",
    hint: "Поки попереду інша програма, вести нікуди: кнопок із підказки на екрані немає.",
    primary: { action: ACTION.RECHECK, label: "Я перейшов — перевірити" },
    showStuck: false,
    showConfirm: false,
    showInstruction: true,
  },
  app_not_started: {
    key: "app_not_started",
    tone: "warn",
    title: "Програму ще не запущено",
    hint: "Запустимо її — і продовжимо з першого кроку.",
    primary: { action: ACTION.LAUNCH, label: "Запустити програму" },
    showStuck: false,
    showConfirm: false,
    showInstruction: true,
  },
  done: {
    key: "done",
    tone: "done",
    title: "Готово",
    hint: "Мету досягнуто. Вікно підказки можна закрити.",
    primary: { action: ACTION.FINISH, label: "Завершити" },
    showStuck: false,
    showConfirm: false,
    showInstruction: true,
  },
  /**
   * Стан, який виставляє сам бекенд: та сама інструкція вдруге поспіль.
   * Третій повтор нічого не додасть, тому головна дія тут — не «далі», а вихід
   * на шлях, який працює завжди: список кроків із довідки.
   */
  loop: {
    key: "loop",
    tone: "warn",
    title: "Підказка пішла по колу",
    hint:
      "Модель другий раз поспіль пропонує те саме — далі вона це лише повторюватиме. " +
      "Надійніше пройти решту кроків за довідкою самому; якщо крок уже зроблено, скажіть про це прямо.",
    primary: { action: ACTION.MANUAL, label: "Перейти до списку кроків" },
    showStuck: false,
    showConfirm: true,
    showInstruction: true,
  },
  unclear: {
    key: "unclear",
    tone: "unsure",
    title: "Не розібрав, що зараз на екрані",
    hint: "Буває на нестандартних вікнах. Можна подивитись ще раз або сказати, що кнопки не видно.",
    primary: { action: ACTION.RETRY, label: "Подивитись ще раз" },
    showStuck: true,
    showConfirm: true,
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
