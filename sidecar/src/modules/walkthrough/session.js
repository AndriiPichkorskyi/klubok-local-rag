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
