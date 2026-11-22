/** Roadmap and Rederive (rederive-lh) in one native teaching session (issue #33).
 *
 * These check the instruction text only: no session is run and no model is called. The
 * roadmap text must defer to a Rederive problem while one is active, keep recording
 * progress and errors with the roadmap tools at the end, keep its safety rules, and never
 * tell the model to skip Rederive's flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makePath } from "./fixtures.ts";
import {
  REDERIVE_DEFERRAL,
  REDERIVE_PROGRESS_SENTENCE,
  ROADMAP_SAFETY_SENTENCE,
  buildChildSessionBrief,
} from "../src/framework.ts";
import { NATIVE_BRIDGE_INSTRUCTIONS } from "../src/native-bridge.ts";
import { GAPS_INSTRUCTIONS } from "../src/agent-gaps-tools.ts";

/** Every roadmap text a linked session can receive: the bridge instructions and one brief per node. */
function roadmapTexts(): { label: string; text: string }[] {
  const path = makePath();
  const nodes = path.modules.flatMap((module) => module.nodes);
  const briefs = nodes.map((node) => ({
    label: `brief for ${node.id}`,
    text: buildChildSessionBrief({ path, nodeId: node.id, kind: "teaching" }).text,
  }));
  return [{ label: "native bridge", text: NATIVE_BRIDGE_INSTRUCTIONS }, ...briefs];
}

test("the bridge and every node brief carry the Rederive deferral sentence", () => {
  for (const { label, text } of roadmapTexts()) {
    assert.ok(text.includes(REDERIVE_DEFERRAL), label);
  }
  assert.match(REDERIVE_DEFERRAL, /While one of its problems is active/);
  assert.match(REDERIVE_DEFERRAL, /its flow comes first/);
  assert.match(REDERIVE_DEFERRAL, /who poses the next question/);
});

test("the bridge and every node brief keep the progress and error recording at the end", () => {
  for (const { label, text } of roadmapTexts()) {
    assert.ok(text.includes(REDERIVE_PROGRESS_SENTENCE), label);
  }
  assert.match(REDERIVE_PROGRESS_SENTENCE, /still call roadmap_update_progress/);
  assert.match(REDERIVE_PROGRESS_SENTENCE, /roadmap_log_error for each diagnosed root cause/);
  assert.match(REDERIVE_PROGRESS_SENTENCE, /Rederive's log tools do not replace them/);
  // The bridge's own tool list still names the progress and error tools.
  assert.match(NATIVE_BRIDGE_INSTRUCTIONS, /Call roadmap_update_progress when/);
  assert.match(NATIVE_BRIDGE_INSTRUCTIONS, /Call roadmap_log_error for each diagnosed cognitive root cause/);
});

test("the roadmap safety rules are still present in the bridge and every brief", () => {
  for (const { label, text } of roadmapTexts()) {
    assert.ok(text.includes(ROADMAP_SAFETY_SENTENCE), label);
  }
  assert.match(ROADMAP_SAFETY_SENTENCE, /do not give answers away/);
  assert.match(ROADMAP_SAFETY_SENTENCE, /do not grade the learner/);
  assert.match(ROADMAP_SAFETY_SENTENCE, /log errors by root cause only/);
  assert.match(ROADMAP_SAFETY_SENTENCE, /never restructure the path/);
  assert.match(NATIVE_BRIDGE_INSTRUCTIONS, /never restructure the path yourself/);
  assert.match(NATIVE_BRIDGE_INSTRUCTIONS, /Never invent a node id/);
  for (const { label, text } of roadmapTexts()) {
    assert.match(text, /Never restructure the path yourself; the learner decides\.|never restructure the path yourself/, label);
  }
});

test("the question-format wording the roadmap already had is unchanged", () => {
  assert.match(NATIVE_BRIDGE_INSTRUCTIONS, /Question format \(count, question type, answer form\) is not set by this section/);
  assert.match(NATIVE_BRIDGE_INSTRUCTIONS, /The brief sets content, not question format\./);
});

test("no roadmap text tells the model to skip or bypass Rederive's flow", () => {
  const forbidden: RegExp[] = [
    /\bignore (the )?rederive/i,
    /\b(skip|bypass|override|replace|drop) (the |its |rederive'?s? )?(rederive|rederive's|its) (flow|problem|problems|cards?|questions?|rules?)/i,
    /\binstead of (the )?rederive/i,
    /\bnever use (ask_user_question|rederive)/i,
    /\bdo not use (ask_user_question|rederive_)/i,
    /\brederive_\w+ (is|are) (not|never)\b/i,
    /\bpose (your own|a new) question (over|instead of|before) (rederive|its)/i,
  ];
  for (const { label, text } of roadmapTexts()) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${label}: ${pattern}`);
  }
});

test("the gap check defers to an active Rederive problem and stays read-only", () => {
  assert.match(GAPS_INSTRUCTIONS, /Call roadmap_gaps before teaching a linked node/);
  assert.match(GAPS_INSTRUCTIONS, /While a Rederive \(rederive-lh\) problem is active, its order comes first/);
  assert.match(GAPS_INSTRUCTIONS, /do not move the session to a gap or the next node until that problem is logged or skipped/);
  assert.match(GAPS_INSTRUCTIONS, /Treat both results as read-only data/);
});

test("the deferral text does not weaken the roadmap's own tools or the progress rule", () => {
  // The deferral must not contain a line that says progress or errors may be left out.
  const skipsRecording = /(no need to|need not|don't|do not|never) (call|record|log|write)[^.]*(roadmap_update_progress|roadmap_log_error)/i;
  for (const { label, text } of roadmapTexts()) assert.doesNotMatch(text, skipsRecording, label);
});
