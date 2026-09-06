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
    primary: { action: ACTION.NEXT, labelKey: "walkthrough.next" },
    showStuck: true,
    showConfirm: true,
    showInstruction: true,
  },
  wrong_window: {
    key: "wrong_window",
    tone: "warn",
    titleKey: "walkthrough.stateWrongTitle",
    hintKey: "walkthrough.stateWrongHint",
    primary: { action: ACTION.RECHECK, labelKey: "walkthrough.recheck" },
    showStuck: false,
    showConfirm: false,
    showInstruction: true,
  },
  app_not_started: {
    key: "app_not_started",
    tone: "warn",
    titleKey: "walkthrough.stateStoppedTitle",
    hintKey: "walkthrough.stateStoppedHint",
    primary: { action: ACTION.LAUNCH, labelKey: "walkthrough.launch" },
    showStuck: false,
    showConfirm: false,
    showInstruction: true,
  },
  done: {
    key: "done",
    tone: "done",
    titleKey: "walkthrough.stateDoneTitle",
    hintKey: "walkthrough.stateDoneHint",
    primary: { action: ACTION.FINISH, labelKey: "walkthrough.finish" },
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
    titleKey: "walkthrough.stateLoopTitle",
    hintKey: "walkthrough.stateLoopHint",
    primary: { action: ACTION.MANUAL, labelKey: "walkthrough.manual" },
    showStuck: false,
    showConfirm: true,
    showInstruction: true,
  },
  unclear: {
    key: "unclear",
    tone: "unsure",
    titleKey: "walkthrough.stateUnclearTitle",
    hintKey: "walkthrough.stateUnclearHint",
    primary: { action: ACTION.RETRY, labelKey: "walkthrough.retryLook" },
    showStuck: true,
    showConfirm: true,
    showInstruction: true,
  },
};

/**
 * Опис вигляду для значення `state`. Невідоме значення — це не привід
 * показати порожнечу: поводимось як з «unclear», але чесно кажемо, що прийшло.
 */
export function describeState(state, t) {
  const key = typeof state === "string" ? state.trim() : "";
  const source = DESCRIPTORS[key] || {
    ...DESCRIPTORS.unclear,
    key: "unknown",
    titleKey: "walkthrough.stateUnknownTitle",
    hintKey: "walkthrough.stateUnknownHint",
  };
  return {
    ...source,
    title: source.titleKey ? t(source.titleKey) : source.title || "",
    hint: source.hintKey ? t(source.hintKey) : source.hint || "",
    primary: { ...source.primary, label: t(source.primary.labelKey) },
  };
}

export const KNOWN_STATES = Object.keys(DESCRIPTORS);
