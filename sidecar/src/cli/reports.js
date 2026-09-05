import fs from "fs/promises";
import path from "path";
import pc from "picocolors";
import * as p from "@clack/prompts";
import { config } from "../config/config.js";
import { renderLanguageTables } from "../tests/language.js";

/**
 * Рендерить таблицю зі звітом про тестування RAG.
 * Ця функція є спільною для cli/index.js (при перегляді історії)
 * та test-rag.js (після виконання тестів).
 *
 * @param {Object} reportData - Об'єкт звіту з JSON.
 */
export function renderReportTable(reportData) {
  // Ширина колонки «Режим» рахується від найдовшої назви, а не фіксована:
  // з появою осей systemPrompt і seed назви на кшталт
  // `hybrid+XML|sp=system|seed=1` не влазили в 25 символів і зсували всі
  // наступні колонки. Мінімум лишається старий, щоб вигляд знайомих звітів
  // не змінився.
  const modeNames = Object.keys(reportData.modes || {});
  const MODE_COL = Math.max(25, ...modeNames.map((name) => name.length + 2));
  const RULE = MODE_COL + 138;

  console.log("\n" + "=".repeat(RULE + 5));
  console.log(pc.bold(`📊 ПІДСУМКОВЕ ПОРІВНЯННЯ РЕЖИМІВ (SEARCH MODES):`));
  if (reportData.timestamp) {
    console.log(pc.gray(`📅 Дата звіту: ${new Date(reportData.timestamp).toLocaleString()}`));
  }
  console.log("=".repeat(RULE));
  console.log(
    pc.bold("Режим".padEnd(MODE_COL)) +
      pc.bold("Успішність".padEnd(16)) +
      pc.bold("Час (Заг/Сер)".padEnd(16)) +
      pc.bold("In/Out Токени".padEnd(18)) +
      pc.bold("Швидкість".padEnd(12)) +
      pc.bold("Ollama RAM".padEnd(12)) +
      pc.bold("GPU сер/макс".padEnd(16)) +
      pc.bold("GPU пам'ять".padEnd(14)) +
      pc.bold("Зрізів".padEnd(9)) +
      pc.bold("Energy Impact"),
  );
  console.log("-".repeat(RULE));

  let grandTotalTime = 0;
  let grandTotalInputTokens = 0;
  let grandTotalOutputTokens = 0;
  const totalCases = reportData.totalCases;

  for (const mode of Object.keys(reportData.modes)) {
    const s = reportData.modes[mode].summary;

    grandTotalTime += s.totalTimeMs;
    grandTotalInputTokens += s.totalInputTokens;
    grandTotalOutputTokens += s.totalOutputTokens;

    const avgTime = (s.totalTimeMs / totalCases / 1000).toFixed(1);
    const totalTimeSec = (s.totalTimeMs / 1000).toFixed(1);

    const passRateText = `${s.passRate}% (${s.passed}/${totalCases})`.padEnd(16);
    let passRateStr = passRateText;
    if (s.passRate === 100) passRateStr = pc.green(passRateText);
    else if (s.passRate >= 50) passRateStr = pc.yellow(passRateText);
    else passRateStr = pc.red(passRateText);

    const ramText = Number.isFinite(s.avgSysRam) ? `${Math.round(s.avgSysRam)} MB` : "-";
    const gpuText = Number.isFinite(s.avgSysGpuPercent)
      ? `${s.avgSysGpuPercent.toFixed(1)}%/${Number.isFinite(s.maxSysGpuPercent) ? s.maxSysGpuPercent.toFixed(0) : "-"}%`
      : "-";
    const gpuMemoryText = Number.isFinite(s.avgSysGpuMemoryMB)
      ? `${Math.round(s.avgSysGpuMemoryMB)} MB`
      : "-";
    const sampleText = Number.isFinite(s.sysMetricsSamples) ? String(s.sysMetricsSamples) : "-";
    const powerText = reportData.metrics && Number.isFinite(s.avgSysPower)
      ? s.avgSysPower.toFixed(1)
      : "-";

    console.log(
      mode.padEnd(MODE_COL) +
        passRateStr +
        `${totalTimeSec}c / ${avgTime}c`.padEnd(16) +
        `${s.totalInputTokens} / ${s.totalOutputTokens}`.padEnd(18) +
        `${s.avgTps?.toFixed(1) || "-"} t/s`.padEnd(12) +
        ramText.padEnd(12) +
        gpuText.padEnd(16) +
        gpuMemoryText.padEnd(14) +
        sampleText.padEnd(9) +
        powerText,
    );
  }

  console.log("=".repeat(RULE));
  console.log(pc.bold(`⏱  ЗАГАЛЬНИЙ ЧАС ВСІХ ТЕСТІВ: ${(grandTotalTime / 1000).toFixed(1)} сек`));
  console.log(
    pc.bold(
      `🪙  ЗАГАЛЬНО ТОКЕНІВ: ${grandTotalInputTokens} (Input) / ${grandTotalOutputTokens} (Output)`,
    ),
  );

  // Мовна розбивка друкується тут, а не в тестах: так її видно і при
  // перегляді збереженого звіту з меню CLI, а не лише одразу після прогону.
  if (reportData.languageBreakdown) {
    renderLanguageTables(reportData.languageBreakdown);
  }

  console.log("");
}

/**
 * Логіка для вибору та перегляду існуючих JSON-звітів у CLI.
 */
export async function handleViewReports() {
  // Раніше тут був path.resolve("test-reports") — тека залежала від cwd, тож із
  // будь-якої іншої робочої теки CLI не бачив звітів. Шлях мусить рахуватись від
  // теки даних, як і в RPC-методах reports.*.
  const reportsDir = path.join(config.paths.dataDir, "test-reports");

  let files = [];
  try {
    files = await fs.readdir(reportsDir);
  } catch (err) {
    p.log.warn("Директорія зі звітами не знайдена або порожня.");
    return;
  }

  const jsonFiles = files
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse(); // Новіші зверху

  if (jsonFiles.length === 0) {
    p.log.warn("Жодного звіту (JSON) не знайдено.");
    return;
  }

  const action = await p.select({
    message: "Оберіть звіт для перегляду:",
    options: [
      ...jsonFiles.map((f) => ({ value: f, label: `📄 ${f}` })),
      { value: "back", label: "⬅️ Назад" },
    ],
  });

  if (p.isCancel(action) || action === "back") {
    return;
  }

  const s = p.spinner();
  s.start("Завантаження звіту...");

  try {
    const filePath = path.join(reportsDir, action);
    const content = await fs.readFile(filePath, "utf8");
    const reportData = JSON.parse(content);
    s.stop(`Звіт завантажено: ${action}`);

    renderReportTable(reportData);

    await p.select({
      message: "Натисніть Enter, щоб повернутися до меню",
      options: [{ value: "ok", label: "ОК" }],
    });
  } catch (err) {
    s.stop(pc.red("Помилка читання файлу звіту!"));
    p.log.error(err.message);
  }
}
