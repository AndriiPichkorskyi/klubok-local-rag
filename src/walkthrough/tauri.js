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

/**
 * Чи можна ЦЕ показати людині як назву програми.
 *
 * Друга лінія оборони після Rust (`clean_name` у `src-tauri/src/system.rs`):
 * у живому прогоні вікно вже написало «зараз попереду «[»» — назвою стала
 * дужка з виводу `lsappinfo`. Порожнє, самі розділові знаки, службові символи
 * і початок розмітки назвою не є, і краще не сказати нічого, ніж сказати таке.
 * Повертає очищену назву або null.
 */
export function cleanAppName(value) {
  const name = String(value ?? "")
    .replace(/^["\s]+|["\s]+$/g, "")
    .replace(/:$/, "")
    .trim();
  if (!name || name.length > 64) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (!/[\p{L}\p{N}]/u.test(name)) return null; // ані літери, ані цифри — це розмітка
  if (/^[[\]{}()<>=,;]/.test(name)) return null; // початок структури, а не значення
  return name;
}

/**
 * Як назвати програму, яка зараз попереду, у тексті для людини.
 * Назва → останній сегмент bundleId (com.apple.Photos → Photos) → «інша
 * програма». Вигадувати замість назви сміття не можна, а мовчати незручно:
 * «зараз попереду інша програма» і чесно, і зрозуміло.
 */
export function frontmostLabel(front) {
  const name = cleanAppName(front?.name);
  if (name) return name;
  const bundleId = String(front?.bundleId ?? "").trim();
  const tail = cleanAppName(bundleId.split(".").pop());
  if (tail && /[\p{L}]/u.test(tail)) return tail;
  return "інша програма";
}

/**
 * Яка програма зараз попереду: {name, bundleId}. Не критично — лише уточнює текст.
 * Назву пропускаємо через `cleanAppName`: зіпсоване значення не має піти далі
 * ні у вікно, ні в `walkthrough.step` — бекенд складає з нього текст кроку.
 */
export async function frontmostApp() {
  try {
    const front = await call("frontmost_app", {});
    if (!front || typeof front !== "object") return null;
    return { ...front, name: cleanAppName(front.name) };
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
