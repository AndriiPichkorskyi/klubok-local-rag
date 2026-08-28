import pLimit from 'p-limit';
/**
 * Файл: src/modules/indexer/pipeline.js
 * Опис: Оркестратор процесу індексування. Координує послідовність дій:
 *       пошук програм -> завантаження документації -> розбиття на чанки та векторизація.
 */

import { db } from "../../services/db.service.js";
import { ollama } from "../../services/ollama.service.js";
import { scraper } from "../../services/scraper.service.js";
import { scanApplications } from "./scanner.js";
import fs from "fs/promises";
import path from "path";
import { chunkText } from "./chunker.js";
import { formatBytes } from "../../utils/format.js";
import { config } from "../../config/config.js";

/**
 * Крок 1: Запускає сканування системних папок, рахує нові знахідки та зберігає їх у базу SQLite.
 *
 * @param {Function} onProgress - Колбек для оновлення тексту в інтерфейсі (спінері).
 * @returns {Promise<number>} - Кількість нових або оновлених програм.
 */
export async function runScanApps(onProgress) {
  onProgress("Пошук інструментів у системних папках...");
  const apps = await scanApplications();

  // Рахуємо скільки нових додатків знайдено
  const existingApps = await db.sqliteDb.all("SELECT id FROM apps");
  const existingIds = new Set(existingApps.map((a) => a.id));

  let newAppsCount = 0;
  for (const app of apps) {
    // bundle_id in db is matched to app.bundleId
    if (!existingIds.has(app.bundleId)) {
      newAppsCount++;
    }
    // We must save/update every app
    await db.saveAppMetadata(app.bundleId, app.name, app.path, "1.0", app.hpdProjectIdentifier, app.helpBookFolder);
  }

  return newAppsCount;
}

/**
 * Крок 2: Завантажує зміст (TOC) та безпосередньо статті довідки Apple для всіх програм,
 *         які мають відповідний ідентифікатор довідки.
 *
 * @param {Function} onProgress - Колбек для виводу кількості мегабайтів і статусу.
 * @returns {Promise<{docsCount: number, mbDownloaded: string}>} - Статистика завантажень.
 */
export async function runFetchDocs(onProgress) {
  const apps = await db.sqliteDb.all(`SELECT * FROM apps WHERE hpd_project_identifier IS NOT NULL`);
  let docsCount = 0;

  scraper.resetSessionStats();

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];

    if (!app.toc_fetched) {
      const mbSoFar = formatBytes(scraper.getSessionBytes());
      onProgress(
        `[${i + 1}/${apps.length}] Завантаження TOC для ${app.name} | Отримано: ${mbSoFar} MB...`,
      );
      const toc = await scraper.getToc(app.hpd_project_identifier);

      for (const page of toc) {
        await db.saveDocumentLink(app.id, page.title, page.url);
      }

      // Відмічаємо, що зміст завантажено (навіть якщо він порожній)
      await db.markTocFetched(app.id);
    } else {
      const mbSoFar = formatBytes(scraper.getSessionBytes());
      onProgress(
        `[${i + 1}/${apps.length}] TOC для ${app.name} вже існує. Отримано: ${mbSoFar} MB...`,
      );
    }

    const pendingLinks = await db.sqliteDb.all(
      `
      SELECT dl.id, dl.uri, dl.title 
      FROM document_links dl
      LEFT JOIN web_documents wd ON dl.id = wd.link_id
      WHERE dl.app_id = ? AND wd.id IS NULL
    `,
      [app.id],
    );

    for (let j = 0; j < pendingLinks.length; j++) {
      const link = pendingLinks[j];
      const mbSoFar = formatBytes(scraper.getSessionBytes());
      onProgress(
        `[${i + 1}/${apps.length}] Додаток ${app.name} | Док ${j + 1}/${pendingLinks.length} | Отримано: ${mbSoFar} MB\nЧитання: ${link.title.substring(0, 40)}...`,
      );

      let rawHtml = await db.getRawHtml(link.id);
      if (!rawHtml) {
        rawHtml = await scraper.fetchRawHtml(link.uri);
        if (rawHtml) {
          await db.saveRawHtml(link.id, rawHtml);
        }
      }

      if (rawHtml) {
        const content = scraper.cleanHtmlContent(rawHtml);
        if (content) {
          await db.saveWebDocument(link.id, content);
          docsCount++;
        }
      }
    }
    
    // Якщо були завантажені нові документи, програму треба перевекторизувати
    if (pendingLinks.length > 0) {
      await db.sqliteDb.run("UPDATE apps SET vectorized_4b = 0, vectorized_0_6b = 0 WHERE id = ?", [app.id]);
    }
  }
  return { docsCount, mbDownloaded: formatBytes(scraper.getSessionBytes()) };
}

