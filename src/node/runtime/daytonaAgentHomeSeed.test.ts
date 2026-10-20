import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { buildAgentHomeSeedScript, collectAgentHomeSeedFiles } from "./daytonaAgentHomeSeed";

const execFileAsync = promisify(execFile);

let root: string;
let hostXum: string;
let hostHome: string;
let remoteHome: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "xum-seed-test-"));
  hostXum = path.join(root, "host", ".xum");
  hostHome = path.join(root, "host");
  remoteHome = path.join(root, "remote");
  await fs.mkdir(hostXum, { recursive: true });
  await fs.mkdir(remoteHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Run the generated script with sh as the remote would, with HOME at the fake remote home. */
async function runSeedScript(script: string): Promise<void> {
  const child = execFileAsync("sh", ["-s"], { env: { ...process.env, HOME: remoteHome } });
  child.child.stdin?.end(script);
  await child;
}

describe("agent-home seeding", () => {
  it("recreates hooks and global skills where the remote lookups read them", async () => {
    await fs.writeFile(path.join(hostXum, "tool_env"), "export JOBS=4\n");
    await fs.writeFile(path.join(hostXum, "tool_pre"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.mkdir(path.join(hostXum, "skills", "deploy", "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(hostXum, "skills", "deploy", "SKILL.md"),
      "# deploy 'quoted' $x\n"
    );
    await fs.writeFile(path.join(hostXum, "skills", "deploy", "scripts", "run.sh"), "echo hi\n", {
      mode: 0o755,
    });
    await fs.mkdir(path.join(hostHome, ".agents", "skills", "lint"), { recursive: true });
    await fs.writeFile(path.join(hostHome, ".agents", "skills", "lint", "SKILL.md"), "# lint\n");
    // A broken symlink must be skipped, not fail the seed.
    await fs.symlink(path.join(root, "nowhere"), path.join(hostXum, "skills", "broken"));

    const files = await collectAgentHomeSeedFiles({ xumHome: hostXum, home: hostHome }, "~/.mux");
    await runSeedScript(buildAgentHomeSeedScript(files));

    const read = (rel: string) => fs.readFile(path.join(remoteHome, rel), "utf-8");
    expect(await read(".mux/tool_env")).toBe("export JOBS=4\n");
    expect(await read(".mux/skills/deploy/SKILL.md")).toBe("# deploy 'quoted' $x\n");
    expect(await read(".agents/skills/lint/SKILL.md")).toBe("# lint\n");
    const toolPreMode = (await fs.stat(path.join(remoteHome, ".mux/tool_pre"))).mode;
    const scriptMode = (await fs.stat(path.join(remoteHome, ".mux/skills/deploy/scripts/run.sh")))
      .mode;
    const envMode = (await fs.stat(path.join(remoteHome, ".mux/tool_env"))).mode;
    expect(toolPreMode & 0o111).not.toBe(0);
    expect(scriptMode & 0o111).not.toBe(0);
    expect(envMode & 0o111).toBe(0);
  });

  it("collects nothing when the host has no agent files", async () => {
    expect(await collectAgentHomeSeedFiles({ xumHome: hostXum, home: hostHome }, "~/.mux")).toEqual(
      []
    );
  });
});
