import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";

/**
 * The deepest MCP gate: every MCP consumer (turn builder, prompt discovery, the manager's own
 * disk re-read, prompt materialization, served-tool dispatch) obtains workspace overrides through
 * getOverridesForWorkspace, so the checkout-preparation authority is established HERE. A
 * host-local task row whose authority cannot be validated yields a non-authoritative read with no
 * overrides (strict callers throw) and carries the refusal; a validated read carries the captured
 * authority for the caller to thread into the manager. Roots are exempt; off-host rows excluded.
 */
describe("WorkspaceMcpOverridesService checkout-preparation gate", () => {
  let tempDir: string;
  let config: Config;
  let projectPath: string;
  const rootId = "prep-root";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-mcp-prep-gate-"));
    config = new Config(tempDir);
    projectPath = path.join(tempDir, "project");
    await fs.mkdir(projectPath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          { id: rootId, name: rootId, path: projectPath, runtimeConfig: { type: "local" } },
        ],
      });
      return cfg;
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function addRow(row: {
    id: string;
    path: string;
    runtimeConfig:
      | { type: "local" }
      | { type: "worktree"; srcBaseDir: string }
      | { type: "ssh"; host: string; srcBaseDir: string };
    parentWorkspaceId?: string;
    taskIsolation?: "none";
  }): Promise<void> {
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push({ name: row.id, ...row });
      return cfg;
    });
  }

  async function archive(id: string): Promise<void> {
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const ws = project.workspaces.find((w) => w.id === id);
        if (ws) ws.archivedAt = new Date().toISOString();
      }
      return cfg;
    });
  }

  it("a root read is authoritative and carries an exempt authority", async () => {
    const service = new WorkspaceMcpOverridesService(config);
    const read = await service.getOverridesForWorkspace(rootId);
    expect(read.authoritative).toBe(true);
    expect(read.preparation).toBeDefined();
  });

  it("a shared task row derives its authority from live same-path ancestry; the read fails closed once the anchor is gone", async () => {
    await addRow({
      id: "shared",
      path: projectPath,
      runtimeConfig: { type: "local" },
      parentWorkspaceId: rootId,
      taskIsolation: "none",
    });
    const service = new WorkspaceMcpOverridesService(config);
    await service.setOverridesForWorkspace(rootId, { disabledServers: ["noisy"] });
    const ready = await service.getOverridesForWorkspace("shared");
    expect(ready.authoritative).toBe(true);
    expect(ready.overrides).toEqual({ disabledServers: ["noisy"] });
    expect(ready.preparation).toBeDefined();

    await archive(rootId);
    const refused = await service.getOverridesForWorkspace("shared");
    expect(refused.authoritative).toBe(false);
    expect(refused.overrides).toEqual({});
    await expect(service.getOverridesForWorkspace("shared", { mode: "strict" })).rejects.toThrow();
  });

  it("a legacy host-local task row (no proof) is refused: non-authoritative, no overrides, strict throws", async () => {
    const legacyPath = path.join(tempDir, "legacy-checkout");
    await fs.mkdir(path.join(legacyPath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(legacyPath, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["globally-disabled"] }),
      "utf-8"
    );
    await addRow({
      id: "legacy",
      path: legacyPath,
      runtimeConfig: { type: "worktree", srcBaseDir: tempDir },
      parentWorkspaceId: rootId,
    });
    const service = new WorkspaceMcpOverridesService(config);
    const read = await service.getOverridesForWorkspace("legacy");
    expect(read.authoritative).toBe(false);
    // The document's own enablement must not leak through a refused authority.
    expect(read.overrides).toEqual({});
    await expect(service.getOverridesForWorkspace("legacy", { mode: "strict" })).rejects.toThrow();
  });
});
