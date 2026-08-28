/**
 * Файл: src/platform/linux.js
 * Опис: Заглушка адаптера Linux. Реалізації немає: кожен метод чесно
 *       відмовляє з поясненням. Порожніх масивів, які виглядають як успішне
 *       сканування, тут навмисно не повертаємо.
 */

const REASON =
  "Адаптер Linux не реалізовано. Робочий адаптер існує лише для macOS; " +
  "сканування програм, пошук довідки та запуск програм на Linux поки недоступні.";

/** Єдина точка відмови — щоб повідомлення було однакове для всіх методів. */
function notImplemented(method) {
  throw new Error(`${REASON} (метод «${method}»)`);
}

export const adapter = {
  platform: "linux",
  name: "Linux",
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
};

export default adapter;