/**
 * Крок 3: Читає завантажену документацію з SQLite, розбиває її на чанки,
 *         викликає Ollama для створення ембедингів і зберігає їх у LanceDB.
 *
 * @param {Function} onProgress - Колбек для виводу прогресу чанків і часу.
 * @returns {Promise<number>} - Кількість успішно збережених векторів.
 */
export async function runVectorize(onProgress) {
  const vecCol = config.embedModelName.includes('4b') ? 'vectorized_4b' : 'vectorized_0_6b';
  // Вибираємо тільки ті програми, які ще не були векторизовані
  const apps = await db.sqliteDb.all(
    `SELECT * FROM apps WHERE ${vecCol} = 0 OR ${vecCol} IS NULL`,
  );

  if (apps.length === 0) {
    onProgress("Усі програми вже векторизовані! Немає нових даних.");
    return 0;
  }

  let chunksCount = 0;

  // Розраховуємо приблизну загальну кількість чанків для ETA (тільки для невиконаних програм)
  onProgress("Підрахунок загального об'єму даних для оцінки часу (ETA)...");
  let estimatedTotalChunks = apps.length; // Мінімум 1 чанк (метадані) на програму

  for (const app of apps) {
    const allDocs = await db.sqliteDb.all(
      `SELECT wd.content FROM web_documents wd 
       JOIN document_links dl ON wd.link_id = dl.id 
       WHERE dl.app_id = ?`,
      [app.id],
    );
    for (const doc of allDocs) {
      if (doc.content) {
        estimatedTotalChunks += Math.ceil(doc.content.length / config.indexer.chunkSize);
      }
    }
  }

  const startTime = Date.now();

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    onProgress(`[${i + 1}/${apps.length}] Обробка тексту: ${app.name}`);

    const docs = await db.sqliteDb.all(
      `
      SELECT wd.id as docId, dl.title, wd.content, dl.sourceType 
      FROM document_links dl
      JOIN web_documents wd ON dl.id = wd.link_id
      WHERE dl.app_id = ?
    `,
      [app.id],
    );

    // Додаємо базову інформацію про програму як окремий "документ" (щоб знаходило навіть без довідки)
    docs.push({
      docId: 0,
      title: "App Metadata",
      content: `App Name: ${app.name}\nBundle ID: ${app.id}`,
      sourceType: "META"
    });

    // === DOCUMENT EXPANSION (KEYWORD AUGMENTATION) ===
    if (config.indexer.enableKeywordAugmentation && app.keywords) {
      // Додаємо штучний чанк з ключовими словами для покращення пошуку (FTS + Vector)
      docs.push({
        docId: -1,
        title: "Ключові слова та наміри",
        content: `[НАМІРИ ТА КЛЮЧОВІ СЛОВА]: Програма ${app.name}. Синоніми та задачі: ${app.keywords}`,
        sourceType: "INTENT"
      });
    }

    const vectorsToSave = [];

    for (let d = 0; d < docs.length; d++) {
      const doc = docs[d];
      const textChunks = chunkText(doc.content);
      if (textChunks.length === 0) continue;

      
      const limit = pLimit(config.indexer.concurrency);
      let c = 0;

      const promises = textChunks.map((text) => limit(async () => {
        const currentProcessed = chunksCount + c;
        c++;
        const elapsedSec = (Date.now() - startTime) / 1000;

        let etaStr = "ETA: обчислення...";
        if (currentProcessed > 20) {
          const chunksPerSec = currentProcessed / elapsedSec;
          const remainingChunks = Math.max(0, estimatedTotalChunks - currentProcessed);
          const etaSec = remainingChunks / chunksPerSec;

          if (etaSec > 3600) {
            etaStr = `ETA: ${(etaSec / 3600).toFixed(1)} год`;
          } else if (etaSec > 60) {
            etaStr = `ETA: ${(etaSec / 60).toFixed(1)} хв`;
          } else {
            etaStr = `ETA: ${Math.round(etaSec)} с`;
          }
        }

        onProgress(
          `[${i + 1}/${apps.length}] ${app.name} (Док ${d + 1}/${docs.length}) | Чанк ${c}/${textChunks.length} | Загалом: ${currentProcessed}/~${estimatedTotalChunks} | ${etaStr}`,
        );

        try {
          const vector = await ollama.generateEmbedding(text);
          return {
            vector,
            appName: app.name,
            docId: doc.docId,
            docTitle: doc.title,
            text: text,
          };
        } catch (err) {
          return null;
        }
      }));

      const results = await Promise.all(promises);
      for (const res of results) {
        if (res) vectorsToSave.push(res);
      }
      chunksCount += textChunks.length;
    }

    if (vectorsToSave.length > 0) {
      await db.saveChunks(vectorsToSave);
    }

    // Відмічаємо програму як векторизовану
    await db.sqliteDb.run(`UPDATE apps SET ${vecCol} = 1 WHERE id = ?`, [app.id]);
  }
  return chunksCount;
}

