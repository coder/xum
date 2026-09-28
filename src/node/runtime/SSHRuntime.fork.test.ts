/**
 * Regression tests for SSHRuntime.forkWorkspace.
 *
 * These tests exist to lock in two safety invariants that, when broken, have
 * caused live SSH workspaces to be silently wiped on the remote host:
 *
 *   1. Forks ALWAYS land at the canonical project root (`<srcBaseDir>/<projectId>/<name>`),
 *      regardless of where the source workspace's persisted path lives. Legacy
 *      workspaces from before #3125 sit at `<srcBaseDir>/<basename>/<name>` —
 *      inheriting their parent dir is what triggered the worktree-add failure
 *      cleanup that wiped sibling workspaces.
 *
 *   2. Every `rm -rf` issued by forkWorkspace targets a per-attempt staging
 *      directory (`.mux-fork-staging-<12 hex>`), never the final workspace
 *      path. Even when `git worktree add` or `cp -R -P` leaves a partial,
 *      cleanup operates exclusively on the unique staging name and therefore
 *      cannot destroy a sibling workspace.
 *
 * The tests drive a real SSHRuntime instance through a mocked `exec()` that
 * dispatches on substring patterns. We assert on the *exact* command strings
 * issued, because the safety property we care about is "no rm -rf ever runs
 * against the final workspace path".
 */

import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecStream, InitLogger, WorkspaceForkParams } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import type { PtyHandle, PtySessionParams, SSHTransport } from "./transports";

const noop = (): void => undefined;
const noopAsync = (): Promise<void> => Promise.resolve();

const noopInitLogger: InitLogger = {
  logStep: noop,
  logStdout: noop,
  logStderr: noop,
  logComplete: noop,
};

function createMockTransport(config: SSHRuntimeConfig): SSHTransport {
  return {
    spawnRemoteProcess() {
      return Promise.reject(new Error("Unexpected transport use in SSHRuntime fork test"));
    },
    isConnectionFailure() {
      return false;
    },
    acquireConnection() {
      return Promise.resolve();
    },
    getConfig() {
      return config;
    },
    createPtySession(_params: PtySessionParams): Promise<PtyHandle> {
      return Promise.reject(new Error("Unexpected PTY creation in SSHRuntime fork test"));
    },
  };
}

function createTextStream(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.byteLength > 0) {
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
}

const discardChunk = (_chunk: Uint8Array): Promise<void> => Promise.resolve();

