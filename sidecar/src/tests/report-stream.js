/**
 * Файл: src/tests/report-stream.js
 * Опис: Потоковий запис JSON-звіту тестів на диск.
 *
 * Навіщо. Раніше бенчмарк тримав УСІ результати в масиві до самого кінця
 * і лише потім робив JSON.stringify всього звіту (≈2 МБ тексту). Це давало
 * три піки пам'яті одночасно: масив об'єктів, рядок JSON і буфер запису.
 * Тут результати лягають на диск одразу, як тільки готові, а в пам'яті
 * лишаються тільки лічильники.
 *
 * Форма файла не змінилась — та сама, яку читають cli/reports.js,
 * test-reports/viewer.html і RPC-метод `reports.read`:
 *   {timestamp, totalCases, models, modes: {"<режим>": {results: [...], summary: {...}}}}
 * (порядок ключів усередині режиму інший, для JSON.parse це не має значення).
 *
 * Поки прогін триває, файл має суфікс `.partial` і перейменовується на
 * `.json` лише при штатному завершенні. Тому обірваний прогін не підсовує
 * інтерфейсу зламаний JSON, але й не зникає безслідно — недописаний звіт
 * лишається на диску як свідчення того, докуди дійшли.
 */

import fs from "fs/promises";
import { createWriteStream } from "fs";

/**
 * @param {string} filePath - остаточний шлях звіту (.json)
 * @param {Object} header - {timestamp, totalCases, models}
 */
export function createReportStream(filePath, header) {
  const partialPath = `${filePath}.partial`;
  const stream = createWriteStream(partialPath, { encoding: "utf8" });

  // Результати приходять з кількох паралельних задач (p-limit), тому запис
  // серіалізуємо через ланцюжок промісів: два write не можуть переплестись.
  let chain = Promise.resolve();
  let firstMode = true;
  let firstResult = true;
  let closed = false;

  // Один постійний слухач помилки замість слухача на кожен запис:
  // інакше Node справедливо лаявся б на витік слухачів після 11-го рядка.
  let streamError = null;
  stream.on("error", (error) => {
    streamError = error;
  });

  function writeChunk(text) {
    return new Promise((resolve, reject) => {
      if (streamError) return reject(streamError);
      if (stream.write(text)) resolve();
      else stream.once("drain", resolve);
    });
  }

  function enqueue(text) {
    chain = chain.then(() => writeChunk(text));
    return chain;
  }

  const { timestamp, totalCases, models } = header;
  enqueue(
    "{\n" +
      `  "timestamp": ${JSON.stringify(timestamp)},\n` +
      `  "totalCases": ${JSON.stringify(totalCases)},\n` +
      `  "models": ${JSON.stringify(models)},\n` +
      `  "modes": {`,
  );

  return {
    filePath,
    partialPath,

    /** Починає секцію режиму. */
    beginMode(name) {
      const prefix = firstMode ? "\n" : ",\n";
      firstMode = false;
      firstResult = true;
      return enqueue(`${prefix}    ${JSON.stringify(name)}: {\n      "results": [`);
    },

    /** Дописує один результат і НЕ тримає його в пам'яті. */
    addResult(result) {
      const prefix = firstResult ? "\n" : ",\n";
      firstResult = false;
      return enqueue(`${prefix}        ${JSON.stringify(result)}`);
    },

    /** Закриває секцію режиму підсумком. */
    endMode(summary) {
      const tail = firstResult ? "" : "\n      ";
      return enqueue(`${tail}],\n      "summary": ${JSON.stringify(summary)}\n    }`);
    },

    /** Дописує хвіст, закриває файл і робить його «справжнім» .json. */
    async close() {
      if (closed) return filePath;
      closed = true;
      await enqueue(firstMode ? "}\n}\n" : "\n  }\n}\n");
      await new Promise((resolve) => stream.end(resolve));
      if (streamError) throw streamError;
      await fs.rename(partialPath, filePath);
      return filePath;
    },

    /** Аварійне закриття: файл лишається як `.partial`. */
    async abort() {
      if (closed) return partialPath;
      closed = true;
      await new Promise((resolve) => stream.end(resolve));
      return partialPath;
    },
  };
}
