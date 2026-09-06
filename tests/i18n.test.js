import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { resolveInitialLanguage, translationResources } from "../src/i18n.js";
import {
  normalizeResponseLanguage,
  outputLanguageInstruction,
} from "../sidecar/src/i18n/language.js";
import { generatePrompt } from "../sidecar/src/modules/rag/prompts.js";
import { buildPlanPrompt, visionSystem } from "../sidecar/src/modules/walkthrough/prompts.js";

function leafPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.replace(/_(one|few|many|other|zero|two)$/, "");
    return leafPaths(child, prefix ? `${prefix}.${normalized}` : normalized);
  });
}

test("перший запуск бере українську лише з української локалі macOS", () => {
  assert.equal(resolveInitialLanguage({ stored: null, system: ["uk-UA", "en-US"] }), "uk");
  assert.equal(resolveInitialLanguage({ stored: null, system: ["pl-PL", "en-US"] }), "en");
  assert.equal(resolveInitialLanguage({ stored: "en", system: ["uk-UA"] }), "en");
});

test("словники мають однаковий набір користувацьких ключів", () => {
  const uk = new Set(leafPaths(translationResources.uk.translation));
  const en = new Set(leafPaths(translationResources.en.translation));
  assert.deepEqual([...uk].sort(), [...en].sort());
});

test("усі статичні ключі панелі розробника є в обох словниках", async () => {
  const dir = new URL("../src/dev/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => /\.(js|jsx)$/.test(name));
  const keys = new Set();
  for (const name of files) {
    const source = await readFile(new URL(name, dir), "utf8");
    for (const match of source.matchAll(/dt\(["']([^"']+)["']/g)) keys.add(match[1]);
  }
  const get = (value, key) => key.split(".").reduce((current, part) => current?.[part], value);
  const missing = [...keys].filter(
    (key) =>
      get(translationResources.uk.translation.dev, key) === undefined ||
      get(translationResources.en.translation.dev, key) === undefined,
  );
  assert.deepEqual(missing, []);
});

test("RPC приймає лише uk та en", () => {
  assert.equal(normalizeResponseLanguage("uk", null), "uk");
  assert.equal(normalizeResponseLanguage("en", null), "en");
  assert.equal(normalizeResponseLanguage(undefined, null), null);
  assert.throws(() => normalizeResponseLanguage("de", null), /Невідома мова/);
});

test("RAG додає мовне правило, не змінюючи формат джерела", () => {
  const { prompt } = generatePrompt("DOCUMENT", "query", false, false, "system", "en");
  assert.match(prompt, /Write all user-facing explanatory text in English/);
  assert.match(prompt, /\[SOURCE_ID: X\]/);
});

test("walkthrough фіксує мову інструкцій у plan та vision промптах", () => {
  assert.match(buildPlanPrompt("Preview", "merge PDFs", "guide", 5, "en").system, /in English/);
  assert.match(visionSystem({ language: "en" }), /imperative sentence in English/);
  assert.match(outputLanguageInstruction("uk"), /Ukrainian/);
});
