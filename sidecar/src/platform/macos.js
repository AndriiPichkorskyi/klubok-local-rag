/**
 * Файл: src/platform/macos.js
 * Опис: Адаптер платформи macOS. Тонка обгортка над наявним кодом:
 *       сканування програм делегується в modules/indexer/scanner.js,
 *       запуск програми — системній утиліті `open`,
 *       робота із зображеннями — вбудованій `sips`.
 *       Власної логіки сканування тут немає і бути не повинно.
 */

import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { scanApplications } from "../modules/indexer/scanner.js";

const execFileAsync = promisify(execFile);

/**
 * Директорії, які скануємо на macOS.
 * Той самий перелік, що й дефолтний аргумент scanApplications() — передаємо
 * його явно, щоб список директорій був частиною адаптера, а не пайплайна.
 */
const SCAN_DIRS = [
  "/System/Applications",
  "/Applications",
  "/System/Applications/Utilities",
  "/System/Library/CoreServices/Applications",
  "/System/Library/Services",
  "/Library/Services",
  "/System/Library/PreferencePanes",
  "/Library/PreferencePanes",
];

/** Розширення файлів локальної довідки, які вміє читати індексатор. */
const DOC_EXTENSIONS = [".html", ".htm"];

/**
 * Кандидати на теку з локальною довідкою всередині пакета програми.
 * Порядок повторює runFetchLocalDocs(): спершу HelpBook із Info.plist,
 * потім загальновживані docs/help.
 * @param {{path: string, helpBookFolder?: string|null}} app
 * @returns {string[]}
 */
function localDocsCandidates(app) {
  const resources = path.join(app.path, "Contents", "Resources");
  const candidates = [];

  if (app.helpBookFolder) {
    candidates.push(
      path.join(resources, app.helpBookFolder),
      path.join(resources, "en.lproj", app.helpBookFolder),
      path.join(resources, "uk.lproj", app.helpBookFolder),
    );
  }

  candidates.push(
    path.join(resources, "docs"),
    path.join(resources, "help"),
    path.join(resources, "en.lproj", "docs"),
    path.join(resources, "en.lproj", "help"),
  );

  return candidates;
}

/** Рекурсивно збирає файли довідки в теці. Немає теки — порожній масив. */
async function collectDocFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() && DOC_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()),
      )
      .map((entry) => path.join(entry.parentPath || entry.path || dir, entry.name));
  } catch {
    // Теки немає або немає доступу — для кандидата це нормально
    return [];
  }
}

/**
 * Читає розмір зображення в пікселях через `sips -g`. Формат виводу:
 *   /path/to/file.png
 *     pixelWidth: 2880
 *     pixelHeight: 1864
 * @param {string} file
 * @returns {Promise<{width: number, height: number}>}
 */
async function sipsImageSize(file) {
  const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(
      `Не вдалося прочитати розмір зображення «${file}»: sips віддав «${stdout.trim()}».`,
    );
  }
  return { width, height };
}

export const adapter = {
  platform: "darwin",
  name: "macOS",
  supported: true,

  /** Перелік директорій, які треба сканувати на цій ОС. */
  getScanDirs() {
    return [...SCAN_DIRS];
  },

  /**
   * Сканування встановлених програм. Делегує в scanner.js як є.
   * @param {Function} onProgress
   * @returns {Promise<Object[]>}
   */
  async scanApplications(onProgress = () => {}) {
    return await scanApplications(SCAN_DIRS, onProgress);
  },

  /**
   * Пошук локальної документації програми всередині її пакета.
   * @param {{path: string, helpBookFolder?: string|null}} app
   * @returns {Promise<string[]>} абсолютні шляхи до html-файлів довідки
   */
  async findLocalDocs(app) {
    if (!app || !app.path)
      throw new Error("findLocalDocs: очікується об'єкт програми з полем `path`.");
    for (const dir of localDocsCandidates(app)) {
      const files = await collectDocFiles(dir);
      if (files.length > 0) return files;
    }
    return [];
  },

  /**
   * Запуск програми за ідентифікатором: bundleId (com.apple.Safari)
   * або абсолютний шлях до пакета (/Applications/Safari.app).
   * @param {string} identifier
   * @returns {Promise<{launched: boolean, identifier: string}>}
   */
  async launchApp(identifier) {
    if (!identifier || typeof identifier !== "string") {
      throw new Error("launchApp: не вказано ідентифікатор програми (bundleId або шлях).");
    }
    const args = identifier.startsWith("/") ? [identifier] : ["-b", identifier];
    try {
      await execFileAsync("open", args);
      return { launched: true, identifier };
    } catch (error) {
      throw new Error(`Не вдалося запустити «${identifier}»: ${error.message}`);
    }
  },

  /**
   * Розмір зображення в пікселях.
   * @param {string} file - абсолютний шлях до зображення
   * @returns {Promise<{width: number, height: number}>}
   */
  async getImageSize(file) {
    if (!file || typeof file !== "string") {
      throw new Error("getImageSize: не вказано шлях до зображення.");
    }
    return await sipsImageSize(file);
  },

  /**
   * Зменшує зображення до заданої ширини. Потрібно модулю walkthrough:
   * повнорозмірний Retina-кадр у промпті — це десятки тисяч токенів.
   *
   * Нативної бібліотеки (sharp тощо) свідомо НЕ тягнемо: у macOS для цього є
   * вбудована `sips`, і знання про неї — місце саме адаптера платформи.
   * Пропорції `sips --resampleWidth` зберігає сама.
   *
   * Зображення, вужче за maxWidth, не чіпаємо: віддаємо оригінал із
   * `resized: false`, щоб не витрачати час і не втрачати якість.
   *
   * @param {string} source - шлях до вихідного зображення
   * @param {{maxWidth: number, destination: string}} options
   * @returns {Promise<{path: string, width: number, height: number,
   *                    originalWidth: number, originalHeight: number, resized: boolean}>}
   */
  async resizeImage(source, { maxWidth, destination } = {}) {
    if (!source || typeof source !== "string") {
      throw new Error("resizeImage: не вказано шлях до вихідного зображення.");
    }
    if (!Number.isFinite(Number(maxWidth)) || Number(maxWidth) <= 0) {
      throw new Error(`resizeImage: некоректна максимальна ширина «${maxWidth}».`);
    }
    const original = await sipsImageSize(source);
    if (original.width <= Number(maxWidth)) {
      return {
        path: source,
        width: original.width,
        height: original.height,
        originalWidth: original.width,
        originalHeight: original.height,
        resized: false,
      };
    }
    if (!destination || typeof destination !== "string") {
      throw new Error("resizeImage: не вказано шлях, куди писати зменшену копію.");
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await execFileAsync("sips", [
      "--resampleWidth",
      String(Math.round(maxWidth)),
      source,
      "--out",
      destination,
    ]);
    const sent = await sipsImageSize(destination);
    return {
      path: destination,
      width: sent.width,
      height: sent.height,
      originalWidth: original.width,
      originalHeight: original.height,
      resized: true,
    };
  },
};

export default adapter;
