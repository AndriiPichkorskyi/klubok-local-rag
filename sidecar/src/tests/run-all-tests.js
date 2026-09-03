import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";
import { logger } from "../services/logger.service.js";
import { config } from "../config/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testScript = path.join(__dirname, "test-rag.js");

function runTest(model) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    console.log(pc.bgBlue(pc.white(`\n🚀 ЗАПУСК ТЕСТІВ ДЛЯ МОДЕЛІ: ${model} `)));

    const child = spawn("node", [testScript], {
      stdio: "inherit",
      env: {
        ...process.env,
        EMBED_MODEL: model,
      },
    });

    // Без цього обробника збій самого spawn (немає node у PATH, немає файлу)
    // не доїжджає ні до "close", ні до catch у runAll() — процес просто зависає.
    child.on("error", (err) => {
      console.error(pc.red(`❌ Не вдалося запустити тест для ${model}: ${err.message}`));
      logger.event(
        "error",
        "test.child.spawn_failed",
        { model, error: err.message },
        `Не вдалося запустити тест для ${model}`,
      );
      reject(err);
    });

    // signal, а не лише code: дочірній процес, убитий ззовні (OOM-killer шле
    // SIGKILL, аварія нативного модуля — SIGSEGV/SIGABRT), завершується з
    // code === null. Без цього поля така смерть виглядала б як «Код: null».
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        console.log(pc.green(`✅ Тестування для ${model} завершено успішно!`));
        logger.event(
          "info",
          "test.child.done",
          { model, pid: child.pid, code, durationMs },
          `Тест для ${model} завершено`,
        );
        resolve();
      } else {
        console.error(
          pc.red(
            `❌ Помилка під час тестування ${model} (Код: ${code}${signal ? `, сигнал: ${signal}` : ""})`,
          ),
        );
        logger.event(
          "error",
          "test.child.failed",
          { model, pid: child.pid, code, signal, durationMs },
          signal
            ? `Тест для ${model} УБИТО сигналом ${signal} — процес не завершився сам`
            : `Тест для ${model} завершився з кодом ${code}`,
        );
        // reject(new Error(`Test failed with code ${code}`));
        resolve(); // Continue even if benchmarking had failed test cases
      }
    });
  });
}

async function runAll() {
  await logger.init();
  logger.installProcessHandlers({ role: "run-all-tests" });
  logger.logProcessStart({ role: "run-all-tests" });
  try {
    const models = [...new Set(config.embedModels || [config.embedModelName])];
    for (let index = 0; index < models.length; index++) {
      if (index > 0) console.log("\n=======================================================\n");
      await runTest(models[index]);
    }

    console.log(pc.bgGreen(pc.white("\n 🎉 ТЕСТИ ДЛЯ ВСІХ МОДЕЛЕЙ ЗАВЕРШЕНО! ")));
  } catch (error) {
    console.error(pc.red("\n❌ Процес тестування був перерваний через помилку."));
    process.exit(1);
  }
}

runAll();
