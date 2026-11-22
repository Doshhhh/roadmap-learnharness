/** Read-only roadmap tools for linked teaching sessions (issue #11).
 *
 * Runs the real backend activation: registration (names, descriptions, instruction scope), calls
 * on a linked chat, a failed read returning isError, and calls that leave the store files as they
 * were. No model request is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginBackendContext, PluginInstructions, PluginTools } from "learnharness-plugin-api";
import { GAPS_INSTRUCTIONS, GAPS_TOOL_NAME, NEXT_TOOL_NAME, registerAgentGaps } from "../src/agent-gaps-tools.ts";
import { openLearningPathStore } from "../src/store.ts";
import { makePath, AT } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";
import type { ChatRecord } from "learnharness-plugin-api";

function chat(id: string, kind: "teach" | "practice" = "teach"): ChatRecord {
  return { id, title: id, createdAt: AT, updatedAt: AT, messages: [], kind };
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-gaps-"));
}

function hostWithLinkedChat(): { host: TestHost; directory: string } {
  const directory = temporaryDirectory();
  openLearningPathStore(directory).savePath(makePath());
  // makePath() links chat-1 to n-concept as a teaching chat; chat-unlinked has no link.
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1"), chat("chat-unlinked")] });
  return { host, directory };
}

function close(host: TestHost, directory: string): void {
  host.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Every tool the host would offer this turn. nativeTools() reads only the first matching contribution. */
function turnTools(host: TestHost, chatId: string, agent: "teacher" | "prober"): AgentTool[] {
  return host.toolContributions
    .filter((contribution) => (contribution.agents as readonly string[]).includes(agent))
    .flatMap((contribution) => contribution.create({ chatId, agent }));
}

function toolNamed(host: TestHost, chatId: string, name: string): AgentTool {
  const tool = turnTools(host, chatId, "teacher").find((candidate) => candidate.name === name);
  assert.ok(tool, `expected ${name} for ${chatId}`);
  return tool;
}

async function callTool(tool: AgentTool): Promise<{ isError: boolean; details: Record<string, unknown>; text: string }> {
  const result = await tool.execute("call-1", {} as never, new AbortController().signal);
  const content = result.content as { type: string; text?: string }[];
  return {
    isError: result.isError === true,
    details: (result.details ?? {}) as Record<string, unknown>,
    text: content.find((part) => part.type === "text")?.text ?? "",
  };
}

/** Every file under a directory with its bytes, for proving a read writes nothing. */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(directory, full)] = fs.readFileSync(full, "utf8");
  }
  return files;
}

/** A fake host context that captures the tool factory, for driving the tools with a chosen source. */
function captureFactory(): { ctx: PluginBackendContext; factory: () => PluginTools | undefined } {
  let captured: PluginTools | undefined;
  const ctx = {
    registerInstructions: (_contribution: PluginInstructions) => () => {},
    registerTools: (contribution: PluginTools) => {
      captured = contribution;
      return () => {};
    },
  } as unknown as PluginBackendContext;
  return { ctx, factory: () => captured };
}

test("both roadmap tools are registered for linked teacher chats only, with descriptions and the teaching instruction", async () => {
  const { host, directory } = hostWithLinkedChat();
  try {
    const instruction = host.instructions.find((entry) => entry.text === GAPS_INSTRUCTIONS);
    assert.ok(instruction, "the gap and next-node instruction is registered");
    assert.deepEqual(instruction.agents, ["teacher"]);
    assert.match(instruction.text, /roadmap_gaps/);
    assert.match(instruction.text, /roadmap_next/);

    const gaps = toolNamed(host, "chat-1", GAPS_TOOL_NAME);
    assert.equal(gaps.name, "roadmap_gaps");
    assert.match(gaps.description, /prerequisite gaps/);
    assert.match(gaps.description, /Read-only/);

    const next = toolNamed(host, "chat-1", NEXT_TOOL_NAME);
    assert.equal(next.name, "roadmap_next");
    assert.match(next.description, /recommended next node/);
    assert.match(next.description, /Read-only/);

    for (const name of [GAPS_TOOL_NAME, NEXT_TOOL_NAME]) {
      assert.equal(
        turnTools(host, "chat-unlinked", "teacher").some((candidate) => candidate.name === name),
        false,
        `an unlinked chat does not receive ${name}`,
      );
      assert.equal(
        turnTools(host, "chat-1", "prober").some((candidate) => candidate.name === name),
        false,
        `only teacher turns receive ${name}`,
      );
    }
  } finally {
    close(host, directory);
  }
});

