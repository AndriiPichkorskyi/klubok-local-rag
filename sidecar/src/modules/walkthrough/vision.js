/**
 * Файл: src/modules/walkthrough/vision.js
 * Опис: Виклик vision-моделі і перетворення її відповіді на крок контракту.
 *
 * Тут зібрано все, що стосується недовіри до моделі:
 *  - структурований вивід Ollama (JSON-схема) як основний механізм формату;
 *  - jsonrepair як запобіжник, коли модель усе одно віддала текст із рамкою
 *    ```json або обірваний JSON (власного парсера не пишемо);
 *  - будь-яке сміття перетворюється на state «unclear», а не на падіння;
 *  - вигаданий елемент відсікається геометрією (geometry.sanitizeBox) і
 *    правилом «state важливіший за instruction».
 */

import { jsonrepair } from "jsonrepair";

import { config } from "../../config/config.js";
import { ollama } from "../../services/ollama.service.js";
import { logger } from "../../services/logger.service.js";
import { sanitizeBox } from "./geometry.js";
import { STATES } from "./prompts.js";

/** Стани, у яких рамка на екрані не має сенсу навіть якщо модель її дала. */
const STATES_WITHOUT_TARGET = ["app_not_started", "wrong_window"];

/** Запасні інструкції на випадок, коли модель не дала жодного тексту. */
const FALLBACK_INSTRUCTION = {
  app_not_started: "Відкрийте потрібну програму — на знімку її вікна немає.",
  wrong_window: "Перейдіть у вікно потрібної програми — зараз попереду інше вікно.",
  done: "Схоже, мету вже досягнуто.",
  unclear: "Не вдалося розібрати, що зараз на екрані. Зробіть знімок ще раз.",
  ready: "Продовжуйте за довідкою програми.",
};

/**
 * Дістає об'єкт із того, що віддала модель.
 *
 * Порядок спроб: чистий JSON → jsonrepair (рамки ```json, кома в кінці,
 * обірваний рядок) → вирізка від першої «{» до останньої «}» і знову
 * jsonrepair (модель почала з пояснення прозою). Не вийшло — null,
 * і викликач перетворює це на стан «unclear».
 *
 * @param {string} raw
 * @returns {Object|null}
 */
export function parseModelJson(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const attempts = [
    () => JSON.parse(text),
    () => JSON.parse(jsonrepair(text)),
    () => {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("У відповіді немає об'єкта JSON.");
      return JSON.parse(jsonrepair(text.slice(start, end + 1)));
    },
  ];

  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Наступна спроба; остаточне «не вийшло» — це null нижче.
    }
  }
  return null;
}

/**
 * Один виклик зору. Довгий, тому скасовний: `signal` — це той самий
 * AbortSignal, що приходить у ctx кожного RPC-методу.
 *
 * @returns {{parsed: Object|null, raw: string, failure: string|null, ollamaMs: number}}
 */
export async function askVision({ prompt, system, schema, image, signal, onProgress = () => {} }) {
  const timeoutMs = (Number(config.walkthrough?.visionTimeoutSec) || 120) * 1000;
  const started = Date.now();

  onProgress(
    `Аналізуємо знімок моделлю ${config.ollama.visionModel} (${image.width}×${image.height}, ${Math.round(image.bytes / 1024)} КБ)...`,
  );

  try {
    const response = await ollama.generateVisionResponse({
      prompt,
      system,
      images: [image.base64],
      format: schema,
      signal,
      timeoutMs,
    });
    const raw = String(response?.response ?? "");
    return {
      parsed: parseModelJson(raw),
      raw,
      failure: null,
      ollamaMs: Date.now() - started,
    };
  } catch (error) {
    // Скасування — намір користувача, а не збій: прокидаємо його далі, щоб
    // RPC-сервер віддав штатний кадр «cancelled» (docs/contracts/rpc.md).
    if (signal?.aborted) throw error;

    // Решта — недоступна Ollama, таймаут, 500 від сервера. Для оверлея це
    // стан «не бачу», а не червона помилка: сесія лишається живою.
    const timedOut = error.code === "ECONNABORTED" || /timeout/i.test(error.message || "");
    const reason = timedOut
      ? `модель не відповіла за ${Math.round(timeoutMs / 1000)} с`
      : error.message;
    logger.event(
      "warn",
      "walkthrough.vision.failed",
      { error: error.message, code: error.code || null, timedOut },
      `Виклик зору не вдався: ${reason}`,
    );
    return { parsed: null, raw: "", failure: reason, ollamaMs: Date.now() - started };
  }
}

/**
 * Відповідь моделі → поля кроку з контракту (`state`, `instruction`, `target`).
 *
 * Тут діє головне правило модуля: state важливіший за instruction. Якщо на
 * екрані не та програма, рамку викидаємо, навіть коли модель її намалювала, —
 * інакше оверлей вів би користувача до кнопки, якої на екрані немає.
 *
 * @param {Object|null} parsed - розібрана відповідь моделі.
 * @param {Object} options - {sent: {width, height}, failure: string|null}
 */
export function toStepFields(parsed, { sent, failure = null } = {}) {
  const notes = [];

  if (!parsed) {
    notes.push(failure ? `виклик зору не вдався: ${failure}` : "модель віддала не JSON");
    return {
      state: "unclear",
      instruction: failure
        ? `Не вдалося подивитись на екран: ${failure}. Спробуйте ще раз.`
        : FALLBACK_INSTRUCTION.unclear,
      target: null,
      screenSummary: null,
      notes,
    };
  }

  let state = String(parsed.state || "").trim();
  if (!STATES.includes(state)) {
    notes.push(`невідомий state «${parsed.state}» → unclear`);
    state = "unclear";
  }

  let instruction = String(parsed.instruction || "").trim();
  if (!instruction) instruction = FALLBACK_INSTRUCTION[state];

  let target = null;
  if (parsed.target_found === true) {
    const { box, wasPixels, reason } = sanitizeBox(parsed.box, sent);
    if (box) {
      if (wasPixels) notes.push("модель дала пікселі замість часток — перераховано");
      const confidence = Number(parsed.confidence);
      target = {
        label: String(parsed.target_label || "").trim() || "елемент інтерфейсу",
        box,
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      };
    } else {
      notes.push(`рамку відкинуто (${reason})`);
    }
  }

  // Модель знайшла елемент, але сама ж каже, що потрібної програми на екрані
  // немає. Вірити тут треба стану: це типова галюцинація за документацією.
  if (target && STATES_WITHOUT_TARGET.includes(state)) {
    notes.push(`рамку відкинуто: стан «${state}» не сумісний із підсвіченим елементом`);
    target = null;
  }

  return {
    state,
    instruction,
    target,
    screenSummary: String(parsed.screen_summary || "").trim() || null,
    notes,
  };
}
