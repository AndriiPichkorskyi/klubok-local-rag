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
import { localized } from "../../i18n/language.js";

/** Стани, у яких рамка на екрані не має сенсу навіть якщо модель її дала. */
const STATES_WITHOUT_TARGET = ["app_not_started", "wrong_window"];

/** Запасні інструкції на випадок, коли модель не дала жодного тексту. */
function fallbackInstruction(state, language) {
  const translations = {
    app_not_started: { uk: "Відкрийте потрібну програму — на знімку її вікна немає.", en: "Open the required app — its window isn't visible in the screenshot." },
    wrong_window: { uk: "Перейдіть у вікно потрібної програми — зараз попереду інше вікно.", en: "Switch to the required app — another window is currently in front." },
    done: { uk: "Схоже, мету вже досягнуто.", en: "It looks like the goal has already been completed." },
    unclear: { uk: "Не вдалося розібрати, що зараз на екрані. Зробіть знімок ще раз.", en: "The screen couldn't be recognized. Take another screenshot." },
    ready: { uk: "Продовжуйте за довідкою програми.", en: "Continue by following the app guide." },
  };
  return localized(language, translations[state] || translations.unclear);
}

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
 * Окремо звідси виходить відповідь на пряме питання про ПОПЕРЕДНІЙ крок
 * (`previousDone`, `previousEvidence`): просування сесії спирається саме на неї.
 *
 * @param {Object} options - {sent: {width, height}, failure: string|null,
 *        allowedStates: string[] — звужений перелік, коли вікно підтвердила ОС}
 */
export function toStepFields(parsed, { sent, failure = null, allowedStates = STATES, language = "uk" } = {}) {
  const notes = [];

  if (!parsed) {
    notes.push(failure ? `виклик зору не вдався: ${failure}` : "модель віддала не JSON");
    return {
      state: "unclear",
      instruction: failure
        ? localized(language, {
            uk: `Не вдалося подивитись на екран: ${failure}. Спробуйте ще раз.`,
            en: "The screen couldn't be analyzed. Try again.",
          })
        : fallbackInstruction("unclear", language),
      target: null,
      screenSummary: null,
      // Модель нічого не сказала — отже, і про попередній крок вона не сказала
      // нічого. `null` тут означає «невідомо», і це НЕ те саме, що «не виконано»:
      // просування такий випадок не блокує, інакше збій Ollama вішав би сесію.
      previousDone: null,
      previousEvidence: null,
      notes,
    };
  }

  let state = String(parsed.state || "").trim();
  let coerced = false;
  if (!allowedStates.includes(state)) {
    coerced = true;
    // Стан поза дозволеним переліком. Окремо відзначаємо випадок, коли модель
    // усе-таки повернула «чи та це програма», хоч ОС уже відповіла на це
    // питання: вірити тут треба ОС, але й вигадану інструкцію брати не можна.
    notes.push(
      STATES.includes(state)
        ? `стан «${state}» недоступний: вікно вже підтверджено операційною системою → unclear`
        : `невідомий state «${parsed.state}» → unclear`,
    );
    state = "unclear";
  }

  let instruction = String(parsed.instruction || "").trim();
  if (!instruction) instruction = fallbackInstruction(state, language);

  let target = null;
  if (parsed.target_found === true) {
    const { box, wasPixels, reason } = sanitizeBox(parsed.box, sent);
    if (box) {
      if (wasPixels) notes.push("модель дала пікселі замість часток — перераховано");
      const confidence = Number(parsed.confidence);
      target = {
        label: String(parsed.target_label || "").trim() || localized(language, { uk: "елемент інтерфейсу", en: "interface control" }),
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

  // Стан довелося перебити — відповідь суперечлива, і рамці з неї теж віри
  // немає: та сама відповідь щойно стверджувала те, що ОС спростувала.
  if (target && coerced) {
    notes.push("рамку відкинуто: стан довелося перебити, відповідь суперечлива");
    target = null;
  }

  // Пряма відповідь на пряме питання «чи виконано попередній крок». Логічного
  // значення немає (модель не питали або вона його не дала) → null: рішення про
  // просування ухвалює index.js, і «невідомо» він трактує не як «ні».
  const previousDone = typeof parsed.previous_done === "boolean" ? parsed.previous_done : null;
  const previousEvidence = String(parsed.previous_evidence || "").trim() || null;
  if (previousDone === false && previousEvidence) {
    notes.push(`модель не бачить виконання попереднього кроку: ${previousEvidence}`);
  }

  return {
    state,
    instruction,
    target,
    screenSummary: String(parsed.screen_summary || "").trim() || null,
    previousDone,
    previousEvidence,
    notes,
  };
}
