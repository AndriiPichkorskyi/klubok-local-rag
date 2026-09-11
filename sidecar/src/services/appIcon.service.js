/**
 * Файл: src/services/appIcon.service.js
 * Опис: Дістає іконку застосунку macOS і повертає її як PNG у data-URL.
 *
 * Як це працює: у бандлі .app іконка лежить у Contents/Resources у форматі
 * .icns, а її ім'я вказане в Info.plist (CFBundleIconFile). Webview формат
 * .icns не читає, тому конвертуємо системним `sips` у PNG заданого розміру.
 *
 * Частина сучасних програм тримає іконку в Assets.car (ключ CFBundleIconName)
 * — з нього .icns не дістати, тому такі програми повертають null, а інтерфейс
 * показує монограму. Це свідома межа, а не помилка.
 *
 * Результат кешується на диску в теці даних, тож повторні відкриття вкладки
 * не запускають конвертацію знову.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";

import { config } from "../config/config.js";
import { logger } from "./logger.service.js";

const SIZE = 128;
const MAX_PATHS = 80;
const CONCURRENCY = 4;
const memory = new Map(); // path -> dataUrl | null

function cacheDir() {
  return path.join(config.paths?.dataDir || ".", "data", "app-icons");
}

function cacheFile(appPath) {
  const key = createHash("sha1").update(`${appPath}:${SIZE}`).digest("hex");
  return path.join(cacheDir(), `${key}.png`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || "").trim());
    });
  });
}

/** Ім'я .icns з Info.plist; порожній рядок, якщо ключа немає. */
async function iconFileName(appPath) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  try {
    return await run("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-", plist]);
  } catch {
    return "";
  }
}

/** Повний шлях до .icns або null, якщо програма тримає іконку в Assets.car. */
async function findIcns(appPath) {
  const resources = path.join(appPath, "Contents", "Resources");
  const named = await iconFileName(appPath);
  if (named) {
    const file = named.toLowerCase().endsWith(".icns") ? named : `${named}.icns`;
    const candidate = path.join(resources, file);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* ім'я є, файла немає — шукаємо будь-який .icns нижче */
    }
  }
  try {
    const entries = await fs.readdir(resources);
    const icns = entries.find((entry) => entry.toLowerCase().endsWith(".icns"));
    return icns ? path.join(resources, icns) : null;
  } catch {
    return null;
  }
}

async function toDataUrl(file) {
  const buffer = await fs.readFile(file);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

/** Одна іконка: пам'ять → диск → конвертація. */
async function iconFor(appPath) {
  if (memory.has(appPath)) return memory.get(appPath);

  const target = cacheFile(appPath);
  try {
    const dataUrl = await toDataUrl(target);
    memory.set(appPath, dataUrl);
    return dataUrl;
  } catch {
    /* кешу ще немає */
  }

  let dataUrl = null;
  try {
    const icns = await findIcns(appPath);
    if (icns) {
      await fs.mkdir(cacheDir(), { recursive: true });
      await run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(SIZE), icns, "--out", target]);
      dataUrl = await toDataUrl(target);
    }
  } catch (error) {
    logger.warn?.(`[icons] ${appPath}: ${error.message}`);
  }
  memory.set(appPath, dataUrl);
  return dataUrl;
}

/**
 * Іконки для набору шляхів. Повертає { icons: { <path>: dataUrl|null } }.
 * Порядок не гарантується, відсутня іконка — це null, а не помилка.
 */
export async function appIcons(paths = []) {
  const list = (Array.isArray(paths) ? paths : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value.startsWith("/"))
    .slice(0, MAX_PATHS);

  const icons = {};
  const queue = [...list];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const appPath = queue.shift();
      icons[appPath] = await iconFor(appPath);
    }
  });
  await Promise.all(workers);
  return { icons, size: SIZE };
}
