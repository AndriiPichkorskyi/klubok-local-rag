/**
 * Файл: src/platform/macos.js
 * Опис: Адаптер платформи macOS. Тонка обгортка над наявним кодом:
 *       сканування програм делегується в modules/indexer/scanner.js,
 *       запуск програми — системній утиліті `open`.
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
};

export default adapter;
