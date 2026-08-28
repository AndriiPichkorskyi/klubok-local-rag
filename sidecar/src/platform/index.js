/**
 * Файл: src/platform/index.js
 * Опис: Вибір адаптера ОС. Інтерфейс адаптера описано в docs/contracts/platform.md.
 *       Невідома платформа — не аварія: повертаємо адаптер із supported:false,
 *       який чесно відмовляє при виклику будь-якого методу.
 */

import macos from "./macos.js";
import windows from "./windows.js";
import linux from "./linux.js";

/** process.platform → адаптер. */
const ADAPTERS = {
  darwin: macos,
  win32: windows,
  linux: linux,
};

/**
 * Адаптер для платформи, про яку ми взагалі нічого не знаємо (freebsd, aix тощо).
 * @param {string} platform
 */
function createUnknownAdapter(platform) {
  const reason =
    `Платформа «${platform}» невідома проєкту. Адаптера для неї немає, ` +
    "робочий адаптер існує лише для macOS.";

  const notImplemented = (method) => {
    throw new Error(`${reason} (метод «${method}»)`);
  };

  return {
    platform,
    name: platform,
    supported: false,
    reason,
    getScanDirs: () => notImplemented("getScanDirs"),
    scanApplications: async () => notImplemented("scanApplications"),
    findLocalDocs: async () => notImplemented("findLocalDocs"),
    launchApp: async () => notImplemented("launchApp"),
  };
}

/**
 * Повертає адаптер поточної (або явно вказаної) ОС.
 * @param {string} [platform] - значення в форматі process.platform
 */
export function getPlatformAdapter(platform = process.platform) {
  return ADAPTERS[platform] || createUnknownAdapter(String(platform));
}

/** Перелік платформ, для яких у проєкті є адаптер (навіть заглушка). */
export const KNOWN_PLATFORMS = Object.keys(ADAPTERS);

export default getPlatformAdapter;
