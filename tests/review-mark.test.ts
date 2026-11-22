/** The short-review mark on nodes (issue #17): schema, old data and both labels. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLearningPath, REVIEW_MARKS } from "../src/domain.ts";
import { setLocale, t } from "../src/i18n.ts";
import { rawPath } from "./fixtures.ts";

test("data without the review mark still validates, and the mark is kept when valid", () => {
  const old = rawPath();
  for (const node of old.modules.flatMap((module: any) => module.nodes)) assert.equal("reviewMark" in node, false);
  const parsed = parseLearningPath(old);
  for (const node of parsed.modules.flatMap((module) => module.nodes)) assert.equal(node.reviewMark, undefined);

  const marked = rawPath();
  marked.modules[0].nodes[0].reviewMark = "short-review";
  assert.equal(parseLearningPath(marked).modules[0]!.nodes[0]!.reviewMark, "short-review");
});

test("a malformed review mark is rejected", () => {
  assert.deepEqual(REVIEW_MARKS, ["short-review"]);
  for (const reviewMark of ["review", "primed", "", 1, true, null]) {
    const value = rawPath();
    value.modules[0].nodes[0].reviewMark = reviewMark;
    assert.throws(() => parseLearningPath(value), /reviewMark: must be one of: short-review/, `reviewMark ${JSON.stringify(reviewMark)}`);
  }
});

test("the short-review label exists in English and Russian", (t2) => {
  t2.after(() => setLocale("en"));
  setLocale("en");
  assert.equal(t("mark.shortReview"), "short review");
  assert.equal(t("mark.shortReviewShort"), "review");
  setLocale("ru");
  assert.equal(t("mark.shortReview"), "короткое повторение");
  assert.equal(t("mark.shortReviewShort"), "повтор.");
});
