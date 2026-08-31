/**
 * Файл: src/modules/walkthrough/docs.js
 * Опис: Документація однієї програми для модуля 2.5. Це ЧИТАННЯ бази —
 *       файл-замок такі операції не беруть (див. docs/contracts/rpc.md).
 *
 * ГОЛОВНЕ ПРАВИЛО ЦЬОГО ФАЙЛА: документація береться ТИМ САМИМ пошуком, яким
 * зроблено рекомендацію.
 *
 * Було інакше, і саме це зламало живий прогін. Модуль мав власний
 * повнотекстовий запит по `chunks_fts` словами з мети, відфільтрований за
 * назвою програми і впорядкований за КІЛЬКІСТЮ збігів (`count(*)`). Кількість
 * збігів — це не релевантність: довга стаття, де слово «відео» трапляється
 * дев'ятнадцять разів, перемагала коротку статтю про саме цю дію. Для мети
 * «як обрізати відео» в програмі «Фотографії» перемагав «Експорт фотографій,
 * відео, слайд-шоу та спогадів», і зір чесно вів людину до меню «Файл →
 * Експортувати», бо іншої інструкції в промпті не було.
 *
 * Тепер джерела документації такі:
 *   1. документ, який ПЕРЕДАВ той, хто починає сесію (`docId` або `docTitle`).
 *      Spotlight уже прогнав повний пайплайн `rag/engine.processQuery` —
 *      вектори + FTS + RRF — і на підставі конкретної статті рекомендував
 *      програму. Викидати цей результат і шукати заново означає гарантовано
 *      шукати гірше;
 *   2. якщо не передали — шукаємо самі, але тими самими методами пошуку, що й
 *      `processQuery`: `db.searchSimilar` (вектори) + `db.searchSimilarFts`
 *      (FTS5, BM25) і те саме злиття рангів RRF з k = 60. Запит поєднує мету і
 *      програму, а не самі лише слова мети;
 *   3. якщо не знайшлося нічого — джерела НЕМАЄ. Раніше тут стояв фолбек
 *      «будь-які статті цієї програми — краще щось, ніж порожній контекст».
 *      Це і є мовчазна підміна: людина просить одне, а система показує
 *      сусідню статтю і веде по ній. Чесна відмова краща, тож `matched: false`
 *      і повідомлення, яке можна показати людині.
 *
 * Схему БД і дані ми не змінюємо, лише читаємо вже наявні таблиці:
 *   apps → document_links → web_documents (повний текст статті),
 *   chunks_fts (повнотекстовий пошук по чанках, поле appName).
 */

import { config } from "../../config/config.js";
import { db } from "../../services/db.service.js";
import { ollama } from "../../services/ollama.service.js";

/** Скільки статей документації максимум кладемо в контекст промпта. */
const MAX_DOCS = 3;
/** Скільки символів однієї статті лишаємо. Зір і так має малий контекст. */
const MAX_DOC_CHARS = 2500;
/** Загальна стеля контексту документації. */
const MAX_TOTAL_CHARS = 6000;

/**
 * Константа злиття рангів RRF. Те саме число, що в `rag/engine.js`: результати
 * мають ранжуватись однаково, інакше «той самий пошук» був би тим самим лише
 * на словах.
 */
const RRF_K = 60;

/** Скільки найкращих кандидатів лишаємо в діагностиці й журналі сесії. */
const MAX_CANDIDATES = 5;

/**
 * Скільки чанків беремо з кожного пошуку ДО фільтра по програмі. `topK` з
 * конфіга розрахований на пошук по всій базі («яка програма підійде»), а тут
 * питання вужче («яка стаття ЦІЄЇ програми»), тож вибірку треба брати
 * більшу — інакше після фільтра лишається порожньо.
 */
function searchPool() {
  return Math.max(Number(config.rag?.topK) || 15, 60);
}

