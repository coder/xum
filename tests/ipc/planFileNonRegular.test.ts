/**
 * Native-Node regression for plan-file reader starvation: a non-regular plan path (FIFO without a
 * writer) must not park libuv workers. Six concurrent `workspace.getPlanContent` reads must settle
 * promptly with a safe error while an unrelated filesystem operation and a config-backed RPC keep
 * answering. Runs under Jest on Node because Bun's fs pool does not reproduce libuv threadpool
 * exhaustion. Deliberately free of plan-review APIs so it is usable as a standalone prerequisite.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { drainFifoReaders } from "./fifoRelease";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
} from "./helpers";
import {
  cleanupTestEnvironment,
  createTestEnvironment,
  shouldRunIntegrationTests,
  type TestEnvironment,
} from "./setup";

const describeIntegration =
  shouldRunIntegrationTests() && process.platform !== "win32" ? describe : describe.skip;

async function settleWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describeIntegration("plan file readers on a non-regular plan path", () => {
  let env: TestEnvironment;
  let repoPath: string;
  let workspaceId: string;
  let planPath: string;

  beforeAll(async () => {
    repoPath = await createTempGitRepo();
    env = await createTestEnvironment();
    const created = await createWorkspace(env, repoPath, generateBranchName("plan-nonregular"));
    if (!created.success) throw new Error(`Workspace creation failed: ${created.error}`);
    workspaceId = created.metadata.id;
    planPath = expandTilde(getPlanFilePath(created.metadata.name, created.metadata.projectName));
    await fs.mkdir(planPath.slice(0, planPath.lastIndexOf("/")), { recursive: true });
  }, 150_000);

  afterAll(async () => {
    try {
      // Each test drains its own FIFO readers in its finally block (see below), so plain async
      // cleanup is safe here even after a RED run.
      await fs.rm(planPath, { force: true });
      await fs.rm(planPath + ".real", { force: true });
    } finally {
      if (env) {
        await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        await cleanupTestEnvironment(env);
      }
      if (repoPath) await cleanupTempGitRepo(repoPath);
    }
  }, 60_000);

  test("six concurrent plan reads on a writer-less FIFO settle safely and leave the pool usable", async () => {
    await fs.rm(planPath, { force: true });
    execFileSync("mkfifo", [planPath]);

    const reads = Array.from({ length: 6 }, () =>
      env.orpc.workspace.getPlanContent({ workspaceId })
    );
    let drain: Awaited<ReturnType<typeof drainFifoReaders>> | undefined;
    try {
      // Unrelated filesystem work and a config-backed RPC must not queue behind plan reads.
      const started = performance.now();
      await settleWithin(fs.stat(env.config.rootDir), 2000, "unrelated fs.stat");
      const listed = await settleWithin(env.orpc.workspace.list({}), 5000, "workspace.list");
      expect(listed.some((w) => w.id === workspaceId)).toBe(true);
      expect(performance.now() - started).toBeLessThan(5000);

      const settled = await settleWithin(Promise.all(reads), 5000, "6 x getPlanContent");
      for (const r of settled) {
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error).toMatch(/Plan file not found/);
      }
    } finally {
      // Owned cleanup that also works on a RED run: keep releasing the FIFO until all six read
      // attempts have actually settled, so the next (healthy) control test gets a usable pool.
      drain = await drainFifoReaders(planPath, reads);
      await fs.rm(planPath, { force: true });
    }
    expect(drain.settled).toBe(true);
  }, 30_000);

  test("regular file and symlink to a regular file read normally", async () => {
    const content = "# Plan\n\nStep one.\n";
    await fs.rm(planPath, { force: true });
    await fs.writeFile(planPath + ".real", content);
    await fs.symlink(planPath + ".real", planPath);
    const viaLink = await env.orpc.workspace.getPlanContent({ workspaceId });
    expect(viaLink.success).toBe(true);
    if (viaLink.success) expect(viaLink.data.content).toBe(content);
    await fs.rm(planPath, { force: true });
    await fs.writeFile(planPath, content);
    const direct = await env.orpc.workspace.getPlanContent({ workspaceId });
    expect(direct.success).toBe(true);
    if (direct.success) expect(direct.data.content).toBe(content);
  }, 30_000);
});
