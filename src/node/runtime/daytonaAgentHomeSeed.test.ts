import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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

/** The script's failure, or null when it succeeded. */
async function seedFailure(script: string): Promise<{ stderr?: string } | null> {
  try {
    await runSeedScript(script);
    return null;
  } catch (error) {
    return error as { stderr?: string };
  }
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

  // A snapshot may already hold a seed path as a link, e.g. `tool_env -> ~/.ssh/authorized_keys`.
  describe("a snapshot that already holds a seed destination", () => {
    const seed = (remotePath: string) =>
      buildAgentHomeSeedScript([
        { remotePath, content: Buffer.from("export JOBS=4\n"), executable: true },
      ]);

    it("replaces a destination symlink with a regular file, leaving its target alone", async () => {
      const keys = path.join(remoteHome, ".ssh", "authorized_keys");
      await fs.mkdir(path.dirname(keys), { recursive: true });
      await fs.writeFile(keys, "ssh-ed25519 AAAA user\n", { mode: 0o600 });
      await fs.mkdir(path.join(remoteHome, ".mux"));
      await fs.symlink(keys, path.join(remoteHome, ".mux", "tool_env"));
      // A dangling link would otherwise create its target.
      await fs.symlink(path.join(root, "created"), path.join(remoteHome, ".mux", "tool_pre"));

      await runSeedScript(
        buildAgentHomeSeedScript([
          { remotePath: "~/.mux/tool_env", content: Buffer.from("export A=1\n"), executable: true },
          { remotePath: "~/.mux/tool_pre", content: Buffer.from("exit 0\n"), executable: true },
        ])
      );

      expect(await fs.readFile(keys, "utf-8")).toBe("ssh-ed25519 AAAA user\n");
      expect((await fs.stat(keys)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(path.join(root, "created")).exists()).toBe(false);
      const written = path.join(remoteHome, ".mux", "tool_env");
      expect((await fs.lstat(written)).isFile()).toBe(true);
      expect(await fs.readFile(written, "utf-8")).toBe("export A=1\n");
      expect((await fs.stat(written)).mode & 0o777).toBe(0o755);
      expect((await fs.readdir(path.join(remoteHome, ".mux"))).sort()).toEqual([
        "tool_env",
        "tool_pre",
      ]);
    });

    it("refuses a symlinked directory on the way, writing nothing through it", async () => {
      const elsewhere = path.join(root, "elsewhere");
      await fs.mkdir(elsewhere);
      await fs.symlink(elsewhere, path.join(remoteHome, ".mux"));

      const failure = await seedFailure(seed("~/.mux/skills/deploy/SKILL.md"));

      expect(failure?.stderr).toContain("is a symlink");
      expect(await fs.readdir(elsewhere)).toEqual([]);
    });

    it("refuses a destination that is a directory instead of writing into it", async () => {
      await fs.mkdir(path.join(remoteHome, ".mux", "tool_env"), { recursive: true });

      const failure = await seedFailure(seed("~/.mux/tool_env"));

      expect(failure?.stderr).toContain("is a directory");
      expect(await fs.readdir(path.join(remoteHome, ".mux", "tool_env"))).toEqual([]);
    });
  });

  it("collects nothing when the host has no agent files", async () => {
    expect(await collectAgentHomeSeedFiles({ xumHome: hostXum, home: hostHome }, "~/.mux")).toEqual(
      []
    );
  });

  it("skips a file larger than the remaining seed budget, unread, and copies the rest", async () => {
    const huge = path.join(hostXum, "skills", "data", "model.bin");
    await fs.mkdir(path.dirname(huge), { recursive: true });
    await fs.writeFile(path.join(hostXum, "skills", "data", "SKILL.md"), "# data\n");
    // Sparse: 64 MiB on paper, no disk used.
    await fs.writeFile(huge, "");
    await fs.truncate(huge, 64 * 1024 * 1024);
    // Files after the oversized one still fit, in the same root and in the next one.
    await fs.mkdir(path.join(hostXum, "skills", "deploy"), { recursive: true });
    await fs.writeFile(path.join(hostXum, "skills", "deploy", "SKILL.md"), "# deploy\n");
    await fs.mkdir(path.join(hostHome, ".agents", "skills", "lint"), { recursive: true });
    await fs.writeFile(path.join(hostHome, ".agents", "skills", "lint", "SKILL.md"), "# lint\n");
    const readFile = spyOn(fs, "readFile");
    try {
      const files = await collectAgentHomeSeedFiles({ xumHome: hostXum, home: hostHome }, "~/.mux");

      expect(files.map((file) => file.remotePath)).toEqual([
        "~/.mux/skills/data/SKILL.md",
        "~/.mux/skills/deploy/SKILL.md",
        "~/.agents/skills/lint/SKILL.md",
      ]);
      expect(
        readFile.mock.calls.map(([file]) => (typeof file === "string" ? file : ""))
      ).not.toContain(huge);
    } finally {
      readFile.mockRestore();
    }
  });

  it("builds the script for a file of more base64 lines than a call takes arguments", () => {
    // Node refuses ~125k spread arguments (a 10 MiB file); Bun only ~640k, so 40 MiB here.
    const content = Buffer.alloc(40 * 1024 * 1024);
    const script = buildAgentHomeSeedScript([
      { remotePath: "~/.mux/skills/big/data.bin", content, executable: false },
    ]);
    expect(script.length).toBeGreaterThan(content.length);
  });

  it("follows symlinks only inside the skill being copied, except a linked skill itself", async () => {
    const secrets = path.join(hostHome, ".ssh");
    await fs.mkdir(secrets, { recursive: true });
    await fs.writeFile(path.join(secrets, "id_ed25519"), "PRIVATE KEY\n");
    const skill = path.join(hostXum, "skills", "deploy");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), "# deploy\n");
    // Links that escape the skill: a directory and a file.
    await fs.symlink(secrets, path.join(skill, "creds"));
    await fs.symlink(path.join(secrets, "id_ed25519"), path.join(skill, "key"));
    // A link that stays inside the skill.
    await fs.symlink(path.join(skill, "SKILL.md"), path.join(skill, "README.md"));
    // A skill directory linked into the skills root, as plugin installs and users do.
    const linkedTarget = path.join(root, "plugins", "lint");
    await fs.mkdir(linkedTarget, { recursive: true });
    await fs.writeFile(path.join(linkedTarget, "SKILL.md"), "# lint\n");
    await fs.symlink(linkedTarget, path.join(hostXum, "skills", "lint"));

    const files = await collectAgentHomeSeedFiles({ xumHome: hostXum, home: hostHome }, "~/.mux");

    expect(files.map((file) => file.remotePath).sort()).toEqual([
      "~/.mux/skills/deploy/README.md",
      "~/.mux/skills/deploy/SKILL.md",
      "~/.mux/skills/lint/SKILL.md",
    ]);
    expect(files.some((file) => file.content.toString().includes("PRIVATE KEY"))).toBe(false);
  });

  it("copies a directory of a skills root only when it is a skill", async () => {
    const secrets = path.join(hostHome, ".ssh");
    await fs.mkdir(secrets, { recursive: true });
    await fs.writeFile(path.join(secrets, "id_rsa"), "PRIVATE KEY\n");
    const skills = path.join(hostXum, "skills");
    await fs.mkdir(skills, { recursive: true });
    // A root entry linked to a directory that is no skill.
    await fs.symlink(secrets, path.join(skills, "keys"));
    // A plain directory without SKILL.md.
    await fs.mkdir(path.join(skills, "notes"));
    await fs.writeFile(path.join(skills, "notes", "todo.txt"), "todo\n");
    // A SKILL.md that is a link out of its directory does not make it a skill.
    await fs.mkdir(path.join(skills, "borrowed"));
    await fs.symlink(path.join(secrets, "id_rsa"), path.join(skills, "borrowed", "SKILL.md"));
    await fs.writeFile(path.join(skills, "borrowed", "extra.txt"), "extra\n");
    // A skill whose name discovery refuses.
    await fs.mkdir(path.join(skills, "Not_A_Skill"));
    await fs.writeFile(path.join(skills, "Not_A_Skill", "SKILL.md"), "# no\n");
    // A linked real skill is still copied.
    const linkedTarget = path.join(root, "plugins", "lint");
    await fs.mkdir(linkedTarget, { recursive: true });
    await fs.writeFile(path.join(linkedTarget, "SKILL.md"), "# lint\n");
    await fs.symlink(linkedTarget, path.join(skills, "lint"));

    const files = await collectAgentHomeSeedFiles({ xumHome: hostXum, home: hostHome }, "~/.mux");

    expect(files.map((file) => file.remotePath)).toEqual(["~/.mux/skills/lint/SKILL.md"]);
  });

  it("copies only skill directories of a skills root that is itself a link", async () => {
    const secrets = path.join(hostHome, ".ssh");
    await fs.mkdir(path.join(secrets, "keys"), { recursive: true });
    await fs.writeFile(path.join(secrets, "id_rsa"), "PRIVATE KEY\n");
    await fs.writeFile(path.join(secrets, "keys", "id_ed25519"), "PRIVATE KEY\n");
    await fs.mkdir(path.join(secrets, "lint"));
    await fs.writeFile(path.join(secrets, "lint", "SKILL.md"), "# lint\n");
    await fs.symlink(secrets, path.join(hostXum, "skills"));

    const files = await collectAgentHomeSeedFiles({ xumHome: hostXum, home: hostHome }, "~/.mux");

    expect(files.map((file) => file.remotePath)).toEqual(["~/.mux/skills/lint/SKILL.md"]);
  });
});
