/**
 * Файл: src/platform/windows.js
 * Опис: Заглушка адаптера Windows. Реалізації немає: кожен метод чесно
 *       відмовляє з поясненням. Порожніх масивів, які виглядають як успішне
 *       сканування, тут навмисно не повертаємо.
 */

const REASON =
  "Адаптер Windows не реалізовано. Робочий адаптер існує лише для macOS; " +
  "сканування програм, пошук довідки та запуск програм на Windows поки недоступні.";

/** Єдина точка відмови — щоб повідомлення було однакове для всіх методів. */
function notImplemented(method) {
  throw new Error(`${REASON} (метод «${method}»)`);
}

export const adapter = {
  platform: "win32",
  name: "Windows",
  supported: false,
  reason: REASON,

  getScanDirs() {
    return notImplemented("getScanDirs");
  },

  async scanApplications() {
    return notImplemented("scanApplications");
  },

  async findLocalDocs() {
    return notImplemented("findLocalDocs");
  },

  async launchApp() {
    return notImplemented("launchApp");
  },

  async getImageSize() {
    return notImplemented("getImageSize");
  },

  async resizeImage() {
    return notImplemented("resizeImage");
  },
};

export default adapter;
