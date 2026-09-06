/**
 * Файл: src/modules/rag/prompts.js
 * Опис: Зберігає шаблони промптів для LLM. Винесення промптів у окремий файл
 *       є найкращою практикою (Best Practice) для чистішої архітектури.
 *
 * Тут же живе ВІСЬ СИСТЕМНОГО ПРОМПТА (`systemPromptMode`). Раніше системний
 * текст був захардкоджений в ollama.service.js і надсилався завжди, тож осі
 * `xml`/`reorder` змагалися з інструкцією, яка вже все за них сказала
 * («output STRICTLY valid JSON», «base your decision EXCLUSIVELY on the Context»).
 * Тепер текст лежить в одному місці, а спосіб його доставки — параметр:
 *
 *   system — текст іде в поле `system` запиту до Ollama (поточна поведінка);
 *   inline — той самий текст стає початком основного промпта, поле `system`
 *            не надсилається взагалі (перевіряємо, чи важливий КАНАЛ);
 *   none   — системного тексту немає ніде (перевіряємо, чи важливий САМ ТЕКСТ).
 */

import { outputLanguageInstruction } from "../../i18n/language.js";

/** Дозволені значення осі системного промпта. */
export const SYSTEM_PROMPT_MODES = ["system", "inline", "none"];

/**
 * Системний текст класифікатора. Дослівно той, що був захардкоджений
 * у `ollama.service.js`; винесений сюди, щоб режим `inline` міг покласти
 * його в основний промпт, а режим `none` — не використати ніде.
 */
export const CLASSIFIER_SYSTEM_PROMPT =
  "You are a highly analytical classification engine. Your task is to output STRICTLY valid JSON based on the schema provided. Base your decision EXCLUSIVELY on the Context provided. Do not invent any information.";

/**
 * Формує основний промпт і (за потреби) системне повідомлення.
 *
 * @param {string} contextText - Готовий текст контексту (DOCUMENT 1..N).
 * @param {string} queryText - Запит користувача.
 * @param {boolean} enableXmlTags - Вісь `xml`: структурувати промпт XML-тегами.
 * @param {boolean} enableJsonFormat - Вимагати від моделі строгий JSON.
 * @param {string} systemPromptMode - Вісь `systemPrompt`: "system" | "inline" | "none".
 * @returns {{prompt: string, systemPrompt: string|null}}
 *          `systemPrompt` не null ЛИШЕ для режиму "system"; в інших випадках
 *          поле `system` до Ollama не надсилається.
 */
export function generatePrompt(
  contextText,
  queryText,
  enableXmlTags,
  enableJsonFormat = false,
  systemPromptMode = "system",
  language = null,
) {
  // Значення поза списком — помилка виклику, а не тихий фолбек: друкарська
  // помилка в конфізі не має мовчки повертати прогін до старої поведінки.
  if (!SYSTEM_PROMPT_MODES.includes(systemPromptMode)) {
    throw new Error(
      `Невідомий systemPromptMode «${systemPromptMode}». Дозволені: ${SYSTEM_PROMPT_MODES.join(", ")}.`,
    );
  }

  const systemRole =
    "You are an intelligent macOS assistant. Your task is to recommend a locally installed app to the user based on their query.";

  const languageRule = outputLanguageInstruction(language);
  const rulesJson = `1. If the User Query is pure gibberish, output {"isMatch": false, "reason": "INVALID_QUERY", "sourceId": null}.
2. If no app in the Context can genuinely perform the task (e.g. unrelated, like asking to remove virus but no antivirus in context), output {"isMatch": false, "reason": "No suitable app found in context.", "sourceId": null}.
3. STRICT GROUNDING: Base your reasoning EXCLUSIVELY on the Context text.
4. ANALOGS & ALTERNATIVES: If the user asks for a specific third-party app (like Word, Excel, Photoshop) and it is not present, you MUST recommend an Apple alternative ONLY IF the provided Context explicitly mentions compatibility (e.g. "imports Word/Excel documents") or features that match the user's implicit intent.
5. If an app IS a valid match, output {"isMatch": true, "reason": "<your reasoning>", "sourceId": X} where X is the EXACT number of the DOCUMENT you used.
${languageRule ? `6. OUTPUT LANGUAGE: ${languageRule}` : ""}

OUTPUT FORMAT INSTRUCTION:
You MUST respond with a single, raw JSON object. Do not include any markdown formatting (\`\`\`json), do not include XML tags in your response, and do not include any conversational text.
Your response must strictly follow this JSON schema:
{
  "isMatch": boolean,
  "reason": "string",
  "sourceId": number or null
}`;

  const rulesText = `1. GIBBERISH/TYPOS: If the User Query is pure gibberish keyboard smashing (e.g., "asdfasdf", "фівфівіа", "еуіе") or random letters without meaning, you MUST reply EXACTLY with "INVALID_QUERY" and nothing else.
2. SMALL TALK/UNRELATED: If the user query is conversational (e.g. "how are you", "hello", "як справи") or if no app in the Context can genuinely perform the requested task, you MUST reply EXACTLY with "NOT_FOUND" and nothing else.
3. DO NOT invent or stretch connections. If the user asks "how to build a physical boat" and the context only has drawing apps, reply "NOT_FOUND".
4. ANALOGS & ALTERNATIVES: If the user asks for a specific third-party app and it is not present, you can recommend an alternative ONLY IF the provided Context explicitly describes features that match the user's intent.
5. STRICT GROUNDING: You MUST base your reasoning EXCLUSIVELY on the provided Context text. Do not use outside knowledge. Do not hallucinate features (e.g. do not say an app supports layers if the Context doesn't say so). If the Context text does not support the match, reply "NOT_FOUND".
6. If an app IS a valid match based on the text, explain why using facts from the text. YOU MUST end your response with the exact tag [SOURCE_ID: X], where X is the EXACT number of the DOCUMENT you used. For example, if you recommend the app from DOCUMENT 3, you MUST output [SOURCE_ID: 3]. Do not hallucinate the ID!
${languageRule ? `7. OUTPUT LANGUAGE: ${languageRule}` : ""}`;

  const rules = enableJsonFormat ? rulesJson : rulesText;

  let body;
  if (enableXmlTags) {
    // Структурування за допомогою XML-тегів (допомагає моделям краще розмежовувати дані)
    body = `${systemRole}

<context>
${contextText}
</context>

<rules>
${rules}
</rules>

<user_query>
${queryText}
</user_query>`;
  } else {
    // Звичайне текстове структурування (з правилами в кінці для Recency Bias)
    body = `${systemRole}

Context (Local Apps and their capabilities):
${contextText}

CRITICAL INSTRUCTIONS TO FOLLOW STRICTLY:
${rules}

User Query: ${queryText}
`;
  }

  // Системний текст існує лише в JSON-режимі — рівно як було в
  // ollama.service.js до появи осі. У текстовому режимі всі три значення
  // осі збігаються, і це чесно видно зі звіту.
  const systemText = enableJsonFormat ? CLASSIFIER_SYSTEM_PROMPT : null;

  if (systemPromptMode === "inline" && systemText) {
    // Той самий текст, той самий порядок (Ollama теж кладе system зверху),
    // але вже всередині основного промпта.
    return { prompt: `${systemText}\n\n${body}`, systemPrompt: null };
  }

  if (systemPromptMode === "none") {
    return { prompt: body, systemPrompt: null };
  }

  return { prompt: body, systemPrompt: systemText };
}
