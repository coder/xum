import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import { execSync } from "node:child_process";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import { prepareDedicatedTaskCheckout } from "@/node/services/taskCheckoutPreparation.testHarness";
import { initGitRepo } from "@/node/services/taskService.testHarness";
import type { TaskCheckoutPreparation } from "@/node/services/taskCheckoutPreparation";
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
    taskCheckoutPreparation?: TaskCheckoutPreparation;
  }): Promise<void> {
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push({ name: row.id, ...row });
      return cfg;
    });
  }

  /** A dedicated child the way the materializer publishes it: a real bound worktree + its proof. */
  async function addPreparedDedicatedRow(id: string): Promise<string> {
    initGitRepo(projectPath);
    const checkout = path.join(config.srcDir, "project", id);
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    const runtimeConfig = { type: "worktree", srcBaseDir: config.srcDir } as const;
    const taskCheckoutPreparation = await prepareDedicatedTaskCheckout({
      projectPath,
      checkout,
      branch: id,
      runtimeConfig,
    });
    await addRow({
      id,
      path: checkout,
      runtimeConfig,
      parentWorkspaceId: rootId,
      taskCheckoutPreparation,
    });
    return checkout;
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
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(service.getOverridesForWorkspace("shared", { mode: "strict" })).rejects.toThrow();
  });

  it("a dedicated task row with a real prepared checkout reads authoritatively under its proof authority; a same-path replacement of the checkout fails the read closed", async () => {
    const checkout = await addPreparedDedicatedRow("dedicated");
    await fs.mkdir(path.join(checkout, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(checkout, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["globally-disabled"] }),
      "utf-8"
    );
    const service = new WorkspaceMcpOverridesService(config);
    const ready = await service.getOverridesForWorkspace("dedicated");
    expect(ready.authoritative).toBe(true);
    expect(ready.overrides).toEqual({ enabledServers: ["globally-disabled"] });
    expect(ready.preparation).toMatchObject({
      kind: "authority",
      authority: { kind: "dedicated", workspaceId: "dedicated", anchorWorkspaceId: "dedicated" },
    });

    // The directory is replaced at the same path by something the proof never bound (an
    // older-build re-materialization): the row is unchanged, the physical identity is not.
    execSync(`git worktree remove --force "${checkout}"`, { cwd: projectPath, stdio: "ignore" });
    execSync(`git worktree add -q -b dedicated-again "${checkout}" main`, {
      cwd: projectPath,
      stdio: "ignore",
    });
    await fs.mkdir(path.join(checkout, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(checkout, ".xum", "mcp.local.jsonc"),
      JSON.stringify({ enabledServers: ["globally-disabled"] }),
      "utf-8"
    );
    const refused = await service.getOverridesForWorkspace("dedicated");
    expect(refused.authoritative).toBe(false);
    expect(refused.overrides).toEqual({});
    expect(refused.preparationRefusal?.message).toMatch(/PREP_MISMATCH/);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(service.getOverridesForWorkspace("dedicated", { mode: "strict" })).rejects.toThrow(
      /PREP_MISMATCH/
    );
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
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(service.getOverridesForWorkspace("legacy", { mode: "strict" })).rejects.toThrow();
  });
});
