import { describe, expect, test } from "bun:test";

import { WorkspaceConfigSchema } from "@/common/schemas/project";

describe("WorkspaceConfigSchema taskAttentionPolicy", () => {
  const base = { path: "/repo/ws", id: "ws-1" };

  test("parses legacy child workspaces without taskAttentionPolicy", () => {
    const parsed = WorkspaceConfigSchema.parse(base);
    expect(parsed.taskAttentionPolicy).toBeUndefined();
  });

  test("accepts a persisted notify_on_terminal policy", () => {
    const parsed = WorkspaceConfigSchema.parse({
      ...base,
      taskAttentionPolicy: "notify_on_terminal",
    });
    expect(parsed.taskAttentionPolicy).toBe("notify_on_terminal");
  });

  test("rejects an invalid attention policy value", () => {
    expect(WorkspaceConfigSchema.safeParse({ ...base, taskAttentionPolicy: "bogus" }).success).toBe(
      false
    );
  });
});
