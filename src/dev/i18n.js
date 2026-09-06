import i18n from "../i18n";

/** Переклад текстів панелі без прокидання `t` крізь утиліти й конфігурації графіків. */
export const dt = (key, options) => i18n.t(`dev.${key}`, options);
