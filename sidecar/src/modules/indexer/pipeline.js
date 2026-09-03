import pLimit from "p-limit";
/**
 * Файл: src/modules/indexer/pipeline.js
 * Опис: Оркестратор процесу індексування. Координує послідовність дій:
 *       пошук програм -> завантаження документації -> розбиття на чанки та векторизація.
 */

import { db, vectorizedColumnFor } from "../../services/db.service.js";
import { ollama } from "../../services/ollama.service.js";
import { scraper } from "../../services/scraper.service.js";
import { scanApplications } from "./scanner.js";
import fs from "fs/promises";
import path from "path";
import { chunkText } from "./chunker.js";
import { formatBytes } from "../../utils/format.js";
import { config } from "../../config/config.js";

/**
 * Кооперативне скасування довгих операцій.
 * Пайплайн НЕ кидає помилку через сигнал: цикли перевіряють його між
 * ітераціями і виходять, повертаючи те, що вже встигли зробити. Помилка —
 * це збій, скасування — намір користувача, і плутати їх не можна.
 *
 * @param {AbortSignal|null|undefined} signal - сигнал скасування або нічого.
 * @returns {boolean}
 */
function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

/**
 * Крок 1: Запускає сканування системних папок, рахує нові знахідки та зберігає їх у базу SQLite.
 *
 * @param {Function} onProgress - Колбек для оновлення тексту в інтерфейсі (спінері).
 * @param {AbortSignal} [signal] - Необов'язковий сигнал скасування (RPC job.cancel).
 * @returns {Promise<number>} - Кількість нових або оновлених програм.
 */
export async function runScanApps(onProgress, signal = null) {
  // Запис у базу — тільки під файлом-замком: паралельні процеси
  // дублювали чанки і витісняли документацію (docs/improvements.md).
  return await db.withWriteLock("runScanApps", () => runScanAppsLocked(onProgress, signal));
}

async function runScanAppsLocked(onProgress, signal = null) {
  onProgress("Пошук інструментів у системних папках...");
  if (isAborted(signal)) return 0;
  const apps = await scanApplications(undefined, onProgress);

  // Рахуємо скільки нових додатків знайдено
  const existingApps = await db.sqliteDb.all("SELECT id FROM apps");
  const existingIds = new Set(existingApps.map((a) => a.id));

  let newAppsCount = 0;
  for (const app of apps) {
    // Скасування перевіряємо між програмами, а не посеред запису в БД.
    if (isAborted(signal)) {
      onProgress("Скасовано: сканування зупинено користувачем.");
      break;
    }
    // bundle_id in db is matched to app.bundleId
    if (!existingIds.has(app.bundleId)) {
      newAppsCount++;
    }
    // We must save/update every app
    await db.saveAppMetadata(
      app.bundleId,
      app.name,
      app.path,
      "1.0",
      app.hpdProjectIdentifier,
      app.helpBookFolder,
    );
  }

  return newAppsCount;
}

/**
 * Крок 2: Завантажує зміст (TOC) та безпосередньо статті довідки Apple для всіх програм,
 *         які мають відповідний ідентифікатор довідки.
 *
 * @param {Function} onProgress - Колбек для виводу кількості мегабайтів і статусу.
 * @param {AbortSignal} [signal] - Необов'язковий сигнал скасування (RPC job.cancel).
 * @returns {Promise<{docsCount: number, mbDownloaded: string}>} - Статистика завантажень.
 */
export async function runFetchDocs(onProgress, signal = null) {
  // Запис у базу — тільки під файлом-замком: паралельні процеси
  // дублювали чанки і витісняли документацію (docs/improvements.md).
  return await db.withWriteLock("runFetchDocs", () => runFetchDocsLocked(onProgress, signal));
}

