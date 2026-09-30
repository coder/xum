import { describe, expect, test } from "bun:test";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { getWorkspaceSidebarKey } from "./workspace";

function createWorkspaceMeta(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: "workspace-1",
    name: "feature-branch",
    projectName: "repo",
    projectPath: "/tmp/repo",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: "/tmp/repo/feature-branch",
    ...overrides,
  };
}

describe("getWorkspaceSidebarKey", () => {
  test("changes when taskStatus changes", () => {
    const running = createWorkspaceMeta({ taskStatus: "running" });
    const reported = createWorkspaceMeta({ taskStatus: "reported" });

    expect(getWorkspaceSidebarKey(running)).not.toBe(getWorkspaceSidebarKey(reported));
  });

  // Pinning may not change sidebar row order (new pins append at the bottom of
  // the pinned block), so the key itself must change or the sidebar never
  // re-renders and the pin appears to do nothing.
  test("changes when pinnedAt changes", () => {
    const unpinned = createWorkspaceMeta();
    const pinned = createWorkspaceMeta({ pinnedAt: "2026-01-01T00:00:00.000Z" });

    expect(getWorkspaceSidebarKey(unpinned)).not.toBe(getWorkspaceSidebarKey(pinned));
  });

  test("changes when heartbeat enabled changes", () => {
    const disabled = createWorkspaceMeta({
      heartbeat: {
        enabled: false,
        intervalMs: 1_800_000,
        contextMode: "normal",
      },
    });
    const enabled = createWorkspaceMeta({
      heartbeat: {
        enabled: true,
        intervalMs: 1_800_000,
        contextMode: "normal",
      },
    });

    expect(getWorkspaceSidebarKey(disabled)).not.toBe(getWorkspaceSidebarKey(enabled));
  });
});
