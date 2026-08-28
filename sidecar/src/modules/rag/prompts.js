/**
 * Файл: src/modules/rag/prompts.js
 * Опис: Зберігає шаблони промптів для LLM. Винесення промптів у окремий файл
 *       є найкращою практикою (Best Practice) для чистішої архітектури.
 */

export function generatePrompt(contextText, queryText, enableXmlTags, enableJsonFormat = false) {
  const systemRole =
    "You are an intelligent macOS assistant. Your task is to recommend a locally installed app to the user based on their query.";

  const rulesJson = `1. If the User Query is pure gibberish, output {"isMatch": false, "reason": "INVALID_QUERY", "sourceId": null}.
2. If no app in the Context can genuinely perform the task (e.g. unrelated, like asking to remove virus but no antivirus in context), output {"isMatch": false, "reason": "No suitable app found in context.", "sourceId": null}.
3. STRICT GROUNDING: Base your reasoning EXCLUSIVELY on the Context text.
4. ANALOGS & ALTERNATIVES: If the user asks for a specific third-party app (like Word, Excel, Photoshop) and it is not present, you MUST recommend an Apple alternative ONLY IF the provided Context explicitly mentions compatibility (e.g. "imports Word/Excel documents") or features that match the user's implicit intent.
5. If an app IS a valid match, output {"isMatch": true, "reason": "<your reasoning>", "sourceId": X} where X is the EXACT number of the DOCUMENT you used.

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
6. If an app IS a valid match based on the text, explain why using facts from the text. YOU MUST end your response with the exact tag [SOURCE_ID: X], where X is the EXACT number of the DOCUMENT you used. For example, if you recommend the app from DOCUMENT 3, you MUST output [SOURCE_ID: 3]. Do not hallucinate the ID!`;

  const rules = enableJsonFormat ? rulesJson : rulesText;

  if (enableXmlTags) {
    // Структурування за допомогою XML-тегів (допомагає моделям краще розмежовувати дані)
    return `${systemRole}

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
    return `${systemRole}

Context (Local Apps and their capabilities):
${contextText}

CRITICAL INSTRUCTIONS TO FOLLOW STRICTLY:
${rules}

User Query: ${queryText}
`;
  }
}
