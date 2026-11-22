import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_REPO_LOCATION_MAX, validateLearningPath } from "../src/domain.ts";
import type { LearningPath, PathNode } from "../src/domain.ts";
import { buildChildSessionBrief } from "../src/framework.ts";
import { setLocale, t, tables } from "../src/i18n.ts";
import type { MessageKey } from "../src/i18n.ts";
import { makePath, rawPath } from "./fixtures.ts";

/** Validates a raw path whose first node carries the given codeRepo value. */
function validateWithRepo(codeRepo: unknown) {
  const raw = rawPath();
  raw.modules[0].nodes[0].codeRepo = codeRepo;
  return validateLearningPath(raw);
}

const nodeIn = (path: LearningPath, id: string): PathNode => {
  const node = path.modules.flatMap((module) => module.nodes).find((candidate) => candidate.id === id);
  assert.ok(node, `node ${id} exists`);
  return node;
};

/** Sets codeRepo on one node of a path, leaving the rest untouched. */
const withNodeRepo = (path: LearningPath, id: string, location: string): LearningPath => ({
  ...path,
  modules: path.modules.map((module) => ({
    ...module,
    nodes: module.nodes.map((node) => (node.id === id ? { ...node, codeRepo: { location } } : node)),
  })),
});

test("codeRepo accepts a folder path and a git URL", () => {
  const folder = validateWithRepo({ location: "/Users/learner/code/ostep-projects" });
  assert.equal(folder.ok, true);
  if (folder.ok) {
    assert.deepEqual(folder.value.modules[0]!.nodes[0]!.codeRepo, { location: "/Users/learner/code/ostep-projects" });
  }

  const url = validateWithRepo({ location: "https://github.com/example/ostep-projects.git" });
  assert.equal(url.ok, true);
  if (url.ok) {
    const node = url.value.modules[0]!.nodes[0]!;
    assert.deepEqual(node.codeRepo, { location: "https://github.com/example/ostep-projects.git" });
  }
});

test("codeRepo rejects an empty location", () => {
  const result = validateWithRepo({ location: "" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.issues[0]!.path, /codeRepo\.location$/);
});

test("codeRepo rejects control characters in the location", () => {
  for (const location of ["/tmp/repo\u0007", "https://example.com/a\nb.git", "/tmp/my\trepo", "/tmp/x\u007f"]) {
    const result = validateWithRepo({ location });
    assert.equal(result.ok, false, JSON.stringify(location));
    if (!result.ok) assert.match(result.issues[0]!.message, /control characters/);
  }
});

test("codeRepo rejects a location longer than the bound", () => {
  const atLimit = "a".repeat(CODE_REPO_LOCATION_MAX);
  assert.equal(validateWithRepo({ location: atLimit }).ok, true);

  const tooLong = validateWithRepo({ location: "a".repeat(CODE_REPO_LOCATION_MAX + 1) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.match(tooLong.issues[0]!.message, /at most 500 characters/);
});

test("codeRepo rejects a malformed value shape", () => {
  assert.equal(validateWithRepo("/tmp/repo").ok, false);
  assert.equal(validateWithRepo({ location: 42 }).ok, false);
  assert.equal(validateWithRepo(null).ok, false);
});

test("old data without codeRepo still validates", () => {
  const raw = rawPath();
  assert.equal("codeRepo" in raw.modules[0].nodes[0], false);
  assert.equal(validateLearningPath(raw).ok, true);
});

test("the child brief names this node's repo location and no other repo data", () => {
  const base = makePath();
  const path = withNodeRepo(withNodeRepo(base, "n-contrast", "/Users/learner/code/vector-lab"), "n-concept", "https://example.com/other-repo.git");

  const brief = buildChildSessionBrief({ path, nodeId: "n-contrast", kind: "teaching" });
  assert.match(brief.text, /Code repository for this node: "\/Users\/learner\/code\/vector-lab"/);
  assert.doesNotMatch(brief.text, /other-repo/);
  assert.equal(brief.text.split("\n").filter((line) => /repository/i.test(line)).length, 1);

  // A linked node with no repo gets no repository line, even when another node has one.
  const other = buildChildSessionBrief({ path, nodeId: "n-skill", kind: "teaching" });
  assert.doesNotMatch(other.text, /Code repository/);
  assert.doesNotMatch(other.text, /vector-lab|other-repo/);
});

test("the brief for a node without a repo is unchanged by the new field", () => {
  const brief = buildChildSessionBrief({ path: makePath(), nodeId: "n-contrast", kind: "teaching" });
  assert.doesNotMatch(brief.text, /Code repository/);
});

test("the node panel key exists in both EN and RU, with text in each", () => {
  const key: MessageKey = "insp.codeRepo";
  assert.equal(typeof tables.en[key], "string");
  assert.equal(typeof tables.ru[key], "string");
  assert.notEqual(tables.en[key].trim(), "");
  assert.notEqual(tables.ru[key].trim(), "");

  try {
    setLocale("ru");
    assert.equal(t(key), "Репозиторий кода");
    setLocale("en");
    assert.equal(t(key), "Code repository");
  } finally {
    setLocale("en");
  }
});
