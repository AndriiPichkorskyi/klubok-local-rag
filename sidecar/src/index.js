/**
 * Файл: src/index.js
 * Опис: Точка входу в застосунок. Відповідає за ініціалізацію баз даних,
 *       логерування та запуск головного інтерактивного меню CLI.
 */

import { db } from "./services/db.service.js";
import { logger } from "./services/logger.service.js";
import { runCLI } from "./cli/index.js";

/**
 * Головна функція запуску застосунку.
 * Ініціалізує сервіси та запускає CLI.
 */
async function main() {
  try {
    // Ініціалізація логера
    await logger.init();
    await logger.logSystem("Запуск додатку...");

    // Ініціалізація баз даних
    await db.init();

    // Запуск інтерактивного CLI
    await runCLI();
    
    // Явно завершуємо процес, щоб @clack/prompts коректно відновив стан терміналу
    process.exit(0);
  } catch (error) {
    console.error("Критична помилка при запуску:", error);
    process.exit(1);
  }
}

// Перехоплення непередбачених помилок
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

main();
