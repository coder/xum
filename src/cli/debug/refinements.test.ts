import { describe, expect, it } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { appendRefinementEvent } from "@/node/services/refinement/refinementJournal";
import { TestTempDir } from "@/node/services/tools/testHelpers";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const DEBUG_CLI_ENTRY = path.join(import.meta.dir, "index.ts");

/**
 * Fixture session: one skill-write row whose inverse deletes the file it
 * created, inside a `<root>/sessions/<ws>` layout so the confinement roots
 * resolve like a real mux home.
 */
async function seedFixture(root: string): Promise<{ skillFile: string }> {
  const sessionDir = path.join(root, "sessions", "ws-cli");
  const skillFile = path.join(root, "checkout", ".mux", "skills", "cli-skill", "SKILL.md");
  await fsPromises.mkdir(path.dirname(skillFile), { recursive: true });
  await fsPromises.writeFile(skillFile, "---\nname: cli-skill\n---\n", "utf-8");
  await appendRefinementEvent({
    sessionDir,
    workspaceId: "ws-cli",
    kind: "skill",
    action: { op: "write", skillName: "cli-skill", filePath: "SKILL.md" },
    inverse: { op: "delete-files", paths: [skillFile] },
    evidence: { toolName: "agent_skill_write" },
  });
  return { skillFile };
}

/**
 * Runs the real `bun debug refinements` entry point against `root`: the
 * session dir is derived from XUM_ROOT exactly as for a user's home, so the
 * test also covers index.ts's argument wiring and exit status.
 */
async function runRefinementsCli(
  root: string,
  args: string[]
): Promise<{ stdoutLines: string[]; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = { ...process.env, XUM_ROOT: root };
  // The legacy alias is only a fallback, but clear it so an inherited value
  // can never be what the child resolves.
  delete env.MUX_ROOT;
  const proc = Bun.spawn([process.execPath, DEBUG_CLI_ENTRY, "refinements", "ws-cli", ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdoutLines: stdout.split("\n").filter((line) => line.length > 0), stderr, exitCode };
}

describe("debug refinements command", () => {
  it("lists rows and performs a rollback with lineage output", async () => {
    using tempDir = new TestTempDir("test-debug-refinements");
    const { skillFile } = await seedFixture(tempDir.path);

    const listed = await runRefinementsCli(tempDir.path, []);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdoutLines).toHaveLength(1);
    expect(listed.stdoutLines[0]).toContain("skill");
    expect(listed.stdoutLines[0]).toContain("write cli-skill/SKILL.md");
    const rowId = listed.stdoutLines[0].split("  ")[0];

    const rolledBack = await runRefinementsCli(tempDir.path, ["--rollback", rowId]);
    expect(rolledBack.exitCode).toBe(0);
    expect(rolledBack.stdoutLines.some((line) => line === `deleted ${skillFile}`)).toBe(true);
    expect(rolledBack.stdoutLines.some((line) => line.includes(`rollbackOf ${rowId}`))).toBe(true);
    const stillExists = await fsPromises.access(skillFile).then(
      () => true,
      () => false
    );
    expect(stillExists).toBe(false);

    // The list now shows the rollback row with its lineage.
    const relisted = await runRefinementsCli(tempDir.path, []);
    expect(relisted.exitCode).toBe(0);
    expect(relisted.stdoutLines).toHaveLength(2);
    expect(relisted.stdoutLines[1]).toContain(`rollbackOf=${rowId}`);
  }, 30_000);

  it("reports refusals on stderr and sets a failing exit code", async () => {
    using tempDir = new TestTempDir("test-debug-refinements-refuse");
    await seedFixture(tempDir.path);

    const refused = await runRefinementsCli(tempDir.path, ["--rollback", "missing-id"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("No refinement row");
  }, 30_000);
});
