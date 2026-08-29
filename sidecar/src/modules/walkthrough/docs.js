/**
 * Файл: src/modules/walkthrough/docs.js
 * Опис: Документація однієї програми для модуля 2.5. Це ЧИТАННЯ бази —
 *       файл-замок такі операції не беруть (див. docs/contracts/rpc.md).
 *
 * Чому запити тут, а не в db.service.js: сервісу потрібен був би метод
 * «дай статті програми X під мету Y», якого більше ніхто не використовує.
 * Схему БД і дані ми не змінюємо, лише читаємо вже наявні таблиці:
 *   apps → document_links → web_documents (повний текст статті),
 *   chunks_fts (повнотекстовий пошук по чанках, поле appName).
 */

import { db } from "../../services/db.service.js";

/** Скільки статей документації максимум кладемо в контекст промпта. */
const MAX_DOCS = 3;
/** Скільки символів однієї статті лишаємо. Зір і так має малий контекст. */
const MAX_DOC_CHARS = 2500;
/** Загальна стеля контексту документації. */
const MAX_TOTAL_CHARS = 6000;

/**
 * Готує запит для FTS5 так само, як це робить db.searchSimilarFts():
 * прибираємо все, крім літер і цифр, і склеюємо префіксним АБО.
 * Дублювання свідоме — там метод шукає по всій базі без фільтра по програмі.
 */
function ftsTerms(text) {
  const safe = String(text || "")
    .replace(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9\s]/g, " ")
    .trim();
  if (!safe) return null;
  const terms = safe
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .map((t) => `"${t}"*`);
  return terms.length > 0 ? terms.join(" OR ") : null;
}

/** Обрізає текст статті, чесно позначаючи місце обриву. */
function trim(text, limit) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…(статтю обрізано)`;
}

/**
 * Знаходить програму за ідентифікатором з таблиці apps (bundleId) або,
 * якщо такого немає, за назвою — Spotlight віддає саме id, але CLI і тести
 * зручніше смикати назвою.
 * @param {string} appId
 * @returns {Promise<{id: string, name: string, path: string, keywords: string|null}|null>}
 */
export async function findApp(appId) {
  const value = String(appId || "").trim();
  if (!value) return null;
  return (
    (await db.sqliteDb.get(
      `SELECT id, name, path, keywords FROM apps WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1`,
      [value, value],
    )) || null
  );
}

/**
 * Документація програми під конкретну мету користувача.
 *
 * Порядок джерел:
 *   1. явний docId (його дає Spotlight разом із результатом пошуку);
 *   2. FTS-пошук по чанках цієї програми словами з мети;
 *   3. будь-які статті програми — краще щось, ніж порожній контекст.
 *
 * @param {Object} params
 * @param {{id: string, name: string}} params.app
 * @param {string} params.goal - мета користувача природною мовою.
 * @param {number|null} [params.docId] - id рядка web_documents.
 * @returns {Promise<{docs: Array<{docId, title, content}>, text: string, source: string}>}
 */
export async function loadAppDocs({ app, goal, docId = null }) {
  const collected = [];
  let source = "none";

  if (docId !== null && docId !== undefined && Number.isFinite(Number(docId))) {
    const row = await db.sqliteDb.get(
      `SELECT w.id AS docId, dl.title AS title, w.content AS content
         FROM web_documents w JOIN document_links dl ON dl.id = w.link_id
        WHERE w.id = ?`,
      [Number(docId)],
    );
    if (row && row.content) {
      collected.push(row);
      source = "docId";
    }
  }

  const terms = ftsTerms(goal);
  if (collected.length < MAX_DOCS && terms) {
    const hits = await db.sqliteDb.all(
      `SELECT docId, docTitle, count(*) AS hits
         FROM chunks_fts
        WHERE chunks_fts MATCH ? AND appName = ? AND docId > 0
        GROUP BY docId
        ORDER BY hits DESC
        LIMIT ?`,
      [terms, app.name, MAX_DOCS],
    );
    for (const hit of hits) {
      if (collected.some((d) => d.docId === hit.docId)) continue;
      const row = await db.sqliteDb.get(`SELECT content FROM web_documents WHERE id = ?`, [
        hit.docId,
      ]);
      if (row && row.content) {
        collected.push({
          docId: hit.docId,
          title: hit.docTitle || "Довідка",
          content: row.content,
        });
        if (source === "none") source = "fts";
      }
      if (collected.length >= MAX_DOCS) break;
    }
  }

  if (collected.length === 0) {
    const rows = await db.sqliteDb.all(
      `SELECT w.id AS docId, dl.title AS title, w.content AS content
         FROM document_links dl JOIN web_documents w ON w.link_id = dl.id
        WHERE dl.app_id = ?
        LIMIT ?`,
      [app.id, MAX_DOCS],
    );
    for (const row of rows) if (row.content) collected.push(row);
    if (collected.length > 0) source = "any";
  }

  // Складаємо контекст із запасом по довжині: промпт зору й так великий.
  let total = 0;
  const parts = [];
  for (const doc of collected) {
    if (total >= MAX_TOTAL_CHARS) break;
    const body = trim(doc.content, Math.min(MAX_DOC_CHARS, MAX_TOTAL_CHARS - total));
    total += body.length;
    parts.push(`--- СТАТТЯ «${doc.title || "Довідка"}» ---\n${body}`);
  }

  return {
    docs: collected.map((d) => ({ docId: d.docId, title: d.title || "Довідка" })),
    text: parts.join("\n\n"),
    source,
  };
}