/**
 * Генерує ключові слова для всіх програм, у яких їх ще немає.
 */
export async function runKeywordAugmentation(onProgress) {
  if (!config.indexer.enableKeywordAugmentation) {
    onProgress("Keyword Augmentation вимкнено в конфігурації.");
    return 0;
  }

  const apps = await db.sqliteDb.all(`SELECT * FROM apps WHERE keywords IS NULL`);

  if (apps.length === 0) {
    onProgress("Усі програми вже мають згенеровані ключові слова.");
    return 0;
  }

  const CONCURRENCY = config.indexer.keywordConcurrency;
  const startTime = Date.now();
  let generatedCount = 0;

  const limit = pLimit(CONCURRENCY);
  let currentIndex = 0;
  
  const promises = apps.map((app) => limit(async () => {
    const i = currentIndex++;
    const elapsedSec = (Date.now() - startTime) / 1000;
    let etaStr = "ETA: обчислення...";
    if (i > 0) {
      const appsPerSec = i / elapsedSec;
      const remainingApps = apps.length - i;
      const etaSec = remainingApps / appsPerSec;

      if (etaSec > 3600) {
        etaStr = `ETA: ${(etaSec / 3600).toFixed(1)} год`;
      } else if (etaSec > 60) {
        etaStr = `ETA: ${(etaSec / 60).toFixed(1)} хв`;
      } else {
        etaStr = `ETA: ${Math.round(etaSec)} с`;
      }
    }

    onProgress(`[${i + 1}/${apps.length} | ${etaStr}] AI Наміри: ${app.name}`);

    const docs = await db.sqliteDb.all(
      `SELECT wd.content FROM web_documents wd 
       JOIN document_links dl ON wd.link_id = dl.id 
       WHERE dl.app_id = ? LIMIT 3`,
      [app.id],
    );

    if (docs.length > 0) {
      const contextText = docs
        .map((d) => d.content)
        .join("\n")
        .substring(0, 1500);
      try {
        const generated = await ollama.generateKeywords(app.name, contextText);
        await db.saveAppKeywords(app.id, generated);
        generatedCount++;
      } catch (err) {
        console.error(`Не вдалося згенерувати ключові слова для ${app.name}:`, err.message);
      }
    }
  }));

  await Promise.all(promises);
  return generatedCount;
}
/**
 * Векторизує ТІЛЬКИ наміри (keywords) для всіх програм і зберігає їх у LanceDB.
 * Використовується для точкового оновлення без перевекторизації всієї документації.
 */
export async function runVectorizeIntents(onProgress) {
  if (!config.indexer.enableKeywordAugmentation) {
    onProgress("Keyword Augmentation вимкнено в конфігурації.");
    return 0;
  }

  const apps = await db.sqliteDb.all(`SELECT * FROM apps WHERE keywords IS NOT NULL`);

  if (apps.length === 0) {
    onProgress("Немає програм зі згенерованими ключовими словами.");
    return 0;
  }

  // Видаляємо старі вектори намірів, щоб не було дублікатів
  if (db.table) {
    try {
      await db.table.delete("docId = -1");
    } catch (e) {}
  }
  await db.sqliteDb.exec(`DELETE FROM chunks_fts WHERE docId = -1`);

  const CONCURRENCY = config.indexer.concurrency;
  let chunksCount = 0;
  const vectorsToSave = [];


  const limit = pLimit(CONCURRENCY);
  let currentIndex = 0;
  
  const promises = apps.map((app) => limit(async () => {
    const i = currentIndex++;
    onProgress(`[${i + 1}/${apps.length}] Векторизація намірів: ${app.name}`);

    const text = `[НАМІРИ ТА КЛЮЧОВІ СЛОВА]: Програма ${app.name}. Синоніми та задачі: ${app.keywords}`;
    try {
      const vector = await ollama.generateEmbedding(text);
      return {
        vector: vector,
        appName: app.name,
        docId: -1,
        docTitle: "Ключові слова та наміри",
        text: text,
      };
    } catch (err) {
      return null;
    }
  }));

  const results = await Promise.all(promises);
  for (const res of results) {
    if (res) {
      vectorsToSave.push(res);
      chunksCount++;
    }
  }

  if (vectorsToSave.length > 0) {
    await db.saveChunks(vectorsToSave);
  }

  return chunksCount;
}

