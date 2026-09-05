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
  if (!text) return [];

  const { chunkSize } = config.indexer;

  // Перекриття, не менше за розмір чанка, зупиняє рух уперед: i = end - overlap
  // повертало б нас на місце, і векторизація висіла б назавжди на першому ж
  // документі. Це помилка конфіга, а не даних, тому просто обмежуємо значення.
  const chunkOverlap = Math.min(Math.max(0, config.indexer.chunkOverlap || 0), chunkSize - 1);

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

    // Другий запобіжник: за будь-яких значень крок мусить бути додатним.
    const next = end - chunkOverlap;
    i = next > i ? next : i + 1;
    if (end >= text.length) break;
  }

  // Поріг у 50 символів має відсікати лише хвости довгого тексту.
  // Якщо коротким виявився весь документ, він зникав повністю — саме так
  // губилися META-чанки програм з короткою назвою (TV, Mail, Maps...).
  if (chunks.length === 0) {
    const whole = text.trim();
    if (whole.length > 0) chunks.push(whole);
  }

  return chunks;
}
