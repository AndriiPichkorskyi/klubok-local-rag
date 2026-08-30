/**
 * Файл: src/cli/diagnose-vision2.js
 * Опис: Другий етап діагностики. Перший показав, що модель, зображення, системний
 *       промпт і проста схема працюють. Отже, причина у відмінностях справжнього
 *       виклику: вкладений об'єкт `box` у схемі та розмір знімка.
 *       Запуск: node sidecar/src/cli/diagnose-vision2.js
 */

import axios from "axios";
import zlib from "zlib";
import { config } from "../config/config.js";
import { VISION_STEP_SCHEMA, STATES } from "../modules/walkthrough/prompts.js";

const base = config.ollama.baseUrl;
const model = config.ollama.visionModel;

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Мінімальний кодувальник PNG: суцільний сірий кадр заданого розміру. */
function makePng(width, height) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const cc = Buffer.alloc(4);
    cc.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, cc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 біт, RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = (x * 7) % 256; raw[p + 1] = (y * 5) % 256; raw[p + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SIMPLE_SCHEMA = {
  type: "object",
  properties: {
    screen_summary: { type: "string" },
    state: { type: "string", enum: ["ready", "unclear"] },
    target_found: { type: "boolean" },
    instruction: { type: "string" },
  },
  required: ["screen_summary", "state", "target_found", "instruction"],
};

async function attempt(label, payload) {
  process.stdout.write(`${label.padEnd(52)}`);
  const started = Date.now();
  try {
    const { data } = await axios.post(`${base}/api/generate`, payload, { timeout: 240000 });
    const text = (data.response || "").replace(/\s+/g, " ");
    console.log(`OK (${((Date.now() - started) / 1000).toFixed(1)}c)  ${text.slice(0, 90)}`);
  } catch (error) {
    const reason = error?.response?.data?.error || error?.response?.data || error.message;
    console.log(`ПОМИЛКА ${error?.response?.status || ""} — ${reason}`);
  }
}

async function main() {
  const big = makePng(1280, 828).toString("base64");
  console.log(`Модель: ${model}`);
  console.log(`Великий кадр: 1280x828, base64 ${Math.round(big.length / 1024)} КБ`);
  console.log(`Справжня схема: ${Object.keys(VISION_STEP_SCHEMA.properties).join(", ")}`);
  console.log(`Станів у enum: ${STATES.length} — ${STATES.join(", ")}\n`);

  const p = "Опиши одним реченням, що зображено.";

  await attempt("A. справжня схема + крихітний кадр", {
    model, prompt: p, images: [TINY_PNG], stream: false, format: VISION_STEP_SCHEMA,
  });
  await attempt("B. проста схема + великий кадр", {
    model, prompt: p, images: [big], stream: false, format: SIMPLE_SCHEMA,
  });
  await attempt("C. лише вкладений об'єкт box", {
    model, prompt: p, images: [TINY_PNG], stream: false,
    format: { type: "object",
      properties: { box: { type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
      required: ["box"] },
  });
  await attempt("D. повний справжній виклик", {
    model, prompt: p, images: [big], stream: false,
    system: "Ти аналізуєш знімок екрана macOS і повертаєш строгий JSON.",
    format: VISION_STEP_SCHEMA, keep_alive: "5m",
    options: { temperature: 0, num_predict: 400 },
  });

  console.log("\nЯкщо A і C впали — винна вкладена схема. Якщо B — розмір кадру.");
}

main().catch((e) => { console.error("Критична помилка:", e.message); process.exit(1); });
