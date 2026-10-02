import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import type { ORPCContext } from "@/node/orpc/context";
import { getWorkspaceScratchDir } from "@/node/runtime/workspaceScratchDir";
import { ARTIFACTS_UNAVAILABLE_REASON, listArtifacts, readArtifact } from "./artifactsOperations";

describe("artifacts operations", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "artifacts-ops-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  function createContext(options: {
    enabled: boolean;
    runtimeConfig?: Record<string, unknown>;
  }): ORPCContext {
    const info = {
      id: "ws-art",
      name: "ws-art",
      projectPath: tempDir,
      projectName: "project",
      namedWorkspacePath: tempDir,
      runtimeConfig: options.runtimeConfig ?? { type: "local", srcBaseDir: tempDir },
    };
    return {
      config,
      workspaceService: {
        getInfo: mock((workspaceId: string) =>
          Promise.resolve(workspaceId === "ws-art" ? info : null)
        ),
      },
      experimentsService: { isExperimentEnabled: mock(() => options.enabled) },
    } as unknown as ORPCContext;
  }

  async function writeArtifact(relPath: string, content: string) {
    const dir = path.join(getWorkspaceScratchDir(config.sessionsDir, "ws-art"), "artifacts");
    await fsPromises.mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await fsPromises.writeFile(path.join(dir, relPath), content);
  }

  test("refuses every route while the experiment is off", async () => {
    const context = createContext({ enabled: false });
    const listError = await listArtifacts(context, { workspaceId: "ws-art" }).catch(
      (error: unknown) => error
    );
    const readError = await readArtifact(context, { workspaceId: "ws-art", path: "a.md" }).catch(
      (error: unknown) => error
    );
    expect(listError).toBeInstanceOf(Error);
    expect((listError as Error).message).toBe("Artifacts are disabled");
    expect(readError).toBeInstanceOf(Error);
    expect((readError as Error).message).toBe("Artifacts are disabled");
  });

  test("lists and reads the workspace scratch artifacts folder on local runtimes", async () => {
    await writeArtifact("report.md", "# Report");
    const context = createContext({ enabled: true });

    const listing = await listArtifacts(context, { workspaceId: "ws-art" });
    const read = await readArtifact(context, { workspaceId: "ws-art", path: "report.md" });

    expect(listing).toMatchObject({
      success: true,
      data: { available: true, entries: [{ path: "report.md", kind: "markdown" }] },
    });
    expect(read).toMatchObject({ success: true, data: { status: "ok", content: "# Report" } });
  });

  test("reports remote runtimes as unavailable instead of reading the host", async () => {
    const context = createContext({
      enabled: true,
      runtimeConfig: { type: "ssh", host: "example", srcBaseDir: "/home/u/src" },
    });

    expect(await listArtifacts(context, { workspaceId: "ws-art" })).toEqual({
      success: true,
      data: { available: false, reason: ARTIFACTS_UNAVAILABLE_REASON },
    });
    expect(await readArtifact(context, { workspaceId: "ws-art", path: "a.md" })).toEqual({
      success: false,
      error: ARTIFACTS_UNAVAILABLE_REASON,
    });
  });

  test("returns an error for unknown workspaces", async () => {
    const context = createContext({ enabled: true });
    expect(await listArtifacts(context, { workspaceId: "nope" })).toEqual({
      success: false,
      error: "Workspace not found: nope",
    });
  });
});
