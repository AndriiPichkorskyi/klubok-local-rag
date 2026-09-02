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
 * Форма файла (єдина для RAG-бенчмарку і для EXTERNAL-тестів):
 *   {
 *     <ключі заголовка в порядку, в якому їх передали: timestamp, totalCases,
 *      models, axes, expectedRuns, …>,
 *     "modes": {
 *       "<режим>": { "params": {…}, "results": [ … ], "summary": {…} }
 *     },
 *     <ключі хвоста: seedGroups, axisComparison, …>
 *   }
 *
 * Що змінилось проти попередньої версії:
 *   - у кожного режиму з'явився блок `params` ПЕРЕД `results` — повний набір
 *     осей, якими режим отримано (звіт має лишатись самодостатнім);
 *   - заголовок і хвіст більше не зашиті: пишеться те, що передали;
 *   - `summaryView()` віддає той самий звіт БЕЗ результатів — саме його
 *     тепер отримує renderReportTable() в обох тестах, замість того щоб
 *     кожен файл збирав об'єкт по-своєму (форма й порядок ключів різнились).
 * Поля `timestamp`, `totalCases`, `models` і `modes.*.summary` лишились на
 * місці, тож cli/reports.js і src/dev/ReportTable.jsx читають звіт як читали.
 *
 * Поки прогін триває, `.partial` завжди містить валідний JSON-знімок. Відкриті
 * масиви пишуться у внутрішній `.working`, а після кожного пакета з 50
 * результатів знімок атомарно замінюється. Тому файл можна читати навіть під
 * час прогону або після скасування тестів.
 */

import fs from "fs/promises";
import { createWriteStream } from "fs";

/**
 * @param {string} filePath - остаточний шлях звіту (.json)
 * @param {Object} header - {timestamp, totalCases, models, …} у потрібному порядку
 */
