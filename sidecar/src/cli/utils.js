/**
 * Файл: src/cli/utils.js
 * Опис: Утиліти для роботи з командним рядком (форматування часу виконання).
 */

import pc from "picocolors";

/**
 * Форматує час виконання (мілісекунди) у зручний для читання формат (мс або сек).
 * @param {number} ms - Час виконання у мілісекундах.
 * @returns {string} - Кольоровий рядок із часом.
 */
export function formatExecutionTime(ms) {
  if (ms < 1000) {
    return pc.yellow(`${Math.round(ms)}ms`);
  }
  return pc.yellow(`${(ms / 1000).toFixed(2)}s`);
}

/**
 * Виконує асинхронну функцію та вимірює час її виконання.
 * @param {Function} fn - Асинхронна функція для вимірювання.
 * @returns {Promise<{result: any, executionTimeMs: number}>} - Результат функції та час виконання.
 */
export async function measureTime(fn) {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  return {
    result,
    executionTimeMs: end - start,
  };
}
