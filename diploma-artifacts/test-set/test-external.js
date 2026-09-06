import pc from "picocolors";
import { fileURLToPath } from "url";

import { runRagTests } from "./test-rag.js";
import { EXTERNAL_TEST_CASES } from "./test-external-cases.js";
import { EXTERNAL_TEST_CASES_UK } from "./test-external-cases-uk.js";

const ENGLISH_CASES = EXTERNAL_TEST_CASES.map((test, index) => ({
  ...test,
  comparisonId: `external-${String(index + 1).padStart(2, "0")}`,
}));

/** Однакові задачі двома мовами для прямого порівняння uk/en. */
export const EXTERNAL_BILINGUAL_TEST_CASES = [...ENGLISH_CASES, ...EXTERNAL_TEST_CASES_UK];

/**
 * Парні українські й англійські тести поверх україномовної векторної бази.
 * Форма кейсів і правила оцінювання ті самі, що в tests/test-cases.js.
 */
export async function loadExternalCases() {
  return EXTERNAL_BILINGUAL_TEST_CASES;
}

export async function runExternalTests(onProgress = () => {}, options = {}) {
  return await runRagTests(onProgress, {
    ...options,
    testCases: EXTERNAL_BILINGUAL_TEST_CASES,
    benchmarkKind: "external",
    // Для цього набору перевіряємо саме рекомендацію. Наявність правильної
    // програми десь у контексті не виправляє хибний вибір LLM.
    allowContextMatch: false,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runExternalTests()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(pc.red(error.message));
      process.exit(1);
    });
}
