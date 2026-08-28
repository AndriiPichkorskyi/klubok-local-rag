import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testScript = path.join(__dirname, "test-rag.js");

function runTest(model) {
  return new Promise((resolve, reject) => {
    console.log(pc.bgBlue(pc.white(`\n🚀 ЗАПУСК ТЕСТІВ ДЛЯ МОДЕЛІ: ${model} `)));
    
    const child = spawn("node", [testScript], {
      stdio: "inherit",
      env: {
        ...process.env,
        EMBED_MODEL: model
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(pc.green(`✅ Тестування для ${model} завершено успішно!`));
        resolve();
      } else {
        console.error(pc.red(`❌ Помилка під час тестування ${model} (Код: ${code})`));
        // reject(new Error(`Test failed with code ${code}`));
        resolve(); // Continue even if benchmarking had failed test cases
      }
    });
  });
}

async function runAll() {
  try {
    await runTest("qwen3-embedding:0.6b");
    console.log("\n=======================================================\n");
    await runTest("qwen3-embedding:4b");
    
    console.log(pc.bgGreen(pc.white("\n 🎉 УСІ ТЕСТИ ДЛЯ ОБОХ МОДЕЛЕЙ ЗАВЕРШЕНО! ")));
  } catch (error) {
    console.error(pc.red("\n❌ Процес тестування був перерваний через помилку."));
    process.exit(1);
  }
}

runAll();