function createExecStream(stdout: string, stderr = "", exitCode = 0): ExecStream {
  return {
    stdout: createTextStream(stdout),
    stderr: createTextStream(stderr),
    stdin: new WritableStream<Uint8Array>({
      write: discardChunk,
      close: noopAsync,
      abort: noopAsync,
    }),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

interface CannedResponse {
  /** Substring that must appear anywhere in the command. */
  matches: (command: string) => boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

class ForkTestSSHRuntime extends SSHRuntime {
  readonly commands: string[] = [];
  readonly canned: CannedResponse[] = [];

  constructor(
    srcBaseDir: string,
    workspacePathOverride?: { project: string; name: string; path: string }
  ) {
    const config: SSHRuntimeConfig = {
      host: "example.test",
      srcBaseDir,
    };
    super(
      config,
      createMockTransport(config),
      workspacePathOverride
        ? {
            projectPath: workspacePathOverride.project,
            workspaceName: workspacePathOverride.name,
            workspacePath: workspacePathOverride.path,
          }
        : undefined
    );
  }

  override exec(command: string, _options: ExecOptions): Promise<ExecStream> {
    this.commands.push(command);
    for (const c of this.canned) {
      if (c.matches(command)) {
        return Promise.resolve(createExecStream(c.stdout ?? "", c.stderr ?? "", c.exitCode ?? 0));
      }
    }
    // Default: succeed silently. Tests pin the responses they care about.
    return Promise.resolve(createExecStream(""));
  }
}

function buildForkParams(overrides: Partial<WorkspaceForkParams> = {}): WorkspaceForkParams {
  return {
    projectPath: "/Users/me/Projects/coder/mux",
    sourceWorkspaceName: "feature-source",
    newWorkspaceName: "feature-new",
    initLogger: noopInitLogger,
    trusted: true,
    ...overrides,
  };
}

describe("SSHRuntime.forkWorkspace canonical-layout invariant", () => {
  it("computes the new workspace path from the canonical project layout, ignoring the source's persisted parent", async () => {
    // Source is at the LEGACY path (pre-#3125), simulating an unmigrated workspace.
    const runtime = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux/feature-source", // legacy: <basename>/<name>
    });

    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 }, // destination doesn't exist
      {
        matches: (c) => c.includes("branch --show-current"),
        stdout: "feature-source\n",
        exitCode: 0,
      },
      { matches: (c) => c.startsWith("test -d "), exitCode: 0 }, // base repo exists
      { matches: (c) => c.includes("worktree add "), exitCode: 0 }, // worktree add succeeds
      // Finalize step embeds the collision check + `git worktree move` in one shell line.
      { matches: (c) => c.includes("worktree move "), exitCode: 0 }
    );

    const result = await runtime.forkWorkspace(buildForkParams());

    expect(result.success).toBe(true);
    // CRITICAL: the new workspace's path must be under the canonical hashed
    // project root, NOT under the legacy `<basename>/` parent.
    expect(result.workspacePath).toMatch(/^\/remote\/src\/mux-[0-9a-f]{12}\/feature-new$/);
  });

  it("uses the canonical project root for the worktree-add target even when source is legacy", async () => {
    const runtime = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux/feature-source",
    });

    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
      {
        matches: (c) => c.includes("branch --show-current"),
        stdout: "feature-source\n",
        exitCode: 0,
      },
      { matches: (c) => c.startsWith("test -d "), exitCode: 0 },
      { matches: (c) => c.includes("worktree add "), exitCode: 0 },
      { matches: (c) => c.includes("worktree move "), exitCode: 0 }
    );

    await runtime.forkWorkspace(buildForkParams());

    const worktreeAddCmd = runtime.commands.find((c) => c.includes("worktree add "));
    expect(worktreeAddCmd).toBeDefined();
    // The staging path lives under the canonical project root, not under the
    // legacy `<basename>/` parent.
    expect(worktreeAddCmd!).toMatch(
      /\/remote\/src\/mux-[0-9a-f]{12}\/\.mux-fork-staging-[0-9a-f]{12}/
    );
    expect(worktreeAddCmd!).not.toContain("/remote/src/mux/feature-new");
  });
});

