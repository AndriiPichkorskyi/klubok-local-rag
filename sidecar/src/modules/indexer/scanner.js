/**
 * Файл: src/modules/indexer/scanner.js
 * Опис: Модуль для сканування системних папок macOS з метою пошуку встановлених
 *       програм, служб, швидких дій (workflows) та панелей налаштувань.
 *       Використовує нативну утиліту `plutil` для безпечного читання бінарних plist-файлів.
 */

import fs from "fs/promises";
import path from "path";
import * as plist from "plist";
import { execFileSync } from "child_process";

/**
 * Сканує вказані директорії на наявність пакетів застосунків/служб та витягує їх метадані (Info.plist).
 *
 * @param {string[]} dirsToScan - Масив шляхів до папок для сканування.
 * @param {Function} onProgress - Колбек для відображення прогресу.
 * @returns {Promise<Object[]>} - Масив об'єктів з метаданими знайдених інструментів.
 */
export async function scanApplications(
  dirsToScan = [
    "/System/Applications",
    "/Applications",
    "/System/Applications/Utilities",
    "/System/Library/CoreServices/Applications",
    "/System/Library/Services",
    "/Library/Services",
    "/System/Library/PreferencePanes",
    "/Library/PreferencePanes",
  ],
  onProgress = () => {},
) {
  const foundApps = [];

  for (const appsDir of dirsToScan) {
    try {
      const files = await fs.readdir(appsDir);
      const apps = files.filter(
        (file) =>
          file.endsWith(".app") ||
          file.endsWith(".service") ||
          file.endsWith(".workflow") ||
          file.endsWith(".prefPane"),
      );

      for (const app of apps) {
        const appPath = path.join(appsDir, app);
        const contentsPath = path.join(appPath, "Contents");
        const mainPlistPath = path.join(contentsPath, "Info.plist");

        try {
          // Використовуємо plutil для конвертації binary plist в XML, оскільки звичайний plist часто падає на бінарних
          const xmlContent = execFileSync(
            "plutil",
            ["-convert", "xml1", "-o", "-", mainPlistPath],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          );
          const parsedPlist = plist.parse(xmlContent);

          let appName =
            parsedPlist.CFBundleDisplayName || parsedPlist.CFBundleName || app.replace(".app", "");
          const bundleId = parsedPlist.CFBundleIdentifier;
          const helpBookFolder = parsedPlist.CFBundleHelpBookFolder;
          let hpdProjectIdentifier = parsedPlist.HPDHelpProjectIdentifier;
          if (!hpdProjectIdentifier && helpBookFolder) {
            hpdProjectIdentifier = helpBookFolder.replace(".help", "").toLowerCase();
          }

          if (!bundleId) continue;

          foundApps.push({
            name: appName,
            bundleId,
            path: appPath,
            helpBookFolder: helpBookFolder || null,
            hpdProjectIdentifier: hpdProjectIdentifier || null,
          });
        } catch (err) {
          // Ignore apps without Info.plist or parse errors
        }
      }
    } catch (e) {
      // Ігноруємо помилку, якщо директорія не існує або немає доступу
    }
  }

  
  // Додаємо віртуальний застосунок "macOS System" (mac-help), 
  // оскільки його не існує як окремої програми на диску, але він містить глобальну довідку ОС.
  foundApps.push({
    name: "macOS System",
    bundleId: "com.apple.macos",
    path: "/System",
    helpBookFolder: null,
    hpdProjectIdentifier: "mac-help",
  });

  return foundApps;
}

