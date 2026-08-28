import { ollama } from "../services/ollama.service.js";
import pc from "picocolors";

// Функція для розрахунку Косинусної відстані (Cosine Distance)
// 0.0 - ідеальний збіг, 1.0 - абсолютно різні, 2.0 - протилежні
function cosineDistance(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

// Функція для розрахунку L2 Відстані (Евклідова відстань)
function l2Distance(vecA, vecB) {
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    const diff = vecA[i] - vecB[i];
    sum += diff * diff;
  }
  return sum; // У LanceDB використовується квадрат евклідової відстані
}

async function runComparison() {
  console.log(pc.bgCyan(pc.black(" ДЕМОНСТРАЦІЯ ПРОБЛЕМИ МОРФОЛОГІЇ УКРАЇНСЬКОЇ МОВИ ")));
  console.log("Генеруємо вектори (це може зайняти кілька секунд)...\n");

  const ukr1 = "як записати голос";
  const ukr2 = "Як записати голосові нотатки";

  const eng1 = "how to record voice";
  const eng2 = "how to record voice memos";

  // Генеруємо вектори через Ollama
  const [vecUkr1, vecUkr2, vecEng1, vecEng2] = await Promise.all([
    ollama.generateEmbedding(ukr1),
    ollama.generateEmbedding(ukr2),
    ollama.generateEmbedding(eng1),
    ollama.generateEmbedding(eng2),
  ]);

  const ukrDistanceL2 = l2Distance(vecUkr1, vecUkr2);
  const engDistanceL2 = l2Distance(vecEng1, vecEng2);

  const ukrDistanceCos = cosineDistance(vecUkr1, vecUkr2);
  const engDistanceCos = cosineDistance(vecEng1, vecEng2);

  console.log(pc.yellow("--- Українська мова (висока морфологічна варіативність) ---"));
  console.log(`Запит 1: "${ukr1}"`);
  console.log(`Запит 2: "${ukr2}"`);
  console.log(pc.red(`L2 Відстань: ${ukrDistanceL2.toFixed(4)}`));
  console.log(pc.red(`Cosine Відстань: ${ukrDistanceCos.toFixed(4)}`));
  console.log("");

  console.log(pc.green("--- Англійська мова (низька морфологічна варіативність) ---"));
  console.log(`Запит 1: "${eng1}"`);
  console.log(`Запит 2: "${eng2}"`);
  console.log(pc.cyan(`L2 Відстань: ${engDistanceL2.toFixed(4)}`));
  console.log(pc.cyan(`Cosine Відстань: ${engDistanceCos.toFixed(4)}`));
  console.log("");

  console.log(pc.white("Висновок:"));
  if (ukrDistanceL2 > engDistanceL2) {
    console.log(
      `Українські вектори розійшлися на ${((ukrDistanceL2 / engDistanceL2 - 1) * 100).toFixed(1)}% сильніше, ніж англійські!`
    );
    console.log(
      "Через зміну кореня/суфікса (голос -> голосові), математична відстань між смислами в українській мові значно більша, що ускладнює векторний пошук."
    );
  } else if (ukrDistanceL2 < engDistanceL2) {
    console.log(
      `Англійські вектори розійшлися на ${((engDistanceL2 / ukrDistanceL2 - 1) * 100).toFixed(1)}% сильніше, ніж українські!`
    );
    console.log(
      "У цьому конкретному випадку (або для цієї моделі) українські вектори виявилися ближчими один до одного."
    );
  } else {
    console.log("Дивовижно! Відстані абсолютно однакові.");
  }
}

runComparison();
