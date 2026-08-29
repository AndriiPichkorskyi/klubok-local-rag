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
 * Поки прогін триває, файл має суфікс `.partial` і перейменовується на
 * `.json` лише при штатному завершенні. Тому обірваний прогін не підсовує
 * інтерфейсу зламаний JSON, але й не зникає безслідно — недописаний звіт
 * лишається на диску як свідчення того, докуди дійшли.
 */

import fs from "fs/promises";
import { createWriteStream } from "fs";

/**
 * @param {string} filePath - остаточний шлях звіту (.json)
 * @param {Object} header - {timestamp, totalCases, models, …} у потрібному порядку
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
      if (stream.write(text)) resolve();
      else stream.once("drain", resolve);
    });
  }

  function enqueue(text) {
    chain = chain.then(() => writeChunk(text));
    return chain;
  }

  // Заголовок пишеться в тому порядку, в якому його передали: так порядок
  // ключів у файлі однаковий для будь-якого набору полів.
  const headerLines = Object.entries(headerCopy).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`,
  );
  enqueue("{\n" + headerLines.join("") + `  "modes": {`);

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
      return enqueue(`${prefix}    ${JSON.stringify(name)}: {${paramsLine}\n      "results": [`);
    },

    /** Дописує один результат і НЕ тримає його в пам'яті. */
    addResult(result) {
      const prefix = firstResult ? "\n" : ",\n";
      firstResult = false;
      return enqueue(`${prefix}        ${JSON.stringify(result)}`);
    },

    /** Закриває секцію режиму підсумком. */
    endMode(summary) {
      if (currentMode) {
        modeSummaries[currentMode.name] = { params: currentMode.params, summary };
        currentMode = null;
      }
      const tail = firstResult ? "" : "\n      ";
      return enqueue(`${tail}],\n      "summary": ${JSON.stringify(summary)}\n    }`);
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
      closed = true;
      const footerLines = Object.entries(footer).map(
        ([key, value]) => `,\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
      );
      await enqueue((firstMode ? "}" : "\n  }") + footerLines.join("") + "\n}\n");
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