async function runFetchDocsLocked(onProgress, signal = null) {
  const apps = await db.sqliteDb.all(`SELECT * FROM apps WHERE hpd_project_identifier IS NOT NULL`);
  let docsCount = 0;

  scraper.resetSessionStats();

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];

    // Скасування між програмами: усе завантажене й збережене лишається в базі.
    if (isAborted(signal)) {
      onProgress("Скасовано: завантаження документації зупинено користувачем.");
      break;
    }

    if (!app.toc_fetched) {
      const mbSoFar = formatBytes(scraper.getSessionBytes());
      onProgress(
        `[${i + 1}/${apps.length}] Завантаження TOC для ${app.name} | Отримано: ${mbSoFar} MB...`,
      );
      const toc = await scraper.getToc(app.hpd_project_identifier, signal);

      // Обірваний сигналом запит віддає порожній TOC. Позначити його
      // завантаженим було б брехнею: програма назавжди лишилась би без довідки.
      if (isAborted(signal)) {
        onProgress("Скасовано: завантаження TOC перервано, зміст не позначено завантаженим.");
        break;
      }

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

    let interrupted = false;
    for (let j = 0; j < pendingLinks.length; j++) {
      if (isAborted(signal)) {
        interrupted = true;
        break;
      }
      const link = pendingLinks[j];
      const mbSoFar = formatBytes(scraper.getSessionBytes());
      onProgress(
        `[${i + 1}/${apps.length}] Додаток ${app.name} | Док ${j + 1}/${pendingLinks.length} | Отримано: ${mbSoFar} MB\nЧитання: ${link.title.substring(0, 40)}...`,
      );

      let rawHtml = await db.getRawHtml(link.id);
      if (!rawHtml) {
        rawHtml = await scraper.fetchRawHtml(link.uri, signal);
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
      await db.resetVectorizedFlags([app.id]);
    }

    // Прапорці скинуто — тільки тепер вихід з циклу лишає базу узгодженою.
    if (interrupted) {
      onProgress("Скасовано: завантаження документації зупинено користувачем.");
      break;
    }
  }
  return { docsCount, mbDownloaded: formatBytes(scraper.getSessionBytes()) };
}

/**
 * Крок 3: Читає завантажену документацію з SQLite, розбиває її на чанки,
 *         викликає Ollama для створення ембедингів і зберігає їх у LanceDB.
 *
 * @param {Function} onProgress - Колбек для виводу прогресу чанків і часу.
 * @param {AbortSignal} [signal] - Необов'язковий сигнал скасування (RPC job.cancel).
 * @returns {Promise<number>} - Кількість успішно збережених векторів.
 */
export async function runVectorize(onProgress, signal = null) {
  // Запис у базу — тільки під файлом-замком: паралельні процеси
  // дублювали чанки і витісняли документацію (docs/improvements.md).
  return await db.withWriteLock("runVectorize", () => runVectorizeLocked(onProgress, signal));
}

