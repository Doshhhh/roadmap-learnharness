/** 0.4.0: roadmap proposals from sessions, the dossier and the Error Ledger hand-off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DossierError, LIMITS, PROPOSE_INSTRUCTIONS, applyMisconceptionsTool, buildMessage, createDeclinedChats,
  dossierFromNote, parseDossier, proposalAllowed, proposeTool, registerProposals,
} from "../src/diagnostic.ts";
import { buildArchitectSystemPrompt } from "../src/framework.ts";
import { createResearchNotes } from "../src/research/notes.ts";
import { openLearningPathStore } from "../src/store.ts";
import { makePath } from "./fixtures.ts";

const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-diag-"));

const DOSSIER = {
  goal: "Implement PCA and SVD in NumPy for ML work",
  motivation: "New job in data analysis",
  background: "School maths, Python 3 years, no university linear algebra",
  assessment: [
    { topic: "Vectors", probe: "What is a linear combination?", answer: "adding scaled vectors", verdict: "knows" },
    { topic: "Matrix product", probe: "Multiply 2x3 by 3x2", answer: "multiplied element-wise", verdict: "misconception", observations: "confuses * and @" },
  ],
  strengths: ["NumPy arrays", "vector addition"],
  gaps: [{ topic: "Derivatives", neededFor: "gradient descent" }, "Variance"],
  misconceptions: [
    { category: "discrimination_error", summary: "Treats matrix product as element-wise", example: "A*B for a 2x3 and 3x2" },
    { category: "prerequisite_gap", summary: "No notion of the chain rule" },
  ],
  constraints: "Russian or English, free only, 1 hour a day",
  sources: [{ title: "3Blue1Brown Essence of LA", stance: "uses" }, "Strang"],
  openQuestions: ["Calculus level beyond derivatives?"],
  transcriptExcerpt: "Learner: I do A*B and get an error…",
};

test("dossier: required fields, server-owned chat id, caps and rejections", () => {
  const dossier = parseDossier({ ...DOSSIER, sourceChatId: "forged" }, "chat-real");
  assert.equal(dossier.sourceChatId, "chat-real", "the model cannot choose the source chat");
  assert.equal(dossier.gaps[1]!.topic, "Variance");
  assert.equal(dossier.sources[1]!.stance, "mentioned");
  assert.throws(() => parseDossier({ ...DOSSIER, goal: " " }, "c"), DossierError);
  assert.throws(() => parseDossier({ ...DOSSIER, assessment: [{ topic: "x", probe: "y", verdict: "great" }] }, "c"), /verdict/);
  assert.throws(() => parseDossier({ ...DOSSIER, misconceptions: [{ category: "silly", summary: "x" }] }, "c"), /category/);
  const huge = parseDossier({ ...DOSSIER, transcriptExcerpt: "x".repeat(50_000), strengths: Array.from({ length: 99 }, (_, i) => `s${i}`) }, "c");
  assert.equal(huge.transcriptExcerpt!.length, LIMITS.transcript);
  assert.equal(huge.strengths.length, LIMITS.strengths);
});

test("the proposal tool saves the whole dossier as a diagnostic note the Architect can read back", async () => {
  const directory = temp();
  const store = openLearningPathStore(directory);
  const notes = createResearchNotes(directory);
  const seen: string[] = [];
  const tool = proposeTool({ store, notes, declined: createDeclinedChats(directory), isResearchChat: () => false, enabled: () => true, onProposal: (s) => seen.push(s.noteId) }, "chat-probe");
  const result = await tool.execute("1", DOSSIER as never) as { details: { noteId: string; gaps: number; misconceptions: number } };
  assert.equal(result.details.gaps, 2);
  assert.equal(result.details.misconceptions, 2);
  const note = notes.read(result.details.noteId)!;
  assert.equal(note.origin, "diagnostic");
  assert.equal(note.chatId, "chat-probe");
  assert.match(note.body, /confuses \* and @/);
  assert.match(note.body, /Learner: I do A\*B/);
  assert.equal(dossierFromNote(note.body)!.misconceptions[0]!.category, "discrimination_error");
  assert.deepEqual(seen, [note.id]);
  const bad = await tool.execute("2", { goal: "x" } as never) as { isError?: boolean };
  assert.equal(bad.isError, true);
});

test("no offer in node-linked chats, research sessions, declined chats, or when switched off", () => {
  const directory = temp();
  const store = openLearningPathStore(directory);
  store.savePath(makePath()); // links chat-1 to a node
  let enabled = true;
  const declined = createDeclinedChats(directory);
  const options = { store, notes: createResearchNotes(directory), declined, isResearchChat: (id: string) => id === "chat-research", enabled: () => enabled };
  assert.equal(proposalAllowed(options, "chat-free"), true);
  assert.equal(proposalAllowed(options, "chat-1"), false, "linked to a node");
  assert.equal(proposalAllowed(options, "chat-research"), false, "research session");
  declined.add("chat-free");
  assert.equal(proposalAllowed(options, "chat-free"), false, "the learner said not now");

  const instructions: { agents: string[] }[] = [];
  const tools: { agents: string[]; create: (c: { chatId: string; agent: string }) => unknown[] }[] = [];
  const ctx = {
    registerInstructions: (value: { agents: string[] }) => { instructions.push(value); return () => instructions.splice(instructions.indexOf(value), 1); },
    registerTools: (value: (typeof tools)[number]) => { tools.push(value); return () => tools.splice(tools.indexOf(value), 1); },
  };
  const registration = registerProposals(ctx as never, options);
  assert.deepEqual(instructions[0]!.agents, ["prober", "teacher"]);
  assert.equal(tools[0]!.create({ chatId: "chat-other", agent: "prober" }).length, 1);
  assert.equal(tools[0]!.create({ chatId: "chat-1", agent: "teacher" }).length, 0);
  enabled = false;
  registration.sync();
  assert.equal(instructions.length + tools.length, 0, "switched off: neither the rule nor the tool");
  enabled = true;
  registration.sync();
  assert.equal(instructions.length, 1);
  assert.match(PROPOSE_INSTRUCTIONS, /at most once per session/);
  assert.match(PROPOSE_INSTRUCTIONS, /only after the learner agrees/);
  assert.match(PROPOSE_INSTRUCTIONS, /Do not promise that this session will become part of the roadmap/);
  assert.match(PROPOSE_INSTRUCTIONS, /never with gendered pronouns/);
  registration.dispose();
});

test("the Architect gets the dossier rules and moves misconceptions into the Error Ledger", async () => {
  const prompt = buildArchitectSystemPrompt({ researchTools: [] });
  assert.match(prompt, /Building from a diagnostic dossier/);
  assert.match(prompt, /Do not ask again for anything the dossier already answers/);
  assert.match(prompt, /bridge nodes for every prerequisite gap/);
  assert.match(prompt, /contrast node for each misconception/);
  // Issue #19: the Architect is not offered the misconception-apply tool, so the prompt never names it.
  assert.doesNotMatch(prompt, /apply_dossier_misconceptions/);
  assert.match(buildMessage("abc", "ru"), /досье из диагностики abc/);

  const directory = temp();
  const store = openLearningPathStore(directory);
  const saved = store.savePath(makePath());
  const notes = createResearchNotes(directory);
  const tool = proposeTool({ store, notes, declined: createDeclinedChats(directory), isResearchChat: () => false, enabled: () => true }, "chat-probe");
  const { details } = await tool.execute("1", DOSSIER as never) as { details: { noteId: string } };
  const apply = applyMisconceptionsTool({ signal: new AbortController().signal } as never, { store, notes });
  const run = (assignments: unknown) => apply.execute!("a", { noteId: details.noteId, pathId: saved.id, assignments } as never, undefined as never) as Promise<{ content: { text: string }[]; details: { moved: number } }>;
  const first = await run([{ index: 0, nodeId: "n-concept" }, { index: 1, nodeId: "n-skill" }, { index: 7, nodeId: "n-skill" }, { index: 0, nodeId: "missing" }]);
  assert.equal(first.details.moved, 2);
  assert.match(first.content[0]!.text, /no misconception #7.*no node "missing"/);
  const node = store.path(saved.id)!.modules.flatMap((m) => m.nodes).find((n) => n.id === "n-concept")!;
  const entry = node.errors.find((e) => e.summary.includes("element-wise"))!;
  assert.equal(entry.category, "discrimination_error");
  assert.equal(entry.resolved, false, "unresolved, so it travels into future lessons");
  assert.equal(entry.sessionChatId, "chat-probe");
  assert.ok(!node.childSessions.some((link) => link.chatId === "chat-probe"), "the source session is not linked to the path");
  const again = await run([{ index: 0, nodeId: "n-concept" }]);
  assert.equal(again.details.moved, 0, "running twice does not duplicate entries");
});
