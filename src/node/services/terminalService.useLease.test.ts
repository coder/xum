import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { TerminalCreateParams } from "@/common/types/terminal";
import type { Config, SecretsStore } from "@/node/config";
import type { PTYService } from "./ptyService";
import { TerminalService } from "./terminalService";
import {
  WorkspaceBusyError,
  WorkspaceMutationInProgressError,
  workspaceUseLeasesFor,
  type WorkspaceUseLeases,
} from "./workspaceUseLeases";

// #4476: an open terminal is cross-process evidence that this backend uses the workspace; another
// backend on the same Xum root must not rename or remove the checkout under the running shell.

const workspaceId = "ws-terminal-lease";
const params: TerminalCreateParams = { workspaceId, cols: 80, rows: 24 };
const idle = { hasRunningBackgroundProcesses: () => Promise.resolve(false) };
const secrets: Pick<SecretsStore, "getEffectiveSecrets"> = { getEffectiveSecrets: () => [] };

describe("TerminalService workspace use lease across two backends on one root", () => {
  let rootDir: string;
  let configB: Config;
  let leasesA: WorkspaceUseLeases;
  let leasesB: WorkspaceUseLeases;
  let exits: Array<(code: number) => void>;
  let createSession: ReturnType<typeof mock>;
  let sendInput: ReturnType<typeof mock>;
  let service: TerminalService;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-terminal-lease-"));
    configB = {
      rootDir,
      sessionsDir: path.join(rootDir, "sessions"),
      srcDir: rootDir,
      getAllWorkspaceMetadata: () =>
        Promise.resolve([
          {
            id: workspaceId,
            projectPath: rootDir,
            name: "main",
            namedWorkspacePath: rootDir,
            runtimeConfig: { type: "local" },
          },
        ]),
      loadConfigOrDefault: () => ({ projects: new Map(), terminalDefaultShell: undefined }),
    } as unknown as Config;
    leasesB = workspaceUseLeasesFor(configB);
    leasesA = workspaceUseLeasesFor({ rootDir });
    exits = [];
    let sessions = 0;
    createSession = mock(
      (
        request: TerminalCreateParams,
        _runtime: unknown,
        _path: string,
        _onData: unknown,
        onExit: (code: number) => void
      ) => {
        exits.push(onExit);
        return Promise.resolve({
          sessionId: `session-${++sessions}`,
          workspaceId: request.workspaceId,
          cols: 80,
          rows: 24,
        });
      }
    );
    sendInput = mock(() => undefined);
    const pty = {
      createSession,
      sendInput,
      closeSession: mock(() => undefined),
      closeWorkspaceSessions: mock(() => undefined),
      getWorkspaceSessionIds: mock(() => []),
    } as unknown as PTYService;
    service = new TerminalService(configB, pty, secrets);
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  /** B's queued lease transitions have landed (its per-workspace transition lock is FIFO). */
  const settledB = async () => (await leasesB.hold(workspaceId, "exec")).release();

  const gate = () =>
    leasesA.withMutationGate([workspaceId], idle, () => Promise.resolve("mutated"));

  test("an open terminal refuses A's mutation until the shell exits", async () => {
    await service.create(params);
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(1);
    let refused: unknown;
    await gate().catch((error: unknown) => (refused = error));
    expect(refused).toBeInstanceOf(WorkspaceBusyError);
    expect((refused as Error).message).toContain("terminal");

    exits[0](0);
    await settledB();
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(0);
    expect(await gate()).toBe("mutated");
  });

  test("close and closeWorkspaceSessions keep each lease until that shell actually exits", async () => {
    const first = await service.create(params);
    await service.create(params);
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(2);
    // Closing only signals the shell; it may still use the checkout until its exit event.
    service.close(first.sessionId);
    await settledB();
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(2);
    exits[0](0);
    await settledB();
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(1);
    service.closeWorkspaceSessions(workspaceId);
    await settledB();
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(1);
    exits[1](0);
    await settledB();
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(0);
  });

  test("an exit listener that throws does not keep the lease", async () => {
    const session = await service.create(params);
    service.onExit(session.sessionId, () => {
      throw new Error("stale subscriber");
    });
    expect(() => exits[0](0)).toThrow("stale subscriber");
    await settledB();
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(0);
  });

  test("a create that fails after the shell spawned keeps the lease until the shell exits", async () => {
    sendInput.mockImplementationOnce(() => {
      throw new Error("initial command failed");
    });
    let failed: unknown;
    await service
      .create({ ...params, initialCommand: "echo hi" })
      .catch((error: unknown) => (failed = error));
    expect((failed as Error).message).toBe("initial command failed");
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(1);
    exits[0](0);
    await settledB();
    expect(leasesB.heldCount(workspaceId, "terminal")).toBe(0);
  });

  test("no shell starts while A's mutation runs, and a failed spawn leaves no lease", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const mutation = leasesA.withMutationGate([workspaceId], idle, async () => {
      entered();
      await finished;
    });
    await inside;
    let refused: unknown;
    await service.create(params).catch((error: unknown) => (refused = error));
    expect(refused).toBeInstanceOf(WorkspaceMutationInProgressError);
    expect(createSession).not.toHaveBeenCalled();
    expect(leasesB.heldCount(workspaceId)).toBe(0);
    finish();
    await mutation;

    createSession.mockImplementationOnce(() => Promise.reject(new Error("spawn failed")));
    await service.create(params).catch(() => undefined);
    expect(leasesB.heldCount(workspaceId)).toBe(0);
    expect(await gate()).toBe("mutated");
  });
});
