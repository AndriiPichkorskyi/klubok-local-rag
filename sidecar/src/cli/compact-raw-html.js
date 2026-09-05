/**
 * Файл: src/cli/compact-raw-html.js
 * Опис: Замінює у ВКАЗАНІЙ базі сирі сторінки довідки на витягнуту статтю
 *       (`scraper.extractMainHtml`). Потрібно для архіву розповсюдження.
 *
 *       Навіщо: сира сторінка Apple важить ~525 КБ, а стаття з неї — ~6 КБ
 *       (1.2%). Застосунок і так показує саме статтю: `rag/engine.js` читає
 *       raw_html і одразу проганяє його через `extractMainHtml`. Повторний
 *       прохід по вже витягнутій статті дає той самий результат (перевірено:
 *       різниця лише в провідних пробілах), тому в коді застосунку не
 *       змінюється НІЧОГО — база просто стає меншою в ~80 разів.
 *
 *       Альтернатива — викинути raw_html цілком: тоді стаття показується з
 *       Markdown-тексту `web_documents.content` (фолбек уже є в
 *       `ResultView.jsx`), але оригінальна розмітка втрачається.
 *
 * Запуск: node src/cli/compact-raw-html.js /шлях/до/копії/rag_metadata.sqlite
 *
 * Свою робочу базу передавати не треба — скрипт таку спробу відхиляє.
 */
import path from "path";

import sqlite3 from "sqlite3";
import { open } from "sqlite";

import { config } from "../config/config.js";
import { scraper } from "../services/scraper.service.js";

const file = process.argv[2];

if (!file) {
  console.error("Вкажіть шлях до файла бази: node src/cli/compact-raw-html.js <файл.sqlite>");
  process.exit(2);
}

const target = path.resolve(file);
if (target === path.resolve(config.db.sqlitePath)) {
  console.error(
    `Це робоча база (${target}). Скрипт призначений для КОПІЇ: сира довідка ` +
      "потрібна для повторного чанкінгу без повторного скачування.",
  );
  process.exit(2);
}

const db = await open({ filename: target, driver: sqlite3.Database });

const ids = await db.all("SELECT link_id FROM raw_html ORDER BY link_id");
console.log(`Сторінок у raw_html: ${ids.length}`);

let before = 0;
let after = 0;
let dropped = 0;

for (const [index, { link_id: linkId }] of ids.entries()) {
  const row = await db.get("SELECT html FROM raw_html WHERE link_id = ?", [linkId]);
  if (!row?.html) continue;

  before += Buffer.byteLength(row.html);
  const extracted = scraper.extractMainHtml(row.html);

  if (!extracted || !extracted.trim()) {
    // Витягти статтю не вдалося: тримати заради цього півмегабайта сирої
    // сторінки в архіві немає сенсу — фолбек на Markdown-текст лишається.
    await db.run("DELETE FROM raw_html WHERE link_id = ?", [linkId]);
    dropped += 1;
    continue;
  }

  after += Buffer.byteLength(extracted);
  await db.run("UPDATE raw_html SET html = ? WHERE link_id = ?", [extracted, linkId]);

  if ((index + 1) % 200 === 0) {
    console.log(`  ${index + 1} з ${ids.length}…`);
  }
}

await db.close();

const mb = (bytes) => (bytes / 1048576).toFixed(1);
console.log(
  `Готово: ${mb(before)} МБ сирих сторінок → ${mb(after)} МБ статей` +
    (dropped ? `, викинуто без статті: ${dropped}` : ""),
);
console.log("Далі потрібен VACUUM, інакше файл не зменшиться.");
