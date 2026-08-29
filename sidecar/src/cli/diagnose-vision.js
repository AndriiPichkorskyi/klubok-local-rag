/**
 * Файл: src/cli/diagnose-vision.js
 * Опис: Ізолює причину відмови vision-моделі. Надсилає до Ollama кілька запитів,
 *       додаючи по одній складовій за раз, і показує, на якій саме з'являється помилка.
 *       Запуск: node sidecar/src/cli/diagnose-vision.js
 */

import axios from "axios";
import { config } from "../config/config.js";

/** Найменший валідний PNG: 1×1 піксель. Потрібен лише щоб перевірити канал зображень. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SCHEMA = {
  type: "object",
  properties: {
    screen_summary: { type: "string" },
    state: { type: "string", enum: ["ready", "unclear"] },
    target_found: { type: "boolean" },
    instruction: { type: "string" },
  },
  required: ["screen_summary", "state", "target_found", "instruction"],
};

const base = config.ollama.baseUrl;
const model = config.ollama.visionModel;

async function attempt(label, payload) {
  process.stdout.write(`${label.padEnd(46)}`);
  try {
    const { data } = await axios.post(`${base}/api/generate`, payload, { timeout: 180000 });
    const text = (data.response || "").replace(/\s+/g, " ").slice(0, 60);
    console.log(`OK   ${text}`);
    return true;
  } catch (error) {
    const reason = error?.response?.data?.error || error?.response?.data || error.message;
    console.log(`ПОМИЛКА ${error?.response?.status || ""} — ${reason}`);
    return false;
  }
}

async function main() {
  console.log(`Ollama : ${base}`);
  console.log(`Модель : ${model}\n`);

  try {
    const { data } = await axios.get(`${base}/api/tags`, { timeout: 5000 });
    const names = (data.models || []).map((m) => m.name);
    const found = names.includes(model);
    console.log(`Модель у списку встановлених: ${found ? "так" : "НІ"}`);
    if (!found) {
      const similar = names.filter((n) => n.includes("vl") || n.includes("vision") || n.includes("llava"));
      console.log(`  Схожі назви: ${similar.length ? similar.join(", ") : "жодної"}`);
      console.log(`  Усього моделей: ${names.length}\n`);
    } else {
      console.log("");
    }
  } catch (error) {
    console.log(`Не вдалося отримати список моделей: ${error.message}\n`);
  }

  const prompt = "Опиши одним реченням, що зображено.";

  // Додаємо по одній складовій. Перша помилка і є причиною.
  await attempt("1. лише текст, без зображення", { model, prompt, stream: false });
  await attempt("2. + зображення", { model, prompt, images: [TINY_PNG], stream: false });
  await attempt("3. + системний промпт", {
    model, prompt, images: [TINY_PNG], stream: false, system: "Ти аналізуєш знімки екрана.",
  });
  await attempt("4. + format: json", {
    model, prompt, images: [TINY_PNG], stream: false, format: "json",
  });
  await attempt("5. + format: схема (як у walkthrough)", {
    model, prompt, images: [TINY_PNG], stream: false, format: SCHEMA,
  });
  await attempt("6. + options і keep_alive (повний payload)", {
    model, prompt, images: [TINY_PNG], stream: false,
    system: "Ти аналізуєш знімки екрана.",
    format: SCHEMA, keep_alive: "5m",
    options: { temperature: 0, num_predict: 400 },
  });

  console.log("\nПерший рядок з помилкою і є причиною. Надішліть цей вивід.");
}

main().catch((error) => {
  console.error("Критична помилка:", error.message);
  process.exit(1);
});
