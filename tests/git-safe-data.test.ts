/** Git-safe data folder: .gitignore on activation, stable JSON, and no churn on unchanged saves. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDataGitignore, GITIGNORE_ENTRIES, mergeGitignore } from "../src/git-safe-data.ts";
import { openLearningPathStore, ROADMAPS_DIRECTORY, roadmapFileName } from "../src/store.ts";
import { makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";

function directory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-safe-data-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gitignore = (dir: string): string => fs.readFileSync(path.join(dir, ".gitignore"), "utf8");

/** Silence and capture console.warn for the duration of one test. */
function captureWarnings(t: { after: (fn: () => void) => void }): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

test("activation creates a .gitignore listing secrets, logs and temporary files", (t) => {
  const dir = directory(t);
  createHost({ dataDirectory: dir });
  const lines = gitignore(dir).split("\n");
  for (const entry of ["secrets/", "logs/", "*.tmp"]) assert.ok(lines.includes(entry), `missing ${entry}`);
  assert.deepEqual(GITIGNORE_ENTRIES, ["secrets/", "logs/", "*.tmp"]);
});

test("an existing .gitignore keeps the learner's own lines and gains the missing ones", (t) => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, ".gitignore"), "# my notes\nscratch/\n*.log");
  ensureDataGitignore(dir);
  const text = gitignore(dir);
  assert.ok(text.startsWith("# my notes\nscratch/\n*.log\n"), text);
  for (const entry of GITIGNORE_ENTRIES) assert.ok(text.split("\n").includes(entry), `missing ${entry}`);
});

test("a second activation does not duplicate lines or rewrite the file", (t) => {
  const dir = directory(t);
  createHost({ dataDirectory: dir });
  const before = fs.statSync(path.join(dir, ".gitignore")).ino;
  const first = gitignore(dir);
  createHost({ dataDirectory: dir });
  assert.equal(gitignore(dir), first);
  assert.equal(fs.statSync(path.join(dir, ".gitignore")).ino, before, "unchanged .gitignore must not be rewritten");
  for (const entry of GITIGNORE_ENTRIES) {
    assert.equal(first.split("\n").filter((line) => line === entry).length, 1, `${entry} appears once`);
  }
});

test("mergeGitignore appends only what is missing and keeps a missing trailing newline valid", () => {
  const once = mergeGitignore("secrets/\n");
  assert.equal(once.changed, true);
  assert.equal(once.text, "secrets/\nlogs/\n*.tmp\n");
  const again = mergeGitignore(once.text);
  assert.equal(again.changed, false);
  assert.equal(again.text, once.text);
});

test("a failed .gitignore write does not throw and warns instead", (t) => {
  const dir = directory(t);
  const warnings = captureWarnings(t);
  // A directory named .gitignore cannot be read as a file, so the update fails.
  fs.mkdirSync(path.join(dir, ".gitignore"));
  assert.doesNotThrow(() => ensureDataGitignore(dir));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /\.gitignore/);
});

test("a failed .gitignore write during activation does not stop the plugin", (t) => {
  const dir = directory(t);
  captureWarnings(t);
  fs.mkdirSync(path.join(dir, ".gitignore"));
  assert.doesNotThrow(() => createHost({ dataDirectory: dir }));
});

test("writes are pretty-printed with a stable key order, whatever order the input used", (t) => {
  const first = directory(t);
  const second = directory(t);
  const path1 = makePath();
  const reversed = Object.fromEntries(Object.entries(path1).reverse()) as typeof path1;
  openLearningPathStore(first).savePath(path1);
  openLearningPathStore(second).savePath(reversed);
  const file = path.join(ROADMAPS_DIRECTORY, roadmapFileName("path-linear-algebra"));
  const bytes = fs.readFileSync(path.join(first, file), "utf8");
  assert.equal(bytes, fs.readFileSync(path.join(second, file), "utf8"));
  assert.ok(bytes.endsWith("}\n"), "trailing newline");
  assert.match(bytes, /\n  "roadmap": \{/, "pretty-printed with two-space indent");
  assert.doesNotThrow(() => JSON.parse(bytes));
});

test("saving an unchanged path is byte-identical and skips the write", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const file = path.join(dir, ROADMAPS_DIRECTORY, roadmapFileName("path-linear-algebra"));
  const bytes = fs.readFileSync(file, "utf8");
  const inode = fs.statSync(file).ino;
  const mtime = fs.statSync(file).mtimeMs;
  store.savePath(makePath());
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.statSync(file).ino, inode, "no temp file was renamed over the original");
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  );
  // The revision did not move, so a reload sees the same version.
  assert.equal(JSON.parse(bytes).revision, JSON.parse(fs.readFileSync(file, "utf8")).revision);
  assert.equal(JSON.parse(bytes).revision, 1);
});

test("saving a changed path still writes and bumps the revision", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  store.savePath({ ...makePath(), title: "Renamed" });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, ROADMAPS_DIRECTORY, roadmapFileName("path-linear-algebra")), "utf8"));
  assert.equal(saved.revision, 2);
  assert.equal(saved.roadmap.title, "Renamed");
});