describe("SSHRuntime.forkWorkspace rm-rf-cannot-wipe-siblings invariant", () => {
  it("never issues `rm -rf` against the final workspace path on a failed worktree add", async () => {
    const runtime = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });

    let worktreeAddCalls = 0;
    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
      {
        matches: (c) => c.includes("branch --show-current"),
        stdout: "only-on-legacy\n",
        exitCode: 0,
      },
      { matches: (c) => c.startsWith("test -d "), exitCode: 0 },
      // First worktree add (in staging) FAILS — branch doesn't exist in base repo.
      {
        matches: (c) => {
          if (c.includes("worktree add ")) {
            worktreeAddCalls++;
            return true;
          }
          return false;
        },
        stderr: "fatal: invalid reference: only-on-legacy\n",
        exitCode: 128,
      },
      // cp -R -P fallback succeeds.
      { matches: (c) => c.startsWith("cp -R -P "), exitCode: 0 },
      // Final `mv` succeeds.
      { matches: (c) => c.includes("mv ") && c.includes("MUX_FORK_COLLISION"), exitCode: 0 }
    );

    await runtime.forkWorkspace(buildForkParams());

    expect(worktreeAddCalls).toBe(1);

    // The whole point: across ALL commands issued, no rm -rf may target the
    // final workspace path. Every rm -rf is confined to a `.mux-fork-staging-*`
    // path that this fork attempt uniquely owns.
    for (const cmd of runtime.commands) {
      if (cmd.startsWith("rm -rf ")) {
        expect(cmd).toContain(".mux-fork-staging-");
        expect(cmd).not.toContain('feature-new"');
        expect(cmd).not.toMatch(/\/feature-new(\s|$)/);
      }
    }
  });

  it("cleans up the staging path (but not the destination) when cp -R -P fails", async () => {
    const runtime = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });

    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
      {
        matches: (c) => c.includes("branch --show-current"),
        stdout: "feature-source\n",
        exitCode: 0,
      },
      { matches: (c) => c.startsWith("test -d "), exitCode: 1 }, // base repo missing → cp fallback
      { matches: (c) => c.startsWith("mkdir -p "), exitCode: 0 },
      { matches: (c) => c.startsWith("cp -R -P "), stderr: "cp: cannot stat source\n", exitCode: 1 }
    );

    const result = await runtime.forkWorkspace(buildForkParams());

    expect(result.success).toBe(false);

    const rmCmds = runtime.commands.filter((c) => c.startsWith("rm -rf "));
    expect(rmCmds.length).toBeGreaterThan(0);
    for (const cmd of rmCmds) {
      expect(cmd).toContain(".mux-fork-staging-");
      // Never the canonical destination.
      expect(cmd).not.toMatch(/\/feature-new(\s|"|$)/);
    }
  });

  it("uses `git worktree move` (not raw mv) to finalize a worktree fork so the bare repo's gitdir back-reference is updated", async () => {
    const runtime = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });

    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
      {
        matches: (c) => c.includes("branch --show-current"),
        stdout: "feature-source\n",
        exitCode: 0,
      },
      { matches: (c) => c.startsWith("test -d "), exitCode: 0 },
      { matches: (c) => c.includes("worktree add "), exitCode: 0 },
      { matches: (c) => c.includes("worktree move "), exitCode: 0 }
    );

    const result = await runtime.forkWorkspace(buildForkParams());

    expect(result.success).toBe(true);
    const finalizeCmd = runtime.commands.find((c) => c.includes("worktree move "));
    expect(finalizeCmd).toBeDefined();
    expect(finalizeCmd!).toContain("MUX_FORK_COLLISION"); // collision-guard prelude
    expect(finalizeCmd!).toMatch(/\.mux-fork-staging-[0-9a-f]{12}/);
    expect(finalizeCmd!).toMatch(/\/feature-new(\s|"|$)/);
  });

  it("aborts the fork (without destroying the destination) when the finalize step detects a destination collision", async () => {
    const runtime = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });

    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 }, // initial guard passes
      {
        matches: (c) => c.includes("branch --show-current"),
        stdout: "feature-source\n",
        exitCode: 0,
      },
      { matches: (c) => c.startsWith("test -d "), exitCode: 0 },
      { matches: (c) => c.includes("worktree add "), exitCode: 0 },
      // Finalize trips the collision branch — the destination was created by
      // a concurrent process between the initial `test -e` and now.
      { matches: (c) => c.includes("worktree move "), stdout: "MUX_FORK_COLLISION\n", exitCode: 7 }
    );

    const result = await runtime.forkWorkspace(buildForkParams());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/created by another process/);

    // The collision-cleanup MUST target the staging worktree, NOT the
    // existing destination workspace.
    const removeCmds = runtime.commands.filter(
      (c) => c.includes("worktree remove --force ") || c.startsWith("rm -rf ")
    );
    expect(removeCmds.length).toBeGreaterThan(0);
    for (const cmd of removeCmds) {
      expect(cmd).toContain(".mux-fork-staging-");
      expect(cmd).not.toMatch(/\/feature-new(\s|"|$)/);
    }
  });
});

describe("SSHRuntime.forkWorkspace cp-fallback finalize race", () => {
  it("detects when a concurrent cp-fallback fork nested our staging dir under the destination and reports a collision instead of returning a bogus path", async () => {
    // Scenario: two forks race the cp-fallback path with the same
    // `newWorkspaceName`. Fork A passes its initial `test -e`, wins the
    // `mv`, and lands at `<dest>`. Fork B also passes its `test -e` (because
    // A hadn't `mv`-ed yet) but by the time B's `mv` runs, `<dest>` exists
    // as a directory — shell `mv <src-dir> <existing-dir>` then nests B's
    // staging dir under `<dest>` instead of failing. We simulate Fork B
    // here: the inline finalize script encodes the post-hoc nesting detector
    // so the exit code drops to 7 and the cleanup removes only the nested
    // staging dir (NOT Fork A's destination contents).
    const runtime = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });

    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
      {
        matches: (c) => c.includes("branch --show-current"),
        stdout: "feature-source\n",
        exitCode: 0,
      },
      { matches: (c) => c.startsWith("test -d "), exitCode: 1 }, // no base repo → cp fallback
      { matches: (c) => c.startsWith("mkdir -p "), exitCode: 0 },
      { matches: (c) => c.startsWith("cp -R -P "), exitCode: 0 },
      // The finalize script reports MUX_FORK_COLLISION because the post-hoc
      // nesting detector fired. Exit code 7 = collision.
      {
        matches: (c) =>
          c.includes("MUX_FORK_COLLISION") && c.includes(".mux-fork-staging-") && c.includes("mv "),
        stdout: "MUX_FORK_COLLISION\n",
        exitCode: 7,
      }
    );

    const result = await runtime.forkWorkspace(buildForkParams());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/created by another process/);

    // The finalize script must contain the post-hoc nesting detector that
    // removes only the nested staging dir under the destination. This is
    // the structural guarantee that protects Fork A's contents.
    const finalizeCmd = runtime.commands.find(
      (c) => c.includes("MUX_FORK_COLLISION") && c.includes("mv ")
    );
    expect(finalizeCmd).toBeDefined();
    // The detector path: `<dest>/<stagingName>` — we rm only that nested
    // path, never the destination itself. `shescape.quote` uses single
    // quotes for `stagingName` and execBuffered's path arg uses double
    // quotes for `newWorkspacePath`, so the concatenation produces
    // `"<dest>"/'<stagingName>'`, which the shell resolves to a single
    // word `<dest>/<stagingName>`.
    expect(finalizeCmd!).toMatch(
      /rm -rf\s+"\/remote\/src\/mux-[0-9a-f]{12}\/feature-new"\/'\.mux-fork-staging-[0-9a-f]{12}'/
    );
    // And critically: nowhere in the script does `rm -rf <dest>` appear
    // without the nested staging suffix immediately after — that would be
    // the destructive form that wiped real workspaces.
    expect(finalizeCmd!).not.toMatch(
      /rm -rf\s+"\/remote\/src\/mux-[0-9a-f]{12}\/feature-new"(\s|;|$)/
    );
  });
});

