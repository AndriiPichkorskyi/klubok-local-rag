/**
 * Файл: sidecar/src/config/config.js
 * Опис: Завантажує налаштування з єдиного конфіга config/pipeline.config.json
 *       у корені проєкта і формує об'єкт `config` тієї ж форми, що й раніше,
 *       щоб решта модулів не змінювалась.
 *
 * Пріоритет значень: змінна оточення > pipeline.config.json > дефолт у коді.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Корінь sidecar (тут лежать rag_metadata.sqlite та lancedb_data_*) */
const SIDECAR_DIR = path.resolve(__dirname, "../../");
/** Корінь усього проєкта (тут лежить папка config/) */
const PROJECT_DIR = path.resolve(__dirname, "../../../");

export const CONFIG_PATH =
  process.env.PIPELINE_CONFIG || path.join(PROJECT_DIR, "config", "pipeline.config.json");

/** Читає JSON-конфіг з диска. Кидає зрозумілу помилку, якщо файл зламаний. */
function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(
      `Не вдалося прочитати конфіг ${CONFIG_PATH}: ${error.message}\n` +
        `Перевірте, що файл існує і містить валідний JSON.`,
    );
  }
}

/** Збирає робочий об'єкт конфіга з файлу + змінних оточення. */
export function buildConfig() {
  const file = readConfigFile();
  const embedModel = process.env.EMBED_MODEL || file.embedModelName;

  const configObj = {
    embedModelName: embedModel,
    embedModels: [
      ...new Set([embedModel, ...(Array.isArray(file.embedModels) ? file.embedModels : [])]),
    ],
    db: {
      sqlitePath: path.join(SIDECAR_DIR, "rag_metadata.sqlite"),
      get lancedbPath() {
        return path.join(SIDECAR_DIR, `lancedb_data_${configObj.embedModelName.replace(":", "_")}`);
      },
    },
    ollama: {
      ...file.ollama,
      get embedModel() {
        return configObj.embedModelName;
      },
    },
    rpc: {
      ...file.rpc,
      port: Number(process.env.RPC_PORT || file.rpc.port),
    },
    logging: {
      enabled: file.logging?.enabled !== false,
      ...file.logging,
    },
    scraper: file.scraper,
    indexer: file.indexer,
    rag: file.rag,
    bootstrap: file.bootstrap,
    walkthrough: file.walkthrough,
    paths: { sidecarDir: SIDECAR_DIR, projectDir: PROJECT_DIR, configPath: CONFIG_PATH },
  };
  
  return configObj;
}

export let config = buildConfig();

/**
 * Перечитує конфіг з диска без перезапуску процесу.
 * Викликається з Dev Panel кнопкою «Перечитати config».
 */
export function reloadConfig() {
  const next = buildConfig();
  Object.keys(config).forEach((key) => delete config[key]);
  Object.assign(config, next);
  return config;
}

/**
 * Оновлює моделі у файлі конфігурації та перезавантажує конфіг.
 */
export function updateModels({ embedModel, chatModel, visionModel }) {
  const current = readConfigFile();
  let changed = false;

  if (embedModel && current.embedModelName !== embedModel) {
    current.embedModelName = embedModel;
    changed = true;
  }
  if (chatModel && current.ollama.chatModel !== chatModel) {
    current.ollama.chatModel = chatModel;
    changed = true;
  }
  if (visionModel && current.ollama.visionModel !== visionModel) {
    current.ollama.visionModel = visionModel;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
    reloadConfig();
  }
  return config;
}