async function findLocalHtmlFiles(dir) {
  let results = [];
  try {
    const list = await fs.readdir(dir);
    for (const file of list) {
      const fullPath = path.resolve(dir, file);
      const stat = await fs.stat(fullPath);
      if (stat && stat.isDirectory()) {
        results = results.concat(await findLocalHtmlFiles(fullPath));
      } else if (file.endsWith('.html') || file.endsWith('.htm')) {
        results.push(fullPath);
      }
    }
  } catch (e) {}
  return results;
}

export async function runFetchLocalDocs(onProgress) {
  if (!config.indexer.scanLocalDocs) return { docsCount: 0 };
  
  let docsCount = 0;
  const apps = await db.sqliteDb.all(`SELECT * FROM apps`);
  
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    onProgress(`[LOCAL] [${i + 1}/${apps.length}] Сканування локальної довідки: ${app.name}...`);
    
    // Спробуємо кілька поширених шляхів до локальної документації
    const possiblePaths = [
      path.join(app.path, "Contents", "Resources", "docs"),
      path.join(app.path, "Contents", "Resources", "help"),
      path.join(app.path, "Contents", "Resources", "en.lproj", "docs"),
      path.join(app.path, "Contents", "Resources", "en.lproj", "help")
    ];
    
    if (app.helpBookFolder) {
       possiblePaths.unshift(path.join(app.path, "Contents", "Resources", "uk.lproj", app.helpBookFolder));
       possiblePaths.unshift(path.join(app.path, "Contents", "Resources", "en.lproj", app.helpBookFolder));
       possiblePaths.unshift(path.join(app.path, "Contents", "Resources", app.helpBookFolder));
    }
    
    let htmlFiles = [];
    for (const p of possiblePaths) {
      const files = await findLocalHtmlFiles(p);
      if (files.length > 0) {
        htmlFiles = files;
        break; // Знайшли потрібну папку
      }
    }
    
    if (htmlFiles.length === 0) continue;
    
    // Щоб не перевантажити базу (як у випадку з pgadmin), обмежуємо кількість файлів
    const limit = config.indexer.maxLocalDocsPerApp || 100;
    if (htmlFiles.length > limit) {
       htmlFiles = htmlFiles.slice(0, limit);
    }
    
    for (let j = 0; j < htmlFiles.length; j++) {
       const file = htmlFiles[j];
       const uri = "file://" + file;
       const title = `${app.name} - ${path.basename(file)}`;
       
       onProgress(`[LOCAL] [${i + 1}/${apps.length}] ${app.name} | Файл ${j + 1}/${htmlFiles.length}
Читання: ${path.basename(file)}...`);
       
       // Перевіряємо чи вже є в базі
       const existingLink = await db.sqliteDb.get(`SELECT id FROM document_links WHERE uri = ?`, [uri]);
       if (existingLink) {
          const hasDoc = await db.sqliteDb.get(`SELECT id FROM web_documents WHERE link_id = ?`, [existingLink.id]);
          if (hasDoc) continue; // Вже збережено
       }
       
       try {
         const rawHtml = await fs.readFile(file, "utf8");
         const content = scraper.cleanHtmlContent(rawHtml);
         if (content && content.trim() !== "") {
           const insertLink = await db.sqliteDb.run(
             `INSERT OR IGNORE INTO document_links (app_id, title, uri, sourceType) VALUES (?, ?, ?, 'LOCAL')`,
             [app.id, title, uri]
           );
           
           let linkId = insertLink.lastID;
           if (!linkId || insertLink.changes === 0) {
              const row = await db.sqliteDb.get(`SELECT id FROM document_links WHERE uri = ?`, [uri]);
              linkId = row.id;
           }
           
           await db.saveWebDocument(linkId, content);
           docsCount++;
           // Якщо зберегли новий документ, програму треба перевекторизувати
           await db.sqliteDb.run("UPDATE apps SET vectorized_4b = 0, vectorized_0_6b = 0 WHERE id = ?", [app.id]);
         }
       } catch (err) {
         // console.error(`Помилка читання ${file}`, err.message);
       }
    }
  }
  return { docsCount };
}
