import { describe, expect, mock, test } from "bun:test";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { readFileLines } from "./readFileLines";
import { createTestApiClient } from "@/browser/testUtils";

const workspaceMetadata: Pick<FrontendWorkspaceMetadata, "projects"> = {
  projects: [
    { projectName: "project-a", projectPath: "/tmp/project-a" },
    { projectName: "project-b", projectPath: "/tmp/project-b" },
  ],
};

describe("readFileLines", () => {
  test("keeps plain file reads on the shared container cwd", async () => {
    const executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          success: true as const,
          output: "first\nsecond\n",
          exitCode: 0 as const,
          wall_duration_ms: 0,
        },
      })
    );
    const api = createTestApiClient({
      workspace: {
        executeBash,
      },
    });

    const lines = await readFileLines(
      api,
      "workspace-1",
      workspaceMetadata,
      "project-b/src/example.ts",
      1,
      2,
      ""
    );

    expect(lines).toEqual(["first", "second"]);
    expect(executeBash).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      script: `sed -n '1,2p' "project-b/src/example.ts"`,
      options: { timeout_secs: 3 },
    });
  });

  test("uses repo-relative paths for git-ref reads in secondary repos", async () => {
    const executeBash = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          success: true as const,
          output: "first\nsecond\n",
          exitCode: 0 as const,
          wall_duration_ms: 0,
        },
      })
    );
    const api = createTestApiClient({
      workspace: {
        executeBash,
      },
    });

    const lines = await readFileLines(
      api,
      "workspace-1",
      workspaceMetadata,
      "project-a/src/example.ts",
      1,
      2,
      "HEAD",
      "/tmp/project-a"
    );

    expect(lines).toEqual(["first", "second"]);
    expect(executeBash).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      script: "git show \"HEAD:src/example.ts\" 2>/dev/null | sed -n '1,2p'",
      options: {
        timeout_secs: 3,
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-a",
      },
    });
  });
});
