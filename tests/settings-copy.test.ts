/** Settings copy: every settings string exists in English and Russian, and no
 * description names a tool or a file the learner cannot see. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
const enBlock = source.slice(source.indexOf("const en = {"), source.indexOf("export type MessageKey"));
const ruBlock = source.slice(source.indexOf("const ru: Record<MessageKey, string> = {"), source.indexOf("const tables"));

const entries = (block: string): [string, string][] =>
  [...block.matchAll(/^\s+"([\w.-]+)":\s*"((?:[^"\\]|\\.)*)",?$/gm)].map((match) => [match[1]!, match[2]!]);

const SETTINGS_PREFIXES = ["s.", "r.", "artWhy.", "art."];
const inSettings = (key: string): boolean => SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix));

const en = new Map(entries(enBlock));
const ru = new Map(entries(ruBlock));
const settingsEn = [...en.keys()].filter(inSettings).sort();
const settingsRu = [...ru.keys()].filter(inSettings).sort();

const TOOL_NAMES = [
  "read_page",
  "find_books",
  "book_contents",
  "find_papers",
  "search_wikipedia",
  "web_search",
  "deep_research",
  "list_research_notes",
  "read_research_note",
];
const FILE_NAME = /\b[\w-]+\.(ts|tsx|js|mjs|cjs|json|md|css|html|txt|yaml|yml)\b/i;

test("every settings string key exists in both English and Russian", () => {
  assert.ok(settingsEn.length > 0, "settings keys were found");
  assert.deepEqual(settingsRu, settingsEn);
  for (const key of settingsEn) {
    assert.ok((ru.get(key) ?? "").trim().length > 0, `${key} has a Russian value`);
    assert.ok((en.get(key) ?? "").trim().length > 0, `${key} has an English value`);
  }
});

test("no settings description names a tool or a file", () => {
  for (const [lang, table] of [
    ["en", en],
    ["ru", ru],
  ] as const) {
    for (const key of settingsEn) {
      const value = table.get(key) ?? "";
      for (const tool of TOOL_NAMES) {
        assert.ok(!value.includes(tool), `${lang} ${key} must not name the tool ${tool}`);
      }
      assert.ok(!FILE_NAME.test(value), `${lang} ${key} must not name a file: ${value}`);
    }
  }
});

test("artifact descriptions avoid unexplained jargon", () => {
  for (const key of [...en.keys()].filter((candidate) => candidate.startsWith("artWhy."))) {
    assert.doesNotMatch(en.get(key) ?? "", /textbook|layout|seed|hook|scaffold/i, `${key} stays in plain words`);
  }
});
