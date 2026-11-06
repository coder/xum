import { expect, test } from "bun:test";

import type { AgentPluginUpdateReview } from "@/common/orpc/schemas/agentPlugins";
import { updateNeedsReview } from "./pluginsSectionIntents";

const review = (extra: Partial<AgentPluginUpdateReview>): AgentPluginUpdateReview => ({
  name: "egm",
  fromSha: "a".repeat(40),
  toSha: "b".repeat(40),
  changes: [],
  warnings: [],
  ...extra,
});

test("an update with no changes applies; one change, or a refusal, is shown first", () => {
  expect(updateNeedsReview(review({}))).toBe(false);
  expect(updateNeedsReview(review({ changes: [{ summary: "adds an agent" }] }))).toBe(true);
  expect(updateNeedsReview(review({ refused: "the manifest is gone" }))).toBe(true);
});
