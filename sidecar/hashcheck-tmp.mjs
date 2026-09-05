import { createHash } from "crypto";
import { EXTERNAL_BILINGUAL_TEST_CASES as C } from "./src/tests/test-external.js";
const h = createHash("sha256").update(JSON.stringify(C)).digest("hex");
console.log("computed datasetHash:", h);
console.log("expected            : 5b3dfea6bf78daeff70af0c11c1d05edecbd182aa75c24f702de0b9815ecee66");
console.log("MATCH:", h === "5b3dfea6bf78daeff70af0c11c1d05edecbd182aa75c24f702de0b9815ecee66");
console.log("total cases:", C.length);
const by = {}; const byType = {};
for (const c of C) { by[c.language ?? "(none)"] = (by[c.language ?? "(none)"]||0)+1; byType[c.type]=(byType[c.type]||0)+1; }
console.log("by language:", by);
console.log("by type:", byType);
console.log("with comparisonId:", C.filter(c=>c.comparisonId).length);
