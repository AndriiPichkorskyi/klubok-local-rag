// db.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";

export async function getDb() {
  const db = await open({
    filename: "./rag_database.sqlite",
    driver: sqlite3.Database,
  });

  // Вмикаємо підтримку зовнішніх ключів (Foreign Keys)
  await db.exec("PRAGMA foreign_keys = ON;");

  // Таблиця 1: Встановлені програми
  await db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_id TEXT UNIQUE,
      name TEXT,
      path TEXT,
      help_book_folder TEXT,
      hpd_project_identifier TEXT
    )
  `);

  // Таблиця 2: Посилання на документацію (Зміст)
  // uri - це шлях до файлу (для локальної) або URL (для веб)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS document_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER,
      title TEXT,
      source_type TEXT CHECK(source_type IN ('LOCAL', 'WEB')),
      uri TEXT UNIQUE,
      FOREIGN KEY (app_id) REFERENCES applications (id) ON DELETE CASCADE
    )
  `);

  // Таблиця 3: Збережений контент сторінок
  await db.exec(`
    CREATE TABLE IF NOT EXISTS web_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER UNIQUE,
      content TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (link_id) REFERENCES document_links (id) ON DELETE CASCADE
    )
  `);

  return db;
}
