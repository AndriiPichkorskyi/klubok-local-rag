/**
 * Файл: src/services/logger.service.js
 * Опис: Сервіс для логування системних подій та збереження історії запитів
 *       користувача (разом з фідбеком) у файли в папці /logs.
 */

import fs from "fs/promises";
import path from "path";

class LoggerService {
  constructor() {
    this.logsDir = path.resolve("logs");
    this.queryLogFile = path.join(this.logsDir, "queries.log");
    this.systemLogFile = path.join(this.logsDir, "system.log");
  }

  /**
   * Створює папку для логів, якщо вона не існує.
   */
  async init() {
    try {
      await fs.access(this.logsDir);
    } catch {
      await fs.mkdir(this.logsDir, { recursive: true });
    }
  }

  /**
   * Записує подію (систему чи запит) у відповідний файл у форматі JSON.
   */
  async _writeLog(filePath, data) {
    try {
      const logEntry =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          ...data,
        }) + "\n";
      await fs.appendFile(filePath, logEntry, "utf8");
    } catch (err) {
      console.error("Помилка запису логу:", err.message);
    }
  }

  /**
   * Логує інформацію про запит, відповідь та зворотній зв'язок.
   * @param {string} query - Запит користувача.
   * @param {string[]} contextApps - Масив програм, які потрапили в контекст.
   * @param {string} recommendedApp - Назва рекомендованої програми (або плейсхолдер).
   * @param {string} response - Відповідь LLM.
   * @param {string} feedback - Оцінка користувача (match, partial, none, other).
   */
  async logQueryWithFeedback(query, contextApps, recommendedApp, response, rawLlmOutput, retrievalStats, feedback) {
    await this._writeLog(this.queryLogFile, {
      query,
      contextApps,
      recommendedApp,
      response,
      rawLlmOutput,
      retrievalStats,
      feedback,
    });
  }

  /**
   * Логує системні події (запуск, помилки тощо).
   * @param {string} message - Повідомлення.
   */
  async logSystem(message) {
    await this._writeLog(this.systemLogFile, {
      type: "system",
      message,
    });
  }
}

export const logger = new LoggerService();
