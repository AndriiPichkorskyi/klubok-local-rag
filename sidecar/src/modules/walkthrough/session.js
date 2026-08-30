/**
 * Файл: src/modules/walkthrough/session.js
 * Опис: Реєстр сесій walkthrough. Сесія живе в пам'яті процесу: вона
 *       складається з мети, документації і списку вже названих кроків —
 *       нічого з цього не має сенсу переживати перезапуск sidecar.
 */

import { randomUUID } from "crypto";

import { removeFile } from "./image.js";

/** sessionId → сесія. */
const sessions = new Map();

/**
 * Створює сесію.
 * @param {Object} data - {appId, appName, goal, docsText, docs, stepSource, plan}
 */
export function createSession(data) {
  const session = {
    sessionId: randomUUID(),
    createdAt: Date.now(),
    stepIndex: 0,
    history: [],
    /** Шляхи, які треба прибрати у finish: і кадри від Rust, і зменшені копії. */
    files: new Set(),
    /**
     * Назви, під якими ми впізнаємо цю програму додатково до назви з бази.
     * Наповнюється з `frontmost`, коли bundleId підтвердив локалізовану назву
     * («Фотографії» для com.apple.Photos, у базі — «Photos»).
     */
    appAliases: new Set(),
    /**
     * Позиція в списку кроків режиму `plan` (ручного). Окрема від `stepIndex`
     * навмисно: `stepIndex` рахує ВСІ кроки сесії, зокрема ті, що були зроблені
     * зором до перемикання, а курсор плану завжди починається з першого пункту
     * довідки. Так перемикання посеред сесії не втрачає пройденого і не змушує
     * вгадувати, якому пункту довідки відповідає п'ятий крок зору.
     */
    planCursor: 0,
    /**
     * Інструкції, про які користувач прямо сказав «я це зробив». Людина бачить
     * свій екран краще за модель на 3 млрд параметрів, тож її слово остаточне:
     * ці кроки більше не пропонуються — вони йдуть у промпт як заборона.
     */
    confirmedSteps: [],
    /** Остання інструкція (нормалізована) і скільки разів поспіль вона повторилась. */
    lastInstruction: null,
    repeatCount: 0,
    /** Скільки разів за сесію реально викликано vision-модель. Нуль у ручному режимі. */
    visionCalls: 0,
    ...data,
  };
  sessions.set(session.sessionId, session);
  return session;
}

/** Сесія за id. Немає — зрозуміла помилка методу, а не undefined далі по коду. */
export function getSession(sessionId) {
  const session = sessions.get(String(sessionId || ""));
  if (!session) {
    throw new Error(
      `Сесії walkthrough «${sessionId}» не існує. Можливо, її вже закрито методом walkthrough.finish або sidecar перезапустився.`,
    );
  }
  return session;
}

/**
 * Нормалізація інструкції для порівняння «те саме вдруге»: регістр, лапки,
 * розділові знаки і пробіли не мають робити з повтору новий крок.
 */
export function normalizeInstruction(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[«»"'`,.;:!?()\[\]—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Скільки сесій зараз відкрито (для діагностики). */
export function activeSessions() {
  return [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    appName: s.appName,
    goal: s.goal,
    stepIndex: s.stepIndex,
    ageMs: Date.now() - s.createdAt,
  }));
}

/** Запам'ятовує файл, який належить сесії і має зникнути разом із нею. */
export function trackFile(session, file) {
  if (file) session.files.add(file);
}

/**
 * Закриває сесію: видаляє її знімки і прибирає з реєстру.
 * @returns {Promise<{removedFiles: number}>}
 */
export async function dropSession(session) {
  let removedFiles = 0;
  for (const file of session.files) {
    if (await removeFile(file)) removedFiles++;
  }
  sessions.delete(session.sessionId);
  return { removedFiles };
}