async function runVectorizeLocked(onProgress, signal = null) {
  const vecCol = vectorizedColumnFor(config.embedModelName);
  await db.addColumnIfMissing("apps", `${vecCol} BOOLEAN DEFAULT 0`);
  // Вибираємо тільки ті програми, які ще не були векторизовані
  const apps = await db.sqliteDb.all(`SELECT * FROM apps WHERE ${vecCol} = 0 OR ${vecCol} IS NULL`);

  if (apps.length === 0) {
    onProgress("Усі програми вже векторизовані! Немає нових даних.");
    return 0;
  }

  let chunksCount = 0;

  // Розраховуємо приблизну загальну кількість чанків для ETA (тільки для невиконаних програм)
  onProgress("Підрахунок загального об'єму даних для оцінки часу (ETA)...");
  let estimatedTotalChunks = apps.length; // Мінімум 1 чанк (метадані) на програму

  for (const app of apps) {
    if (isAborted(signal)) return 0;
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
    if (isAborted(signal)) {
      onProgress(`Скасовано: векторизацію зупинено, оброблено ${i} з ${apps.length} програм.`);
      break;
    }
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
      sourceType: "META",
    });

    // === DOCUMENT EXPANSION (KEYWORD AUGMENTATION) ===
    if (config.indexer.enableKeywordAugmentation && app.keywords) {
      // Додаємо штучний чанк з ключовими словами для покращення пошуку (FTS + Vector)
      docs.push({
        docId: -1,
        title: "Ключові слова та наміри",
        content: `[НАМІРИ ТА КЛЮЧОВІ СЛОВА]: Програма ${app.name}. Синоніми та задачі: ${app.keywords}`,
        sourceType: "INTENT",
      });
    }

    const vectorsToSave = [];
    let attemptedChunks = 0; // скільки чанків цієї програми пішло на ембединг
    let embedFailures = 0; // скільки з них не вдалося векторизувати

    // Чи обірвали програму посеред обробки: тоді ні чанків, ні прапорця.
    let appInterrupted = false;

    for (let d = 0; d < docs.length; d++) {
      if (isAborted(signal)) {
        appInterrupted = true;
        break;
      }
      const doc = docs[d];
      const textChunks = chunkText(doc.content);
      if (textChunks.length === 0) continue;

      const limit = pLimit(config.indexer.concurrency);
      let c = 0;

      const promises = textChunks.map((text) =>
        limit(async () => {
          // Скасування: завдання з черги миттєво завершуються порожнім
          // результатом. limit.clearQueue() тут не можна — p-limit лишає
          // промайси скинутих завдань нерозв'язаними, і Promise.all зависає.
          if (isAborted(signal)) return null;
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
              // Тип джерела (WEB/LOCAL/META/INTENT) береться з документа;
              // без цього поля saveChunks писав усім чанкам 'WEB'
              sourceType: doc.sourceType || "WEB",
            };
          } catch (err) {
            embedFailures++;
            console.error(`Не вдалося створити ембединг (${app.name}): ${err.message}`);
            return null;
          }
        }),
      );

      const results = await Promise.all(promises);
      if (isAborted(signal)) {
        appInterrupted = true;
        break;
      }
      for (const res of results) {
        if (res) vectorsToSave.push(res);
      }
      chunksCount += textChunks.length;
      attemptedChunks += textChunks.length;
    }

    // Програму обірвали посеред обробки. Часткові вектори не зберігаємо
    // (saveChunks замінює всі чанки програми) і прапорець не ставимо —
    // інакше програма мовчки лишилась би недовекторизованою назавжди.
    if (appInterrupted) {
      onProgress(
        `Скасовано: ${app.name} оброблено частково, зміни цієї програми не збережено. ` +
          `Готових програм: ${i}/${apps.length}.`,
      );
      break;
    }

    if (vectorsToSave.length > 0) {
      await db.saveChunks(vectorsToSave);
    }

    // Відмічаємо програму як векторизовану. Якщо чанки були, але жоден не
    // вдалося векторизувати (напр. Ollama впала), прапорець не ставимо —
    // інакше програма мовчки лишиться без векторів назавжди.
    if (attemptedChunks > 0 && vectorsToSave.length === 0) {
      onProgress(
        `[${i + 1}/${apps.length}] ${app.name}: жоден чанк не векторизовано (помилок: ${embedFailures}), прапорець не встановлено`,
      );
    } else {
      await db.sqliteDb.run(`UPDATE apps SET ${vecCol} = 1 WHERE id = ?`, [app.id]);
    }
  }
  return chunksCount;
}

/**
 * Генерує ключові слова для всіх програм, у яких їх ще немає.
 *
 * @param {Function} onProgress - Колбек прогресу.
 * @param {AbortSignal} [signal] - Необов'язковий сигнал скасування (RPC job.cancel).
 * @returns {Promise<number>} - Скільки програм отримали ключові слова.
 */
export async function runKeywordAugmentation(onProgress, signal = null) {
  // Запис у базу — тільки під файлом-замком: паралельні процеси
  // дублювали чанки і витісняли документацію (docs/improvements.md).
  return await db.withWriteLock("runKeywordAugmentation", () =>
    runKeywordAugmentationLocked(onProgress, signal),
  );
}

