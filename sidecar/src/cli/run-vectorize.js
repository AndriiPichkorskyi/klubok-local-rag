import { runVectorize } from "../modules/indexer/pipeline.js";
import { config } from "../config/config.js";
import { db } from "../services/db.service.js";
import * as p from "@clack/prompts";
import pc from "picocolors";

async function main() {
  await db.init();
  
  const s = p.spinner();
  s.start(pc.cyan(`Векторизація для моделі: ${config.embedModelName}`));
  
  try {
    await runVectorize(msg => s.message(msg));
    s.stop(pc.green(`✅ Завершено векторизацію для: ${config.embedModelName}`));
  } catch (err) {
    s.stop(pc.red(`❌ Помилка векторизації для: ${config.embedModelName}`));
    console.error(err);
    process.exit(1);
  }
}

main().catch(console.error);
