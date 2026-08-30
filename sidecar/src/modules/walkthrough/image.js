/**
 * Файл: src/modules/walkthrough/image.js
 * Опис: Підготовка знімка екрана до відправки у vision-модель і прибирання
 *       знімків після сесії.
 *
 * Два правила контракту, які реалізовано саме тут:
 *  - знімок зменшується ДО надсилання (повнорозмірний Retina-кадр у промпті —
 *    це десятки тисяч токенів і хвилини очікування);
 *  - знімок не лишається на диску довше за сесію: це екран користувача.
 *
 * Самого зменшення тут немає: воно в адаптері платформи (macOS — вбудована
 * `sips`). Нативної бібліотеки на кшталт sharp свідомо не тягнемо.
 */

import fs from "fs/promises";
import path from "path";

import { config } from "../../config/config.js";
import { getPlatformAdapter } from "../../platform/index.js";

/** Розширення, які ми вважаємо знімками і маємо право видаляти. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".tiff", ".bmp"];

/** Абсолютний шлях до теки знімків із конфіга (він відносний до кореня проєкта). */
export function screenshotsDir() {
  const configured = config.walkthrough?.screenshotDir || "./sidecar/data/screenshots";
  return path.resolve(config.paths.projectDir, configured);
}

/** Чи існує файл і чи він не порожній. */
export async function screenshotExists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Готує кадр для моделі: зменшує до config.walkthrough.maxImageWidth і
 * кодує в base64 (саме так Ollama приймає зображення в /api/generate).
 *
 * @param {string} screenshotPath - шлях до знімка, який зробив Rust.
 * @param {{sessionId: string, step: number|string}} tag - для імені зменшеної копії.
 * @returns {Promise<Object>} метрики кадру + base64.
 */
export async function prepareScreenshot(screenshotPath, tag) {
  const adapter = getPlatformAdapter();
  if (!adapter.supported) {
    throw new Error(
      `Знімок екрана неможливо підготувати: ${adapter.reason || `платформа ${adapter.platform} не підтримується`}`,
    );
  }

  const maxWidth = Number(config.walkthrough?.maxImageWidth) || 1280;
  const dir = screenshotsDir();
  await fs.mkdir(dir, { recursive: true });

  // Зменшена копія лежить у тій самій теці знімків — щоб прибирання сесії
  // забрало і її, а не лишило зменшений екран користувача на диску.
  const destination = path.join(dir, `${tag.sessionId}-${tag.step}-w${maxWidth}.png`);

  if (!(await screenshotExists(screenshotPath))) {
    throw new Error(
      `Знімок «${screenshotPath}» порожній або відсутній. Найчастіша причина — ` +
        `дозвіл на запис екрана не діє: після його надання застосунок треба перезапустити.`,
    );
  }

  const originalStat = await fs.stat(screenshotPath);
  const resized = await adapter.resizeImage(screenshotPath, { maxWidth, destination });
  const buffer = await fs.readFile(resized.path);
  // Порожній base64 Ollama відкидає з 400 і без пояснення, тож ловимо це тут.
  if (buffer.length === 0) {
    throw new Error(`Зменшена копія «${resized.path}» порожня — надсилати в модель нічого.`);
  }

  return {
    path: resized.path,
    base64: buffer.toString("base64"),
    // Метрики зменшення — те, чим доводимо, що в модель пішов малий кадр.
    originalPath: screenshotPath,
    originalWidth: resized.originalWidth,
    originalHeight: resized.originalHeight,
    originalBytes: originalStat.size,
    width: resized.width,
    height: resized.height,
    bytes: buffer.length,
    resized: resized.resized,
    // Тимчасовий файл віддаємо на прибирання лише якщо він справді створений.
    temporaryFile: resized.resized ? resized.path : null,
  };
}

/** Видаляє один файл; відсутній файл — не помилка. */
export async function removeFile(file) {
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Чистить теку знімків: усі зображення, які там лежать.
 * Викликається і при старті сесії, і у walkthrough.finish.
 * @returns {Promise<number>} скільки файлів видалено
 */
export async function purgeScreenshotsDir() {
  const dir = screenshotsDir();
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0; // теки ще немає — прибирати нічого
  }
  let removed = 0;
  for (const name of entries) {
    if (!IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
    if (await removeFile(path.join(dir, name))) removed++;
  }
  return removed;
}
