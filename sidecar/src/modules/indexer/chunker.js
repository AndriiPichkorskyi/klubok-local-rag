/**
 * Файл: src/modules/indexer/chunker.js
 * Опис: Відповідає за розбиття великих текстів (документації) на менші фрагменти (чанки),
 *       щоб їх можна було перетворити на вектори та зберегти в базу даних.
 */

import { config } from "../../config/config.js";

/**
 * Розбиває текст на масив чанків заданого розміру із перекриттям.
 * Враховує розриви абзаців та речень для створення логічних шматків тексту.
 *
 * @param {string} text - Оригінальний великий текст.
 * @returns {string[]} - Масив текстових фрагментів (чанків).
 */
export function chunkText(text) {
  const { chunkSize, chunkOverlap } = config.indexer;
  const chunks = [];
  let i = 0;

  while (i < text.length) {
    let end = i + chunkSize;

    if (end < text.length) {
      let nextNewline = text.indexOf("\n", end - 50);
      let nextPeriod = text.indexOf(".", end - 50);

      if (nextNewline !== -1 && nextNewline < end + 100) {
        end = nextNewline + 1;
      } else if (nextPeriod !== -1 && nextPeriod < end + 100) {
        end = nextPeriod + 1;
      }
    } else {
      end = text.length;
    }

    const chunk = text.substring(i, end).trim();
    if (chunk.length > 50) {
      chunks.push(chunk);
    }

    i = end - chunkOverlap;
    if (i < 0) i = 0;
    if (end >= text.length) break;
  }

  return chunks;
}