/** Обрізає текст статті, чесно позначаючи місце обриву. */
function trim(text, limit) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…(статтю обрізано)`;
}

/** Порівняння назв програм: у чанках лежить `apps.name`, регістр не важливий. */
function sameApp(name, app) {
  const value = String(name || "")
    .trim()
    .toLocaleLowerCase();
  if (!value) return false;
  return value === String(app.name || "").trim().toLocaleLowerCase();
}

/**
 * Запит, яким шукається документація. Поєднує мету і програму: пошук іде по
 * всій базі, і без назви програми в запиті вгору вилазять статті сусідніх
 * програм про те саме («Обрізування фільмів та уривків» у QuickTime Player).
 */
export function buildDocsQuery(goal, appName) {
  return [String(goal || "").trim(), String(appName || "").trim()].filter(Boolean).join(" ");
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

/** Повна стаття за id рядка web_documents. */
async function fetchDocRow(docId) {
  return (
    (await db.sqliteDb.get(
      `SELECT w.id AS docId, dl.title AS title, w.content AS content
         FROM web_documents w JOIN document_links dl ON dl.id = w.link_id
        WHERE w.id = ?`,
      [Number(docId)],
    )) || null
  );
}

/**
 * Стаття цієї програми за НАЗВОЮ. Саме назву показує Spotlight у рядку
 * «З довідки: …», тож це те, що інтерфейс уже тримає в руках і може передати
 * без жодного додаткового запиту до бази.
 *
 * Спершу точний збіг (без урахування регістру), потім збіг за початком назви:
 * заголовок у відповіді може бути обрізаний.
 */
async function fetchDocByTitle(app, title) {
  const value = String(title || "").trim();
  if (!value) return null;

  const exact = await db.sqliteDb.get(
    `SELECT w.id AS docId, dl.title AS title, w.content AS content
       FROM document_links dl JOIN web_documents w ON w.link_id = dl.id
      WHERE dl.app_id = ? AND dl.title = ? COLLATE NOCASE
      LIMIT 1`,
    [app.id, value],
  );
  if (exact) return exact;

  return (
    (await db.sqliteDb.get(
      `SELECT w.id AS docId, dl.title AS title, w.content AS content
         FROM document_links dl JOIN web_documents w ON w.link_id = dl.id
        WHERE dl.app_id = ? AND dl.title LIKE ? COLLATE NOCASE
        ORDER BY length(dl.title) ASC
        LIMIT 1`,
      [app.id, `${value}%`],
    )) || null
  );
}

/**
 * Поріг відстані векторного пошуку. Те саме число, що в `rag/engine.js`: далі
 * за нього збіг вважається випадковим.
 */
const VECTOR_DISTANCE_THRESHOLD = 0.95;

/** Частка слів мети, яку стаття мусить покрити, щоб вважатись «про це». */
const MIN_GOAL_COVERAGE = 0.5;

/** Змістовні слова мети. Дво- і однолітерні службові слова («як», «в») відкидаємо. */
function goalTerms(goal) {
  return [
    ...new Set(
      String(goal || "")
        .toLocaleLowerCase()
        .replace(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2),
    ),
  ];
}

/**
 * Чи це слово тексту — та сама основа, що слово мети.
 *
 * Українська словозміна: «обрізати» в меті й «обрізування» в статті — одне й
 * те саме, але жоден із рядків не є префіксом іншого. Тому крім префікса
 * приймаємо спільний початок у 5+ символів. Це не морфологічний аналіз і не
 * претендує ним бути — це та сама груба відповідність, яку робить FTS5 своїм
 * `"термін"*`, лише симетрична.
 */
function sameRoot(term, word) {
  if (word.startsWith(term) || term.startsWith(word)) return true;
  const max = Math.min(term.length, word.length);
  let i = 0;
  while (i < max && term[i] === word[i]) i += 1;
  return i >= 5;
}

/** Яку частку слів мети покриває текст статті (заголовок + знайдені чанки). */
function goalCoverage(terms, text) {
  if (terms.length === 0) return 1;
  const words = String(text || "")
    .toLocaleLowerCase()
    .replace(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const pool = new Set(words);
  let hit = 0;
  for (const term of terms) {
    for (const word of pool) {
      if (sameRoot(term, word)) {
        hit += 1;
        break;
      }
    }
  }
  return hit / terms.length;
}

/**
 * Пошук статей ЦІЄЇ програми під мету користувача.
 *
 * Своєї логіки пошуку тут немає: викликаються ті самі методи сервісу, що й у
 * `rag/engine.processQuery` — `db.searchSimilar` (LanceDB) і
 * `db.searchSimilarFts` (SQLite FTS5, порядок за BM25 `rank`, а не за
 * кількістю збігів). Тут лишається лише злиття двох списків рангів (RRF з тим
 * самим k = 60), фільтр по програмі, якого в загальному пошуку немає, і поріг
 * придатності.
 *
 * ЧОМУ ДВА РІЗНІ ЗАПИТИ. Векторний пошук фільтра по програмі не має і віддає
 * лише topK по всій базі, тож туди йде запит «мета + програма» — інакше після
 * фільтра не лишається нічого. Повнотекстовому назва програми не потрібна:
 * програму він отримує фільтром, а в самому запиті вона лише псує ранжування
 * (за словом «Photos» угору лізуть «Замовлення професійних відбитків» і
 * «Початок роботи») і, гірше, робить «збіг» там, де жодне слово мети не
 * знайшлось.
 *
 * Режим береться з `config.rag.searchMode`, тобто пошук документації міняється
 * разом із пошуком рекомендації, а не окремо від нього.
 *
 * Відмова однієї з двох гілок — не помилка, а нотатка: без Ollama векторів
 * немає, і тоді лишається FTS. Це прямо той випадок, заради якого існує
 * ручний режим — модуль має працювати, а не падати.
 */
async function searchAppDocs({ app, goal, onProgress = () => {} }) {
  const vectorQuery = buildDocsQuery(goal, app.name);
  const ftsQuery = String(goal || "").trim();
  const limit = searchPool();
  const mode = config.rag?.searchMode || "hybrid";
  const terms = goalTerms(goal);
  const notes = [];
  const used = [];

  /** key → {item, score, distance}: те саме злиття рангів, що в rag/engine.js. */
  const ranked = new Map();
  const fuse = (rows, label) => {
    rows.forEach((row, rank) => {
      const key = `${row.appName}_${row.docId}_${String(row.text || "").substring(0, 20)}`;
      const score = 1 / (RRF_K + rank);
      const existing = ranked.get(key);
      if (existing) existing.score += score;
      else ranked.set(key, { item: row, score, distance: row._distance ?? null });
    });
    used.push(label);
    notes.push(`${label}: ${rows.length} чанків`);
  };

  if (mode !== "fts") {
    try {
      onProgress("Шукаємо документацію: вектор запиту...");
      const vector = await ollama.generateEmbedding(vectorQuery);
      fuse(await db.searchSimilar(vector, limit), "вектори");
    } catch (error) {
      notes.push(`векторний пошук недоступний (${error.message}) — лишається FTS`);
    }
  }
  if (mode !== "vector") {
    try {
      onProgress("Шукаємо документацію: повнотекстовий пошук...");
      fuse(await db.searchSimilarFts(ftsQuery, limit), "FTS");
    } catch (error) {
      notes.push(`повнотекстовий пошук не вдався (${error.message})`);
    }
  }

  // Чанки → статті. Ранг статті = найкращий ранг її чанка: одна влучна
  // цитата важить більше, ніж двадцять згадок слова в довгій статті.
  const byDoc = new Map();
  for (const { item, score, distance } of ranked.values()) {
    const docId = Number(item.docId);
    // docId 0 — метадані програми, -1 — чанк ключових слів; статті за ними немає.
    if (!Number.isFinite(docId) || docId <= 0) continue;
    if (!sameApp(item.appName, app)) continue;
    const previous = byDoc.get(docId);
    if (previous) {
      previous.score = Math.max(previous.score, score);
      if (distance !== null) {
        previous.distance = previous.distance === null ? distance : Math.min(previous.distance, distance);
      }
      if (previous.matchedText.length < 4000) previous.matchedText += ` ${item.text || ""}`;
    } else {
      byDoc.set(docId, {
        docId,
        title: item.docTitle || "Довідка",
        score,
        distance,
        matchedText: `${item.docTitle || ""} ${item.text || ""}`,
      });
    }
  }

  // Поріг придатності. Стаття, яка не покриває й половини слів мети і не
  // близька за вектором, — це сусідня стаття, а не відповідь. Показувати її
  // мовчки гірше, ніж сказати, що інструкції немає.
  const hits = [];
  const rejected = [];
  for (const entry of byDoc.values()) {
    const coverage = goalCoverage(terms, entry.matchedText);
    const nearByVector =
      entry.distance !== null && entry.distance < VECTOR_DISTANCE_THRESHOLD;
    const hit = {
      docId: entry.docId,
      title: entry.title,
      score: entry.score,
      coverage: Math.round(coverage * 100) / 100,
      distance: entry.distance,
    };
    if (coverage >= MIN_GOAL_COVERAGE || nearByVector) hits.push(hit);
    else rejected.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  rejected.sort((a, b) => b.score - a.score);
  if (rejected.length > 0) {
    notes.push(
      `відкинуто як «не про це» (покриття слів мети < ${MIN_GOAL_COVERAGE}): ` +
        rejected
          .slice(0, 3)
          .map((r) => `${r.title} (${r.coverage})`)
          .join(", "),
    );
  }

  return { hits, rejected, notes, query: ftsQuery, vectorQuery, mode, used, terms };
}

/**
 * Документація програми під конкретну мету користувача.
 *
 * @param {Object} params
 * @param {{id: string, name: string}} params.app
 * @param {string} params.goal - мета користувача природною мовою.
 * @param {number|null} [params.docId] - id рядка web_documents від того, хто
 *        починає сесію (Spotlight знайшов цю статтю повним пайплайном).
 * @param {string|null} [params.docTitle] - назва тієї самої статті. Інтерфейс
 *        показує саме її («З довідки: …»), тож передати назву йому дешевше,
 *        ніж id, а результат той самий.
 * @param {Function} [params.onProgress]
 * @returns {Promise<{docs: Array<{docId, title}>, text: string, source: string,
 *          matched: boolean, message: string|null, query: string|null,
 *          candidates: Array<{docId, title, score}>, notes: string[]}>}
 */
export async function loadAppDocs({
  app,
  goal,
  docId = null,
  docTitle = null,
  onProgress = () => {},
}) {
  const collected = [];
  const notes = [];
  let source = "none";
  let query = null;
  let candidates = [];

  // 1. Документ, який уже знайшов той, хто починає сесію.
  if (docId !== null && docId !== undefined && Number.isFinite(Number(docId))) {
    const row = await fetchDocRow(docId);
    if (row && row.content) {
      collected.push(row);
      source = "docId";
      notes.push(`статтю передано з пошуку за docId=${row.docId}`);
    } else {
      notes.push(`переданого docId=${docId} немає в базі — шукаємо самі`);
    }
  }
  if (collected.length === 0 && String(docTitle || "").trim()) {
    const row = await fetchDocByTitle(app, docTitle);
    if (row && row.content) {
      collected.push(row);
      source = "docTitle";
      notes.push(`статтю передано з пошуку за назвою «${row.title}»`);
    } else {
      notes.push(`статті «${docTitle}» немає серед довідки «${app.name}» — шукаємо самі`);
    }
  }

  // 2. Не передали (або передане не знайшлось) — шукаємо самі, тим самим
  //    пошуком, що й рекомендація.
  if (collected.length === 0) {
    const search = await searchAppDocs({ app, goal, onProgress });
    notes.push(...search.notes);
    query = search.query;
    candidates = search.hits.slice(0, MAX_CANDIDATES);
    for (const hit of search.hits) {
      if (collected.length >= MAX_DOCS) break;
      const row = await fetchDocRow(hit.docId);
      if (!row || !row.content) continue;
      collected.push(row);
    }
    if (collected.length > 0) source = search.used.length > 1 ? "hybrid" : search.used[0] || "none";
    if (collected.length === 0 && search.rejected.length > 0) {
      notes.push(
        `знайдено ${search.rejected.length} статей програми, але жодна не про мету — ` +
          `найближча «${search.rejected[0].title}»`,
      );
    }
  }

  // 3. Фолбека «будь-які статті цієї програми» тут більше немає: він і був тією
  //    мовчазною підміною, через яку людину вели сусідньою статтею.
  const matched = collected.length > 0;
  const message = matched
    ? null
    : `У довідці програми «${app.name}» немає статті під мету «${goal}». ` +
      `Вести по сусідній статті було б гірше, ніж сказати це прямо.`;

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
    matched,
    message,
    query,
    candidates,
    notes,
  };
}
