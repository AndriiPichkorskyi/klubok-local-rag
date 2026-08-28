/**
 * Файл: src/services/db.service.js
 * Опис: Сервіс для роботи з базами даних. Керує SQLite (для зберігання метаданих програм
 *       та викачаних веб-документів) та LanceDB (векторна база даних для семантичного пошуку).
 */

import fs from "fs/promises";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import * as lancedb from "@lancedb/lancedb";
import { config } from "../config/config.js";

class DbService {
  constructor() {
    this.sqliteDb = null;
    this.lanceDb = null;
    this.table = null;
    this.tableName = "app_chunks";
  }

  /**
   * Ініціалізує обидві бази даних (створює файли та таблиці, якщо їх немає).
   */
  async init() {
    try {
      // Створюємо директорії, якщо їх немає
      await fs.mkdir("data", { recursive: true });

      // 1. Ініціалізація SQLite (для метаданих та стану індексації)
      this.sqliteDb = await open({
        filename: config.db.sqlitePath,
        driver: sqlite3.Database,
      });

      await this.sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS apps (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          version TEXT,
          hpd_project_identifier TEXT,
          helpBookFolder TEXT,
          lastIndexed DATETIME,
          toc_fetched BOOLEAN DEFAULT 0
        );
        
        CREATE TABLE IF NOT EXISTS document_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_id TEXT,
          title TEXT,
          uri TEXT UNIQUE,
          FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE
        );
        
        CREATE TABLE IF NOT EXISTS web_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          link_id INTEGER UNIQUE,
          content TEXT,
          FOREIGN KEY (link_id) REFERENCES document_links (id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS raw_html (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          link_id INTEGER UNIQUE,
          html TEXT,
          FOREIGN KEY (link_id) REFERENCES document_links (id) ON DELETE CASCADE
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          appName UNINDEXED,
          docId UNINDEXED,
          docTitle,
          text,
          sourceType UNINDEXED
        );
      `);

      // Міграція: додаємо колонку toc_fetched, якщо її немає (для старих баз)
      try {
        await this.sqliteDb.run(`ALTER TABLE apps ADD COLUMN toc_fetched BOOLEAN DEFAULT 0`);
      } catch (err) {
        // Колонка вже існує, ігноруємо помилку
      }

      // Міграція: додаємо специфічні колонки для статусів векторизації під кожну модель
      try {
        await this.sqliteDb.run(`ALTER TABLE apps ADD COLUMN vectorized_4b BOOLEAN DEFAULT 0`);
      } catch (err) {}
      
      try {
        await this.sqliteDb.run(`ALTER TABLE apps ADD COLUMN vectorized_0_6b BOOLEAN DEFAULT 0`);
      } catch (err) {}

      // Міграція: додаємо колонку keywords, якщо її немає (Document Expansion)
      try {
        await this.sqliteDb.run(`ALTER TABLE apps ADD COLUMN keywords TEXT`);
      } catch (err) {
        // Колонка вже існує, ігноруємо помилку
      }
      
      // Міграція: додаємо helpBookFolder
      try {
        await this.sqliteDb.run(`ALTER TABLE apps ADD COLUMN helpBookFolder TEXT`);
      } catch (err) {}
      
      // Міграція: додаємо sourceType
      try {
        await this.sqliteDb.run(`ALTER TABLE document_links ADD COLUMN sourceType TEXT DEFAULT 'WEB'`);
      } catch (err) {}

      // 2. Ініціалізація LanceDB (для векторів)
      this.lanceDb = await lancedb.connect(config.db.lancedbPath);

      // Перевіряємо, чи існує таблиця
      const tableNames = await this.lanceDb.tableNames();

      if (tableNames.includes(this.tableName)) {
        this.table = await this.lanceDb.openTable(this.tableName);
      } else {
        // Створюємо порожню таблицю з правию схемою
        // Зверніть увагу: LanceDB автоматично визначає схему з першого запису,
        // але ми можемо ініціалізувати з порожнім масивом та схемою, якщо потрібно
        // Для простоти, ми створимо її під час першого додавання даних, якщо її немає.
      }
    } catch (error) {
      console.error("Помилка ініціалізації баз даних:", error);
      throw error;
    }
  }

  // Зберегти чанки з векторами в LanceDB
  async saveChunks(chunks) {
    if (chunks.length === 0) return;

    // Зберігаємо в LanceDB (вектори)
    if (!this.table) {
      this.table = await this.lanceDb.createTable(this.tableName, chunks);
    } else {
      const appName = chunks[0]?.appName;
      if (appName) {
         try {
            await this.table.delete(`appName = '${appName.replace(/'/g, "''")}'`);
         } catch (e) {
            console.error('Помилка видалення старих векторів LanceDB:', e);
         }
      }
      await this.table.add(chunks);
    }

    // Зберігаємо в SQLite FTS (чистий текст)
    // Видаляємо попередні чанки для цієї програми, щоб уникнути дублювання
    // при послідовному запуску для 0.6b та 4b
    const appName = chunks[0]?.appName;
    if (appName) {
       await this.sqliteDb.run(`DELETE FROM chunks_fts WHERE appName = ?`, [appName]);
    }
    
    const insertStmt = await this.sqliteDb.prepare(
      `INSERT INTO chunks_fts (appName, docId, docTitle, text, sourceType) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const chunk of chunks) {
      await insertStmt.run([chunk.appName, chunk.docId, chunk.docTitle, chunk.text, chunk.sourceType || 'WEB']);
    }
    await insertStmt.finalize();
  }

  // Пошук найбільш схожих чанків за вектором запиту
  async searchSimilar(queryVector, limit = config.rag.topK, excludeLocal = false) {
    if (!this.table) return [];

    let q = this.table.search(queryVector).limit(limit);
    if (excludeLocal) {
       q = q.where("sourceType != 'LOCAL'");
    }
    
    return await q.toArray();
  }

  // Пошук за допомогою Full-Text Search (SQLite FTS5)
  async searchSimilarFts(queryText, limit = config.rag.topK, excludeLocal = false) {
    // Очищаємо запит для FTS (прибираємо спецсимволи і додаємо * для fuzzy/prefix пошуку)
    const safeQuery = queryText.replace(/[^a-zA-Zа-яА-ЯіІїЇєЄ0-9\s]/g, "").trim();
    if (!safeQuery) return [];

    const terms = safeQuery
      .split(/\s+/)
      .map((t) => `"${t}"*`)
      .join(" OR ");

    let query = `
      SELECT appName, docId, docTitle, text
      FROM chunks_fts 
      WHERE chunks_fts MATCH ? 
    `;
    
    if (excludeLocal) {
      query += ` AND sourceType != 'LOCAL' `;
    }
    
    query += ` ORDER BY rank LIMIT ?`;

    const rows = await this.sqliteDb.all(query, [terms, limit]);
    return rows;
  }

  /**
   * Зберігає або оновлює метадані програми.
   */
  async saveAppMetadata(appId, name, appPath, version, hpd_id, helpBookFolder = null) {
    await this.sqliteDb.run(
      `INSERT INTO apps (id, name, path, version, hpd_project_identifier, helpBookFolder, lastIndexed) 
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET 
         name=excluded.name, 
         path=excluded.path, 
         version=excluded.version, 
         hpd_project_identifier=excluded.hpd_project_identifier, 
         helpBookFolder=excluded.helpBookFolder,
         lastIndexed=excluded.lastIndexed`,
      [appId, name, appPath, version, hpd_id, helpBookFolder, new Date().toISOString()],
    );
  }

  /**
   * Позначає, що зміст (TOC) для програми вже завантажено.
   */
  async markTocFetched(appId) {
    await this.sqliteDb.run(`UPDATE apps SET toc_fetched = 1 WHERE id = ?`, [appId]);
  }

  async saveAppKeywords(appId, keywords) {
    await this.sqliteDb.run(`UPDATE apps SET keywords = ? WHERE id = ?`, [keywords, appId]);
  }

  async saveDocumentLink(appId, title, uri) {
    await this.sqliteDb.run(
      `INSERT OR IGNORE INTO document_links (app_id, title, uri) VALUES (?, ?, ?)`,
      [appId, title, uri],
    );
  }

  /**
   * Отримує повний текст веб-документа за його ID (для Parent Document Retrieval)
   */
  async getWebDocumentById(docId) {
    if (docId === 0) return null; // Це метадані, немає повного документа
    return await this.sqliteDb.get(`SELECT content FROM web_documents WHERE id = ?`, [docId]);
  }

  async saveWebDocument(linkId, content) {
    await this.sqliteDb.run(
      `INSERT OR REPLACE INTO web_documents (link_id, content) VALUES (?, ?)`,
      [linkId, content],
    );
  }

  async saveRawHtml(linkId, html) {
    await this.sqliteDb.run(`INSERT OR IGNORE INTO raw_html (link_id, html) VALUES (?, ?)`, [
      linkId,
      html,
    ]);
  }

  async getRawHtml(linkId) {
    const row = await this.sqliteDb.get(`SELECT html FROM raw_html WHERE link_id = ?`, [linkId]);
    return row ? row.html : null;
  }

  // Очищення специфічних таблиць
  async clearTable(tableName) {
    if (tableName === "lancedb") {
      const tableNames = await this.lanceDb.tableNames();
      if (tableNames.includes(this.tableName)) {
        await this.lanceDb.dropTable(this.tableName);
        this.table = null;
      }
      // Коли видаляємо вектори, також треба видалити текстовий пошуковий індекс (бо він містить ті ж самі чанки)
      await this.sqliteDb.exec(`DELETE FROM chunks_fts`);
      // І скинути прапорець векторизації для всіх програм
      try {
        await this.sqliteDb.exec(`UPDATE apps SET vectorized = 0`);
      } catch (e) {}
    } else {
      await this.sqliteDb.exec(`DELETE FROM ${tableName}`);
    }
  }

  // Очищення баз даних
  async clearAll() {
    await this.clearTable("apps");
    await this.clearTable("document_links");
    await this.clearTable("web_documents");
    await this.clearTable("lancedb");
  }

  // Очистити лише наміри та ключові слова
  
  async clearDocumentsByType(type) {
    if (type !== 'WEB' && type !== 'LOCAL') return;
    
    // 1. Знаходимо всі програми, які будуть зачеплені
    const appsToUpdate = await this.sqliteDb.all(`
      SELECT DISTINCT app_id FROM document_links WHERE sourceType = ?
    `, [type]);
    
    // 2. Скидаємо їм прапорці векторизації
    for (const app of appsToUpdate) {
      await this.sqliteDb.run("UPDATE apps SET vectorized_4b = 0, vectorized_0_6b = 0 WHERE id = ?", [app.app_id]);
    }
    
    // 3. Видаляємо з FTS та LanceDB
    await this.sqliteDb.run("DELETE FROM chunks_fts WHERE sourceType = ?", [type]);
    if (this.table) {
      try {
        await this.table.delete(`sourceType = '${type}'`);
      } catch (e) {
        console.error("LanceDB delete error:", e.message);
      }
    }
    
    // 4. Видаляємо зв'язані web_documents та document_links
    await this.sqliteDb.run(`
      DELETE FROM web_documents WHERE link_id IN (
        SELECT id FROM document_links WHERE sourceType = ?
      )
    `, [type]);
    await this.sqliteDb.run("DELETE FROM document_links WHERE sourceType = ?", [type]);
  }

  async clearIntents() {
    if (this.table) {
      try {
        await this.table.delete("docId = -1");
      } catch (e) {}
    }
    await this.sqliteDb.exec(`DELETE FROM chunks_fts WHERE docId = -1`);
    await this.sqliteDb.exec(`UPDATE apps SET keywords = NULL`);
  }

  // Отримати статистику
  async getStats() {
    const appsCount = await this.sqliteDb.get("SELECT COUNT(*) as count FROM apps");
    let chunksCount = 0;

    if (this.table) {
      chunksCount = await this.table.countRows();
    }

    return {
      appsCount: appsCount.count,
      chunksCount: chunksCount,
    };
  }
}

export const db = new DbService();
