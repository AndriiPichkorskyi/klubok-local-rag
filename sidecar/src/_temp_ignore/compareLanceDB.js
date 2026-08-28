import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function getStats(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { Database: path.basename(dbPath), Status: "Not found", Chunks_Count: 0 };
  }
  try {
    const db = await lancedb.connect(dbPath);
    const tables = await db.tableNames();
    if (tables.length === 0) return { Database: path.basename(dbPath), Status: "Empty (No tables)", Chunks_Count: 0 };
    
    const table = await db.openTable('app_chunks');
    const count = await table.countRows();
    
    return {
      Database: path.basename(dbPath),
      Status: "OK",
      Chunks_Count: count
    };
  } catch(e) {
    return { Database: path.basename(dbPath), Status: "Error", Chunks_Count: e.message };
  }
}

async function run() {
  const db06b = await getStats(path.resolve(__dirname, '../../lancedb_data_qwen3-embedding_0.6b'));
  const db4b = await getStats(path.resolve(__dirname, '../../lancedb_data_qwen3-embedding_4b'));
  
  console.table([db06b, db4b]);
}

run();