async function runKeywordAugmentationLocked(onProgress, signal = null) {
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

  const promises = apps.map((app) =>
    limit(async () => {
      // Скасування: решта черги миттєво «проїжджає» вхолосту; ключові слова
      // вже оброблених програм лишаються збереженими.
      if (isAborted(signal)) return;
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
    }),
  );

  await Promise.all(promises);
  if (isAborted(signal)) {
    onProgress(`Скасовано: згенеровано ключові слова для ${generatedCount} програм.`);
  }
  return generatedCount;
}
/**
 * Векторизує ТІЛЬКИ наміри (keywords) для всіх програм і зберігає їх у LanceDB.
 * Використовується для точкового оновлення без перевекторизації всієї документації.
 *
 * @param {Function} onProgress - Колбек прогресу.
 * @param {AbortSignal} [signal] - Необов'язковий сигнал скасування (RPC job.cancel).
 * @returns {Promise<number>} - Кількість збережених чанків намірів.
 */
export async function runVectorizeIntents(onProgress, signal = null) {
  // Запис у базу — тільки під файлом-замком: паралельні процеси
  // дублювали чанки і витісняли документацію (docs/improvements.md).
  return await db.withWriteLock("runVectorizeIntents", () =>
    runVectorizeIntentsLocked(onProgress, signal),
  );
}

async function runVectorizeIntentsLocked(onProgress, signal = null) {
  if (!config.indexer.enableKeywordAugmentation) {
    onProgress("Keyword Augmentation вимкнено в конфігурації.");
    return 0;
  }

  const apps = await db.sqliteDb.all(`SELECT * FROM apps WHERE keywords IS NOT NULL`);

  if (apps.length === 0) {
    onProgress("Немає програм зі згенерованими ключовими словами.");
    return 0;
  }

  // Скасування перевіряємо ДО видалення: після clearIntentChunks() база
  // лишається без намірів, тому вихід можливий тільки зі збереженням того,
  // що встигли порахувати.
  if (isAborted(signal)) {
    onProgress("Скасовано: векторизацію намірів не розпочато.");
    return 0;
  }

  // Видаляємо старі вектори намірів, щоб не було дублікатів: із LanceDB
  // поточної моделі та зі спільної для всіх моделей chunks_ґ.
  await db.clearIntentChunks();

  const CONCURRENCY = config.indexer.concurrency;
  let chunksCount = 0;
  const vectorsToSave = [];

  const limit = pLimit(CONCURRENCY);
  let currentIndex = 0;

  const promises = apps.map((app) =>
    limit(async () => {
      if (isAborted(signal)) return null;
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
          sourceType: "INTENT",
        };
      } catch (err) {
        console.error(`Не вдалося векторизувати наміри (${app.name}): ${err.message}`);
        return null;
      }
    }),
  );

  const results = await Promise.all(promises);
  for (const res of results) {
    if (res) {
      vectorsToSave.push(res);
      chunksCount++;
    }
  }

  if (vectorsToSave.length > 0) {
    // У пакеті наміри багатьох програм, тому saveChunks не має видаляти
    // наявні чанки документації (старі наміри вже видалені вище).
    // Часткові наміри зберігаємо навіть при скасуванні: старі вже видалено,
    // і викинути ще й нові означало б лишити базу зовсім без намірів.
    await db.saveChunks(vectorsToSave, { replaceAppChunks: false });
  }

  if (isAborted(signal)) {
    onProgress(`Скасовано: збережено ${chunksCount} з ${apps.length} чанків намірів.`);
  }

  return chunksCount;
}

/**
 * Збирає html-файли довідки в теці.
 * Використовує вбудований рекурсивний обхід fs.readdir, який НЕ йде за
 * symlink-ами. Попередня власна рекурсія через fs.stat йшла за посиланнями
 * і без ліміту глибини — усередині .app-пакетів це давало нескінченний цикл.
 */
async function findLocalHtmlFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
      .map((entry) => path.join(entry.parentPath ?? entry.path ?? dir, entry.name));
  } catch (e) {
    // Теки немає або немає доступу — для кандидата це нормально
    return [];
  }
}