export function createReportStream(filePath, header) {
  const partialPath = `${filePath}.partial`;
  // Внутрішні файли навмисно не мають розширення `.json`: вони можуть бути
  // синтаксично незавершеними, і людина не має сплутати їх зі звітом.
  const reportStem = filePath.endsWith(".json") ? filePath.slice(0, -5) : filePath;
  const workingPath = `${reportStem}.working`;
  const snapshotPath = `${reportStem}.snapshot-next`;
  const stream = createWriteStream(workingPath, { encoding: "utf8" });

  // Результати приходять з кількох паралельних задач керованої черги, тому запис
  // серіалізуємо через ланцюжок промісів: два write не можуть переплестись.
  let chain = Promise.resolve();
  let firstMode = true;
  let firstResult = true;
  let closed = false;

  // Копія заголовка й підсумків режимів — рівно те, що потрібно таблиці
  // в терміналі. Результати сюди не потрапляють ніколи.
  const headerCopy = { ...header };
  const modeSummaries = {};
  let currentMode = null;

  // Один постійний слухач помилки замість слухача на кожен запис:
  // інакше Node справедливо лаявся б на витік слухачів після 11-го рядка.
  let streamError = null;
  stream.on("error", (error) => {
    streamError = error;
  });

  function writeChunk(text) {
    return new Promise((resolve, reject) => {
      if (streamError) return reject(streamError);
      stream.write(text, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  let chunkBuffer = [];
  let bufferedResults = 0;
  // Менше системних записів під час багатогодинного прогону: результати
  // накопичуються максимум по 50 JSON-фрагментів і тоді одним блоком ідуть на диск.
  const BATCH_SIZE = 50;

  /** Закриття, яке перетворює поточний стан робочого файла на валідний JSON. */
  function snapshotTail() {
    if (!currentMode) return firstMode ? "}\n}\n" : "\n  }\n}\n";
    const resultTail = firstResult ? "" : "\n      ";
    return `${resultTail}],\n      "summary": null,\n      "inProgress": true\n    }\n  }\n}\n`;
  }

  /** Публікує знімок через rename: читач не побачить напівзаписаний файл. */
  async function publishSnapshot(tail) {
    await fs.copyFile(workingPath, snapshotPath);
    await fs.appendFile(snapshotPath, tail, "utf8");
    await fs.rename(snapshotPath, partialPath);
  }

  function scheduleFlush() {
    if (chunkBuffer.length === 0) return chain;
    // Відрізаємо пакет синхронно: наступні результати вже належать наступним 50.
    const text = chunkBuffer.join("");
    const tail = snapshotTail();
    chunkBuffer = [];
    bufferedResults = 0;
    chain = chain
      .then(() => writeChunk(text))
      .then(() => publishSnapshot(tail));
    return chain;
  }

  function enqueue(text, forceFlush = false, isResult = false) {
    chunkBuffer.push(text);
    if (isResult) bufferedResults += 1;
    if (bufferedResults >= BATCH_SIZE || forceFlush) {
      scheduleFlush();
    }
    return chain;
  }

  // Заголовок пишеться в тому порядку, в якому його передали: так порядок
  // ключів у файлі однаковий для будь-якого набору полів.
  const headerLines = Object.entries(headerCopy).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`,
  );
  // Перший валідний `.partial` з'являється відразу, ще до першого результату.
  enqueue("{\n" + headerLines.join("") + `  "modes": {`, true);

  return {
    filePath,
    partialPath,

    /**
     * Починає секцію режиму.
     * @param {string} name - назва режиму
     * @param {Object|null} params - осі, якими режим отримано
     */
    beginMode(name, params = null) {
      const prefix = firstMode ? "\n" : ",\n";
      firstMode = false;
      firstResult = true;
      currentMode = { name, params };
      const paramsLine = params ? `\n      "params": ${JSON.stringify(params)},` : "";
      return enqueue(
        `${prefix}    ${JSON.stringify(name)}: {${paramsLine}\n      "results": [`,
        true,
      );
    },

    /** Дописує один результат і НЕ тримає його в пам'яті. */
    addResult(result) {
      const prefix = firstResult ? "\n" : ",\n";
      firstResult = false;
      return enqueue(`${prefix}        ${JSON.stringify(result)}`, false, true);
    },

    /** Закриває секцію режиму підсумком. */
    endMode(summary) {
      if (currentMode) {
        modeSummaries[currentMode.name] = { params: currentMode.params, summary };
        currentMode = null;
      }
      const tail = firstResult ? "" : "\n      ";
      return enqueue(`${tail}],\n      "summary": ${JSON.stringify(summary)}\n    }`, true);
    },

    /**
     * Звіт без результатів: заголовок + params/summary кожного режиму.
     * Саме це отримує renderReportTable() — і в test-rag.js, і в
     * test-external.js, щоб форма й порядок ключів були одні.
     */
    summaryView(footer = {}) {
      return { ...headerCopy, modes: { ...modeSummaries }, ...footer };
    },

    /**
     * Дописує хвіст, закриває файл і робить його «справжнім» .json.
     * @param {Object} footer - додаткові поля ПІСЛЯ `modes` (seedGroups тощо).
     */
    async close(footer = {}) {
      if (closed) return filePath;
      if (currentMode) {
        throw new Error("Не можна завершити JSON-звіт, доки поточний режим не закрито.");
      }
      scheduleFlush();
      await chain;
      closed = true;
      const footerLines = Object.entries(footer).map(
        ([key, value]) => `,\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
      );
      await writeChunk((firstMode ? "}" : "\n  }") + footerLines.join("") + "\n}\n");
      await new Promise((resolve) => stream.end(resolve));
      if (streamError) throw streamError;
      await fs.rename(workingPath, filePath);
      await fs.unlink(partialPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return filePath;
    },

    /** Аварійне закриття: валідний останній знімок лишається як `.partial`. */
    async abort() {
      if (closed) return partialPath;
      scheduleFlush();
      await chain;
      closed = true;
      await new Promise((resolve) => stream.end(resolve));
      if (streamError) throw streamError;
      await fs.unlink(workingPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await fs.unlink(snapshotPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return partialPath;
    },
  };
}