describe("SSHRuntime.forkWorkspace staging-name uniqueness", () => {
  it("uses a fresh staging id on every fork attempt", async () => {
    const runtime1 = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });
    const runtime2 = new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });

    for (const r of [runtime1, runtime2]) {
      r.canned.push(
        { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
        {
          matches: (c) => c.includes("branch --show-current"),
          stdout: "feature-source\n",
          exitCode: 0,
        },
        { matches: (c) => c.startsWith("test -d "), exitCode: 0 },
        { matches: (c) => c.includes("worktree add "), exitCode: 0 },
        { matches: (c) => c.includes("worktree move "), exitCode: 0 }
      );
    }

    await runtime1.forkWorkspace(buildForkParams());
    await runtime2.forkWorkspace(buildForkParams());

    const extract = (cmds: string[]): string => {
      const match = cmds
        .map((c) => /\.mux-fork-staging-([0-9a-f]{12})/.exec(c)?.[1])
        .find((m): m is string => Boolean(m));
      if (!match) throw new Error("no staging id observed");
      return match;
    };

    expect(extract(runtime1.commands)).not.toBe(extract(runtime2.commands));
  });
});

// Fork rollbacks delete the fork's branch only when the fork reports creating it (#5119).
describe("SSHRuntime.forkWorkspace createdBranch", () => {
  function createRuntime(): ForkTestSSHRuntime {
    return new ForkTestSSHRuntime("/remote/src", {
      project: "/Users/me/Projects/coder/mux",
      name: "feature-source",
      path: "/remote/src/mux-canonical/feature-source",
    });
  }

  it("reports the branch its own `worktree add -b` created", async () => {
    const runtime = createRuntime();
    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
      { matches: (c) => c.includes("branch --show-current"), stdout: "feature-source\n" },
      { matches: (c) => c.startsWith("test -d "), exitCode: 0 },
      { matches: (c) => c.includes("worktree add -b "), exitCode: 0 },
      { matches: (c) => c.includes("worktree move "), exitCode: 0 }
    );

    const result = await runtime.forkWorkspace(buildForkParams());

    expect(result.success).toBe(true);
    expect(result.createdBranch).toBe(true);
  });

  it("does not claim the branch when `worktree add -b` failed and the copy fallback ran", async () => {
    // `worktree add -b` fails when the branch already exists; the fallback may then check out
    // that existing branch, which a rollback must keep.
    const runtime = createRuntime();
    runtime.canned.push(
      { matches: (c) => c.startsWith("test -e "), exitCode: 1 },
      { matches: (c) => c.includes("branch --show-current"), stdout: "feature-source\n" },
      { matches: (c) => c.startsWith("test -d "), exitCode: 0 },
      {
        matches: (c) => c.includes("worktree add -b "),
        stderr: "fatal: a branch named 'feature-new' already exists\n",
        exitCode: 128,
      }
    );

    const result = await runtime.forkWorkspace(buildForkParams());

    expect(result.success).toBe(true);
    expect(runtime.commands.some((c) => c.startsWith("cp -R -P "))).toBe(true);
    expect(result.createdBranch).not.toBe(true);
  });
});
