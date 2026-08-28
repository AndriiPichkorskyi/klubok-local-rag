import fs from "fs/promises";
import path from "path";
import pc from "picocolors";
import * as p from "@clack/prompts";

/**
 * Рендерить таблицю зі звітом про тестування RAG.
 * Ця функція є спільною для cli/index.js (при перегляді історії)
 * та test-rag.js (після виконання тестів).
 *
 * @param {Object} reportData - Об'єкт звіту з JSON.
 */
export function renderReportTable(reportData) {
  console.log(
    "\n==========================================================================================================",
  );
  console.log(pc.bold(`📊 ПІДСУМКОВЕ ПОРІВНЯННЯ РЕЖИМІВ (SEARCH MODES):`));
  if (reportData.timestamp) {
    console.log(pc.gray(`📅 Дата звіту: ${new Date(reportData.timestamp).toLocaleString()}`));
  }
  console.log("=".repeat(101));
  console.log(
    pc.bold("Режим".padEnd(25)) +
      pc.bold("Успішність".padEnd(16)) +
      pc.bold("Час (Заг/Сер)".padEnd(18)) +
      pc.bold("In/Out Токени".padEnd(18)) +
      pc.bold("Швидкість".padEnd(12)) +
      pc.bold("RAM"),
  );
  console.log("-".repeat(101));

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

    console.log(
      mode.padEnd(25) +
        passRateStr +
        `${totalTimeSec}c / ${avgTime}c`.padEnd(18) +
        `${s.totalInputTokens} / ${s.totalOutputTokens}`.padEnd(18) +
        `${s.avgTps.toFixed(1)} t/s`.padEnd(12) +
        `${Math.round(s.avgMem)} MB`,
    );
  }

  console.log("=".repeat(101));
  console.log(pc.bold(`⏱  ЗАГАЛЬНИЙ ЧАС ВСІХ ТЕСТІВ: ${(grandTotalTime / 1000).toFixed(1)} сек`));
  console.log(
    pc.bold(
      `🪙  ЗАГАЛЬНО ТОКЕНІВ: ${grandTotalInputTokens} (Input) / ${grandTotalOutputTokens} (Output)`,
    ),
  );
  console.log("");
}

/**
 * Логіка для вибору та перегляду існуючих JSON-звітів у CLI.
 */
export async function handleViewReports() {
  const reportsDir = path.resolve("test-reports");

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
