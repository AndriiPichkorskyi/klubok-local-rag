const lancedb = require('vectordb');
const path = require('path');
const fs = require('fs');

async function getStats(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { name: path.basename(dbPath), status: "Not found" };
  }
  try {
    const db = await lancedb.connect(dbPath);
    const tables = await db.tableNames();
    if (tables.length === 0) return { name: path.basename(dbPath), status: "Empty (No tables)" };
    
    const table = await db.openTable('app_chunks');
    const count = await table.countRows();
    
    // Get dimension of the vector
    const schema = await table.schema;
    const vectorField = schema.fields.find(f => f.name === 'vector');
    const dimension = vectorField ? vectorField.type.listSize : 'Unknown';

    return {
      name: path.basename(dbPath),
      status: "OK",
      rows: count,
      vectorDimension: dimension
    };
  } catch(e) {
    return { name: path.basename(dbPath), status: "Error", error: e.message };
  }
}

async function run() {
  const db06b = await getStats(path.join(__dirname, '../../lancedb_data_qwen3-embedding_0.6b'));
  const db4b = await getStats(path.join(__dirname, '../../lancedb_data_qwen3-embedding_4b'));
  
  console.table([db06b, db4b]);
}

run();
