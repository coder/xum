import { describe, expect, it } from "bun:test";
import type { DaytonaSandboxConfig } from "@/common/orpc/schemas/daytona";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import { createConfigSandboxIds } from "./daytonaSandboxIds";

function daytonaRow(id: string, daytona: DaytonaSandboxConfig): Workspace {
  return {
    id,
    path: `/src/${id}`,
    runtimeConfig: { type: "ssh", host: "x.xum--daytona", srcBaseDir: "~/mux", daytona },
  };
}

/** A Config whose edits apply to one in-memory ProjectsConfig. */
function memoryConfig(workspaces: Workspace[]) {
  const current = {
    projects: new Map([["/p", { workspaces }]]),
  } as unknown as ProjectsConfig;
  return {
    loadConfigOrDefault: () => current,
    editConfig: (fn: (config: ProjectsConfig) => ProjectsConfig) => {
      fn(current);
      return Promise.resolve();
    },
  };
}

describe("createConfigSandboxIds", () => {
  it("records the id on the creating workspace, which a fork's copy never overrides", async () => {
    const creator = daytonaRow("ws", { sandboxName: "xum-a" });
    const fork = daytonaRow("fork", { sandboxName: "xum-a", sandboxId: "stale", forked: true });
    const ids = createConfigSandboxIds(memoryConfig([fork, creator]));

    expect(ids.get("xum-a")).toBeUndefined();
    expect(await ids.record("xum-a", "id-1")).toBe(true);
    expect(ids.get("xum-a")).toBe("id-1");
    expect(fork.runtimeConfig).toMatchObject({ daytona: { sandboxId: "stale" } });
  });

  it("records nothing once no workspace names the sandbox", async () => {
    const ids = createConfigSandboxIds(memoryConfig([daytonaRow("ws", { sandboxName: "xum-b" })]));
    expect(await ids.record("xum-gone", "id-2")).toBe(false);
    expect(ids.get("xum-gone")).toBeUndefined();
  });
});