test("a call on a linked chat returns the gaps of its synthetic path, most severe first", async () => {
  const { host, directory } = hostWithLinkedChat();
  try {
    const result = await callTool(toolNamed(host, "chat-1", GAPS_TOOL_NAME));

    assert.equal(result.isError, false);
    assert.deepEqual(result.details, {
      isError: false,
      roadmap: "path-linear-algebra",
      gaps: [
        { nodeId: "n-concept", kind: "missing", severity: 4, blockers: [] },
        { nodeId: "n-skill", kind: "missing", severity: 3, blockers: [] },
        { nodeId: "n-contrast", kind: "missing", severity: 2, blockers: [] },
        { nodeId: "n-checkpoint", kind: "missing", severity: 1, blockers: [] },
        { nodeId: "n-bridge", kind: "missing", severity: 0, blockers: [] },
      ],
    });
    assert.equal(JSON.parse(result.text).roadmap, "path-linear-algebra");
  } finally {
    close(host, directory);
  }
});

test("a call on a linked chat returns the next node of its synthetic path with its reasons", async () => {
  const { host, directory } = hostWithLinkedChat();
  try {
    const result = await callTool(toolNamed(host, "chat-1", NEXT_TOOL_NAME));

    assert.equal(result.isError, false);
    assert.equal(result.details.roadmap, "path-linear-algebra");
    const next = result.details.next as { id: string; title: string; reasons: { key: string }[] };
    assert.equal(next.id, "n-concept");
    assert.equal(next.title, "Node n-concept");
    assert.deepEqual(
      next.reasons.map((reason) => reason.key),
      ["next.prereqsDone", "next.inProgress", "next.blocks", "next.direct"],
    );
  } finally {
    close(host, directory);
  }
});

test("calls that leave the store files unchanged write nothing", async () => {
  const { host, directory } = hostWithLinkedChat();
  try {
    const before = snapshot(directory);
    await callTool(toolNamed(host, "chat-1", GAPS_TOOL_NAME));
    await callTool(toolNamed(host, "chat-1", GAPS_TOOL_NAME));
    await callTool(toolNamed(host, "chat-1", NEXT_TOOL_NAME));

    assert.deepEqual(snapshot(directory), before, "the data directory is byte-for-byte unchanged");
  } finally {
    close(host, directory);
  }
});

test("a failed read returns isError and no gap or next-node data, for both tools", async () => {
  const { ctx, factory } = captureFactory();
  const broken = {
    linked: () => {
      throw new Error("store unreadable");
    },
    input: () => {
      throw new Error("store unreadable");
    },
  };
  const unregister = registerAgentGaps(ctx, broken);
  const tools = factory()?.create({ chatId: "chat-1", agent: "teacher" }) ?? [];
  assert.deepEqual(tools.map((tool) => tool.name), [GAPS_TOOL_NAME, NEXT_TOOL_NAME], "an unreadable store keeps both tools");

  for (const tool of tools) {
    const result = await callTool(tool);
    assert.equal(result.isError, true, `${tool.name} reports the failure`);
    assert.equal(result.details.isError, true);
    assert.equal(result.details.error, "store unreadable");
    assert.equal("gaps" in result.details, false);
    assert.equal("next" in result.details, false);
  }
  unregister();
});

test("a malformed path from the store returns isError for both tools, not a partial result", async () => {
  const { ctx, factory } = captureFactory();
  registerAgentGaps(ctx, {
    linked: () => true,
    input: () => ({ path: { id: "broken", modules: "none" }, mastery: [] }),
  });
  const tools = factory()?.create({ chatId: "chat-1", agent: "teacher" }) ?? [];
  assert.equal(tools.length, 2);

  for (const tool of tools) {
    const result = await callTool(tool);
    assert.equal(result.isError, true, `${tool.name} reports the malformed path`);
    assert.equal("gaps" in result.details, false);
    assert.equal("next" in result.details, false);
  }
});