/**
 * Збирає локальну довідку (.html усередині пакетів програм) у базу.
 *
 * @param {Function} onProgress - Колбек прогресу.
 * @param {AbortSignal} [signal] - Необов'язковий сигнал скасування (RPC job.cancel).
 * @returns {Promise<{docsCount: number}>}
 */
export async function runFetchLocalDocs(onProgress, signal = null) {
  // Запис у базу — тільки під файлом-замком: паралельні процеси
  // дублювали чанки і витісняли документацію (docs/improvements.md).
  return await db.withWriteLock("runFetchLocalDocs", () =>
    runFetchLocalDocsLocked(onProgress, signal),
  );
}

async function runFetchLocalDocsLocked(onProgress, signal = null) {
  if (!config.indexer.scanLocalDocs) return { docsCount: 0 };

  let docsCount = 0;
  const apps = await db.sqliteDb.all(`SELECT * FROM apps`);

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    if (isAborted(signal)) {
      onProgress("Скасовано: сканування локальної довідки зупинено користувачем.");
      break;
    }
    onProgress(`[LOCAL] [${i + 1}/${apps.length}] Сканування локальної довідки: ${app.name}...`);

    // Спробуємо кілька поширених шляхів до локальної документації
    const possiblePaths = [
      path.join(app.path, "Contents", "Resources", "docs"),
      path.join(app.path, "Contents", "Resources", "help"),
      path.join(app.path, "Contents", "Resources", "en.lproj", "docs"),
      path.join(app.path, "Contents", "Resources", "en.lproj", "help"),
    ];

    if (app.helpBookFolder) {
      possiblePaths.unshift(
        path.join(app.path, "Contents", "Resources", "uk.lproj", app.helpBookFolder),
      );
      possiblePaths.unshift(
        path.join(app.path, "Contents", "Resources", "en.lproj", app.helpBookFolder),
      );
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

    let interrupted = false;
    for (let j = 0; j < htmlFiles.length; j++) {
      if (isAborted(signal)) {
        interrupted = true;
        break;
      }
      const file = htmlFiles[j];
      const uri = "file://" + file;
      const title = `${app.name} - ${path.basename(file)}`;

      onProgress(`[LOCAL] [${i + 1}/${apps.length}] ${app.name} | Файл ${j + 1}/${htmlFiles.length}
Читання: ${path.basename(file)}...`);

      // Перевіряємо чи вже є в базі
      const existingLink = await db.sqliteDb.get(`SELECT id FROM document_links WHERE uri = ?`, [
        uri,
      ]);
      if (existingLink) {
        const hasDoc = await db.sqliteDb.get(`SELECT id FROM web_documents WHERE link_id = ?`, [
          existingLink.id,
        ]);
        if (hasDoc) continue; // Вже збережено
      }

      try {
        const rawHtml = await fs.readFile(file, "utf8");
        const content = scraper.cleanHtmlContent(rawHtml);
        if (content && content.trim() !== "") {
          const insertLink = await db.sqliteDb.run(
            `INSERT OR IGNORE INTO document_links (app_id, title, uri, sourceType) VALUES (?, ?, ?, 'LOCAL')`,
            [app.id, title, uri],
          );

          let linkId = insertLink.lastID;
          if (!linkId || insertLink.changes === 0) {
            const row = await db.sqliteDb.get(`SELECT id FROM document_links WHERE uri = ?`, [uri]);
            linkId = row.id;
          }

          await db.saveWebDocument(linkId, content);
          docsCount++;
          // Якщо зберегли новий документ, програму треба перевекторизувати
          await db.resetVectorizedFlags([app.id]);
        }
      } catch (err) {
        // console.error(`Помилка читання ${file}`, err.message);
      }
    }

    if (interrupted) {
      onProgress("Скасовано: сканування локальної довідки зупинено користувачем.");
      break;
    }
  }
  return { docsCount };
}
