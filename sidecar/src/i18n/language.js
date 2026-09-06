/** Підтримувані мови користувацьких відповідей. */
export const RESPONSE_LANGUAGES = ["uk", "en"];

/** Нормалізація на межі RPC; невідоме значення не маскуємо фолбеком. */
export function normalizeResponseLanguage(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const language = String(value).trim().toLowerCase();
  if (!RESPONSE_LANGUAGES.includes(language)) {
    throw new Error(
      `Невідома мова відповіді «${value}». Дозволені: ${RESPONSE_LANGUAGES.join(", ")}.`,
    );
  }
  return language;
}

export function outputLanguageInstruction(language) {
  if (language === "uk") return "Write all user-facing explanatory text in Ukrainian.";
  if (language === "en") return "Write all user-facing explanatory text in English.";
  return "";
}

export function localized(language, texts) {
  return language === "en" ? texts.en : texts.uk;
}
