/** Read-only roadmap tools for linked teaching sessions (issue #11).
 *
 * Registers `roadmap_gaps` and `roadmap_next` through the host's registerTools/registerInstructions.
 * Both tools are present only in teacher turns of a chat linked to a node. Their handlers call
 * readNodeGaps or readNextNode and write nothing. The data (the linked path and the learner's
 * mastery) comes from the backend.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PluginBackendContext, PluginTools } from "learnharness-plugin-api";
import { readNextNode, readNodeGaps } from "./agent-gaps.ts";

export const GAPS_TOOL_NAME = "roadmap_gaps";
export const NEXT_TOOL_NAME = "roadmap_next";

export const GAPS_INSTRUCTIONS = [
  "# Roadmap gap check",
  "This applies only when the tools roadmap_gaps or roadmap_next are in your current tool set; otherwise ignore this section.",
  "Call roadmap_gaps before teaching a linked node to see which prerequisite nodes the learner has not seen or practised yet, and roadmap_next to see the node that is ready to teach next.",
  "Treat both results as read-only data: they do not change progress or the path, and do not invent gaps or nodes that are not in them.",
  "While a Rederive (rederive-lh) problem is active, its order comes first: use these results as background only, and do not move the session to a gap or the next node until that problem is logged or skipped.",
].join("\n");

/** The backend's view of linked chats: whether a chat is linked, and the input for a read. */
export interface LinkedGapsSource {
  /** True when the chat is linked to a node. Throws when the store cannot be read. */
  linked(chatId: string): boolean;
  /** The linked path and the learner's mastery. Throws when the read fails. */
  input(chatId: string): unknown;
}

const errorResult = (message: string): AgentToolResult<{ isError: true; error: string }> => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  details: { isError: true, error: message },
  isError: true,
});

type ReadResult = { isError: boolean; error?: string } & Record<string, unknown>;

function readTool(
  source: LinkedGapsSource,
  chatId: string,
  spec: { name: string; label: string; description: string; read: (input: unknown) => ReadResult },
): AgentTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async () => {
      let result: ReadResult;
      try {
        result = spec.read(source.input(chatId));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      if (result.isError) return errorResult(String(result.error));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

/** Register the teaching instruction and the per-turn gap and next-node tools for linked teacher chats. */
export function registerAgentGaps(ctx: PluginBackendContext, source: LinkedGapsSource): () => void {
  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: GAPS_INSTRUCTIONS });
  const contribution: PluginTools = {
    agents: ["teacher"],
    create: (context) => {
      try {
        if (!source.linked(context.chatId)) return [];
      } catch {
        // An unreadable store keeps the tools, so their calls report the failure instead of hiding it.
      }
      return [
        readTool(source, context.chatId, {
          name: GAPS_TOOL_NAME,
          label: "Roadmap gaps",
          description:
            "Read the prerequisite gaps of this session's roadmap: nodes the learner has not seen or practised yet that " +
            "block a node, most severe first. Read-only; takes no arguments.",
          read: readNodeGaps as (input: unknown) => ReadResult,
        }),
        readTool(source, context.chatId, {
          name: NEXT_TOOL_NAME,
          label: "Roadmap next node",
          description:
            "Read the recommended next node of this session's roadmap, with the reasons it is ready, or null when no node " +
            "is ready. Read-only; takes no arguments.",
          read: readNextNode as (input: unknown) => ReadResult,
        }),
      ];
    },
  };
  const unregisterTools = ctx.registerTools(contribution);
  return () => {
    unregisterInstructions();
    unregisterTools();
  };
}
