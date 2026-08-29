/**
 * Команди Tauri, потрібні модулю walkthrough (docs/contracts/walkthrough.md).
 *
 * Окремий файл, а не src/ipc.js, свідомо: ipc.js — чужа зона, а на момент
 * написання цих команд у Rust ще немає. Коли вони з'являться, обгортки нижче
 * переїжджають в ipc.js одним рухом — форма викликів уже така сама.
 *
 * Головне правило файлу: відсутня команда — це НЕ біла сторінка й не «щось
 * пішло не так», а окремий тип помилки з назвою команди, яку інтерфейс
 * покаже людині словами.
 */
import { invoke } from "@tauri-apps/api/core";

/** Команди в застосунку ще немає (або їй не видано дозволу в capabilities). */
export class MissingCommandError extends Error {
  constructor(command, detail = "") {
    super(`Команда Tauri «${command}» недоступна${detail ? `: ${detail}` : ""}`);
    this.name = "MissingCommandError";
    this.command = command;
    this.detail = detail;
  }
}

/** Відмова macOS у доступі до запису екрана. Контракт: це стан, а не аварія. */
export class ScreenPermissionError extends Error {
  constructor(detail = "") {
    super("Немає дозволу на запис екрана");
    this.name = "ScreenPermissionError";
    this.detail = detail;
  }
}

const MISSING_RE =
  /not\s+found|unknown\s+command|not\s+allowed|not\s+registered|no\s+such\s+command|command\s+.*\s+(?:not|isn't)/i;
const PERMISSION_RE =
  /permission|not\s+authoriz|denied|доступ|дозвіл|screen\s*recording|запис\s*екрана/i;

const messageOf = (error) =>
  typeof error === "string" ? error : String(error?.message ?? error ?? "");

/**
 * Виклик команди з розбором того, ЧОМУ не вдалося.
 * Три різні наслідки для інтерфейсу — три різні помилки.
 */
async function call(command, args = {}) {
  try {
    return await invoke(command, args);
  } catch (error) {
    const text = messageOf(error);
    if (MISSING_RE.test(text)) throw new MissingCommandError(command, text.trim());
    if (PERMISSION_RE.test(text)) throw new ScreenPermissionError(text.trim());
    throw error instanceof Error ? error : new Error(text || `Команда «${command}» не вдалася`);
  }
}

/**
 * Знімок екрана. Повертає {path, widthPx, heightPx, scaleFactor}.
 * Метадані тримаємо разом зі знімком: без них координати від моделі
 * (нормалізовані 0..1) нема з чого переводити в точки екрана.
 */
export async function screenCapture(mode = "window") {
  const shot = await call("screen_capture", { mode });
  if (!shot || typeof shot.path !== "string" || !shot.path) {
    // Команда є, але нічого не віддала — для нас це те саме, що її немає.
    throw new MissingCommandError("screen_capture", "команда не повернула шлях до знімка");
  }
  return shot;
}

/** Запуск програми: {launched, alreadyRunning, pid}. */
export const launchApp = (appId) => call("launch_app", { appId });

/** Яка програма зараз попереду: {name, bundleId}. Не критично — лише уточнює текст. */
export async function frontmostApp() {
  try {
    return await call("frontmost_app", {});
  } catch {
    return null; // знати не обов'язково; мовчки живемо без цього
  }
}

/** Показати/сховати вікно підказки. */
export const overlayShow = () => call("overlay_show", {});
export const overlayHide = () => call("overlay_hide", {});

/**
 * Рамка поверх екрана — ДРУГИЙ етап (config.walkthrough.enableHighlight).
 * Координати йдуть нормалізованими 0..1, як вимагає контракт: переведення в
 * точки робить той, хто малює, з метаданих свого ж знімка.
 * Тут лише точка виклику, щоб увімкнення прапорця не вимагало правити панель.
 */
export async function overlayHighlight(box) {
  if (!box || typeof box.x !== "number") return null;
  try {
    return await call("overlay_highlight", { box });
  } catch {
    return null; // підсвічування — прикраса; без нього крок усе одно читається
  }
}

export const isMissingCommand = (error) => error instanceof MissingCommandError;
export const isScreenPermission = (error) => error instanceof ScreenPermissionError;
