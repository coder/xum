import { afterEach, describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  GIT_NO_HOOKS_ENV,
  gitHooksAllowed,
  gitNoHooksPrefix,
  gitNoRepoAutomationEnv,
  gitNoRepoAutomationEnvForConfigKeys,
  gitNoRepoAutomationEnvForLocalRepo,
} from "./gitNoHooksEnv";

describe("GIT_NO_HOOKS_ENV", () => {
  test("disables git hooks via core.hooksPath=/dev/null", () => {
    expect(GIT_NO_HOOKS_ENV).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_PARAMETERS: "",
    });
  });

  test("all values are strings (safe for env vars)", () => {
    for (const value of Object.values(GIT_NO_HOOKS_ENV)) {
      expect(typeof value).toBe("string");
    }
  });
});

describe("gitNoHooksPrefix", () => {
  test("returns empty string when trusted", () => {
    expect(gitNoHooksPrefix(true)).toBe("");
  });

  test("returns env prefix when untrusted (false)", () => {
    const prefix = gitNoHooksPrefix(false);
    expect(prefix).toContain("GIT_CONFIG_COUNT='12'");
    expect(prefix).toContain("core.hooksPath");
    expect(prefix).toContain("/dev/null");
    expect(prefix).toContain("GIT_CONFIG_PARAMETERS=");
    expect(prefix).toEndWith(" ");
  });

  test("returns env prefix when untrusted (undefined)", () => {
    const prefix = gitNoHooksPrefix(undefined);
    expect(prefix).toContain("GIT_CONFIG_COUNT='12'");
    expect(prefix).toEndWith(" ");
  });
});

describe("gitNoRepoAutomationEnv", () => {
  test("neutralizes every repo-controlled git execution vector", () => {
    const env = gitNoRepoAutomationEnv();
    // Hooks, fsmonitor, and credential helpers via env config entries.
    expect(env.GIT_CONFIG_COUNT).toBe("12");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/dev/null");
    expect(env.GIT_CONFIG_KEY_1).toBe("core.fsmonitor");
    expect(env.GIT_CONFIG_VALUE_1).toBe("false");
    expect(env.GIT_CONFIG_KEY_2).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_2).toBe("");
    expect(env.GIT_CONFIG_KEY_3).toBe("core.gitProxy");
    expect(env.GIT_CONFIG_VALUE_3).toBe("none");
    expect(env.GIT_CONFIG_KEY_4).toBe("core.askPass");
    expect(env.GIT_CONFIG_VALUE_4).toBe("");
    expect(env.GIT_CONFIG_KEY_5).toBe("commit.gpgSign");
    expect(env.GIT_CONFIG_VALUE_5).toBe("false");
    expect(env.GIT_CONFIG_KEY_6).toBe("tag.gpgSign");
    expect(env.GIT_CONFIG_VALUE_6).toBe("false");
    expect(env.GIT_CONFIG_KEY_7).toBe("gpg.program");
    expect(env.GIT_CONFIG_VALUE_7).toBe("");
    expect(env.GIT_CONFIG_KEY_8).toBe("gpg.openpgp.program");
    expect(env.GIT_CONFIG_VALUE_8).toBe("");
    expect(env.GIT_CONFIG_KEY_9).toBe("gpg.x509.program");
    expect(env.GIT_CONFIG_VALUE_9).toBe("");
    expect(env.GIT_CONFIG_KEY_10).toBe("gpg.ssh.program");
    expect(env.GIT_CONFIG_VALUE_10).toBe("");
    expect(env.GIT_CONFIG_KEY_11).toBe("core.alternateRefsCommand");
    expect(env.GIT_CONFIG_VALUE_11).toBe("");
    // Pointing the tracked attributes source at the empty tree suppresses
    // .gitattributes; the repo-aware builder below additionally overrides
    // drivers selected by highest-precedence .git/info/attributes.
    expect(env.GIT_ATTR_SOURCE).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    // Environment beats repo-config core.sshCommand.
    expect(env.GIT_SSH_COMMAND).toBe("ssh");
    expect(env.GIT_ALLOW_PROTOCOL).toBe("file:http:https:ssh:git");
    expect(env.GIT_EDITOR).toBe(":");
    expect(env.GIT_SEQUENCE_EDITOR).toBe(":");
  });

  test("blanks provider secret env vars so leaked processes capture nothing", () => {
    const env = gitNoRepoAutomationEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENAI_API_KEY).toBe("");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("");
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("");
    expect(env.XUM_RUN_SESSION_ROOT).toBe("");
    expect(env.MUX_RUN_SESSION_ROOT).toBe("");
  });

  test("rejects filter driver names that cannot be overridden safely", () => {
    const longName = "a".repeat(513);
    expect(() => gitNoRepoAutomationEnvForConfigKeys([`filter.${longName}.smudge`])).toThrow(
      "unsupported driver name"
    );
    expect(() => gitNoRepoAutomationEnvForConfigKeys([`diff.${longName}.command`])).toThrow(
      "unsupported driver name"
    );
    expect(() => gitNoRepoAutomationEnvForConfigKeys([`merge.${longName}.driver`])).toThrow(
      "unsupported driver name"
    );
    expect(() => gitNoRepoAutomationEnvForConfigKeys([`remote.${longName}.uploadpack`])).toThrow(
      "unsupported driver name"
    );
  });

  test("neutralizes filters selected by .git/info/attributes without mutating it", async () => {
    using tmp = new DisposableTempDir("git-filter-automation-off");
    const repo = path.join(tmp.path, "repo");
    const worktree = path.join(tmp.path, "worktree");
    const marker = path.join(tmp.path, "filter-ran");
    const driver = path.join(tmp.path, "smudge.sh");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "data.txt"), "payload\n", "utf-8");
    await Bun.$`git add data.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(
      driver,
      `#!/bin/sh\nprintf '%s' "\${ANTHROPIC_API_KEY-}" > "${marker}"\ncat\n`,
      "utf-8"
    );
    await fs.chmod(driver, 0o755);
    await Bun.$`git config filter.evil.smudge ${driver}`.cwd(repo).quiet();
    await Bun.$`git config filter.evil.required true`.cwd(repo).quiet();
    await fs.writeFile(
      path.join(repo, ".git", "info", "attributes"),
      "*.txt filter=evil\n",
      "utf-8"
    );

    const env = await gitNoRepoAutomationEnvForLocalRepo(repo);
    const filterKeys = Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
      .map(([, value]) => value);
    expect(filterKeys).toContain("filter.evil.smudge");
    expect(filterKeys).toContain("filter.evil.process");
    expect(filterKeys).toContain("filter.evil.required");

    await Bun.$`git worktree add ${worktree} -b safe-filter-checkout`
      .cwd(repo)
      .env({ ...process.env, ANTHROPIC_API_KEY: "secret", ...env })
      .quiet();
    expect(await fs.readFile(path.join(worktree, "data.txt"), "utf-8")).toBe("payload\n");
    expect(await fs.readFile(path.join(repo, ".git", "info", "attributes"), "utf-8")).toBe(
      "*.txt filter=evil\n"
    );
    let markerExists = true;
    try {
      await fs.access(marker);
    } catch {
      markerExists = false;
    }
    expect(markerExists).toBe(false);
  });

  test("neutralizes external diff drivers selected by .git/info/attributes", async () => {
    using tmp = new DisposableTempDir("git-diff-automation-off");
    const repo = path.join(tmp.path, "repo");
    const marker = path.join(tmp.path, "diff-ran");
    const driver = path.join(tmp.path, "diff.sh");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "data.txt"), "before\n", "utf-8");
    await Bun.$`git add data.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(driver, `#!/bin/sh\ntouch "${marker}"\n`, "utf-8");
    await fs.chmod(driver, 0o755);
    await Bun.$`git config diff.evil.command ${driver}`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, ".git", "info", "attributes"), "*.txt diff=evil\n", "utf-8");
    await fs.writeFile(path.join(repo, "data.txt"), "after\n", "utf-8");

    await Bun.$`git diff`.cwd(repo).quiet();
    await fs.access(marker);
    await fs.rm(marker);

    const env = await gitNoRepoAutomationEnvForLocalRepo(repo);
    const configKeys = Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
      .map(([, value]) => value);
    expect(configKeys).toContain("diff.evil.command");
    expect(configKeys).toContain("diff.evil.textconv");

    await Bun.$`git diff`
      .cwd(repo)
      .env({ ...process.env, ...env })
      .quiet()
      .nothrow();
    let markerExists = await fs.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);

    await Bun.$`git config --unset diff.evil.command`.cwd(repo).quiet();
    await Bun.$`git config diff.external ${driver}`.cwd(repo).quiet();
    await Bun.$`git diff`.cwd(repo).quiet();
    await fs.access(marker);
    await fs.rm(marker);

    const externalEnv = await gitNoRepoAutomationEnvForLocalRepo(repo);
    const externalConfigKeys = Object.entries(externalEnv)
      .filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
      .map(([, value]) => value);
    expect(externalConfigKeys).toContain("diff.external");
    await Bun.$`git diff`
      .cwd(repo)
      .env({ ...process.env, ...externalEnv })
      .quiet()
      .nothrow();
    markerExists = await fs.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);
  });

  test("neutralizes repo-configured upload-pack commands during fetch", async () => {
    using tmp = new DisposableTempDir("git-upload-pack-automation-off");
    const remote = path.join(tmp.path, "remote");
    const repo = path.join(tmp.path, "repo");
    const marker = path.join(tmp.path, "upload-pack-ran");
    const helper = path.join(tmp.path, "upload-pack.sh");
    await fs.mkdir(remote, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(remote).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(remote).quiet();
    await Bun.$`git config user.name Test`.cwd(remote).quiet();
    await fs.writeFile(path.join(remote, "data.txt"), "payload\n", "utf-8");
    await Bun.$`git add data.txt`.cwd(remote).quiet();
    await Bun.$`git commit -m init`.cwd(remote).quiet();
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git remote add origin ${remote}`.cwd(repo).quiet();
    await fs.writeFile(
      helper,
      `#!/bin/sh\ntouch "${marker}"\nexec git-upload-pack "$@"\n`,
      "utf-8"
    );
    await fs.chmod(helper, 0o755);
    await Bun.$`git config remote.origin.uploadpack ${helper}`.cwd(repo).quiet();

    await Bun.$`git fetch origin`.cwd(repo).quiet();
    await fs.access(marker);
    await fs.rm(marker);

    const env = await gitNoRepoAutomationEnvForLocalRepo(repo);
    await Bun.$`git fetch origin`
      .cwd(repo)
      .env({ ...process.env, ...env })
      .quiet()
      .nothrow();
    const markerExists = await fs.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);

    const configKeys = Object.entries(env)
      .filter(([key]) => key.startsWith("GIT_CONFIG_KEY_"))
      .map(([, value]) => value);
    expect(configKeys).toContain("remote.origin.uploadpack");
    expect(configKeys).toContain("remote.origin.receivepack");
    expect(configKeys).toContain("remote.origin.vcs");
  });

  test("disables repo-configured commit signing programs", async () => {
    using tmp = new DisposableTempDir("git-signing-automation-off");
    const repo = path.join(tmp.path, "repo");
    const marker = path.join(tmp.path, "signer-ran");
    const signer = path.join(tmp.path, "signer.sh");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "data.txt"), "payload\n", "utf-8");
    await Bun.$`git add data.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(signer, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, "utf-8");
    await fs.chmod(signer, 0o755);
    await Bun.$`git config commit.gpgSign true`.cwd(repo).quiet();
    await Bun.$`git config gpg.program ${signer}`.cwd(repo).quiet();

    await Bun.$`git commit --allow-empty -m unsafe`.cwd(repo).quiet().nothrow();
    await fs.access(marker);
    await fs.rm(marker);

    const env = gitNoRepoAutomationEnv();
    const result = await Bun.$`git commit --allow-empty -m safe`
      .cwd(repo)
      .env({ ...process.env, ...env })
      .quiet()
      .nothrow();
    expect(result.exitCode).toBe(0);
    const markerExists = await fs.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);
  });

  test("disables repo-configured commit editors", async () => {
    using tmp = new DisposableTempDir("git-editor-automation-off");
    const repo = path.join(tmp.path, "repo");
    const marker = path.join(tmp.path, "editor-ran");
    const editor = path.join(tmp.path, "editor.sh");
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(
      editor,
      `#!/bin/sh\ntouch "${marker}"\nprintf 'unsafe message\n' > "$1"\n`,
      "utf-8"
    );
    await fs.chmod(editor, 0o755);
    await Bun.$`git config core.editor ${editor}`.cwd(repo).quiet();

    const previousEditor = process.env.GIT_EDITOR;
    const previousSequenceEditor = process.env.GIT_SEQUENCE_EDITOR;
    delete process.env.GIT_EDITOR;
    delete process.env.GIT_SEQUENCE_EDITOR;
    try {
      await Bun.$`git commit --allow-empty`.cwd(repo).quiet().nothrow();
    } finally {
      if (previousEditor == null) delete process.env.GIT_EDITOR;
      else process.env.GIT_EDITOR = previousEditor;
      if (previousSequenceEditor == null) delete process.env.GIT_SEQUENCE_EDITOR;
      else process.env.GIT_SEQUENCE_EDITOR = previousSequenceEditor;
    }
    await fs.access(marker);
    await fs.rm(marker);

    delete process.env.GIT_EDITOR;
    delete process.env.GIT_SEQUENCE_EDITOR;
    let exitCode: number;
    try {
      const result = await Bun.$`git commit --allow-empty`
        .cwd(repo)
        .env({ ...process.env, ...gitNoRepoAutomationEnv() })
        .quiet()
        .nothrow();
      exitCode = result.exitCode;
    } finally {
      if (previousEditor == null) delete process.env.GIT_EDITOR;
      else process.env.GIT_EDITOR = previousEditor;
      if (previousSequenceEditor == null) delete process.env.GIT_SEQUENCE_EDITOR;
      else process.env.GIT_SEQUENCE_EDITOR = previousSequenceEditor;
    }
    expect(exitCode).not.toBe(0);
    const markerExists = await fs.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);
  });

  test("fails closed on non-UTF-8 filter driver names", async () => {
    using tmp = new DisposableTempDir("git-filter-non-utf8");
    const repo = path.join(tmp.path, "repo");
    const marker = path.join(tmp.path, "filter-ran");
    const driver = path.join(tmp.path, "smudge.sh");
    const driverName = Buffer.from([0x62, 0x61, 0x64, 0xff]);
    await fs.mkdir(repo, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Test`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "data.txt"), "payload\n", "utf-8");
    await Bun.$`git add data.txt`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(driver, `#!/bin/sh\ntouch "${marker}"\ncat\n`, "utf-8");
    await fs.chmod(driver, 0o755);
    await fs.appendFile(
      path.join(repo, ".git", "config"),
      Buffer.concat([
        Buffer.from('\n[filter "'),
        driverName,
        Buffer.from('"]\n\tsmudge = ' + driver + "\n\trequired = true\n"),
      ])
    );
    await fs.writeFile(
      path.join(repo, ".git", "info", "attributes"),
      Buffer.concat([Buffer.from("*.txt filter="), driverName, Buffer.from("\n")])
    );
    await fs.rm(path.join(repo, "data.txt"));

    await Bun.$`git checkout -- data.txt`
      .cwd(repo)
      .env({ ...process.env, ...gitNoRepoAutomationEnv(), LC_ALL: "C" })
      .quiet();
    await fs.access(marker);

    const previousLocale = process.env.LC_ALL;
    process.env.LC_ALL = "C.UTF-8";
    let rejection: unknown;
    try {
      await gitNoRepoAutomationEnvForLocalRepo(repo);
    } catch (error) {
      rejection = error;
    } finally {
      if (previousLocale == null) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(
      "Failed to inspect repository automation drivers"
    );
  });

  test("neutralizes core.alternateRefsCommand during alternate traversal", async () => {
    using tmp = new DisposableTempDir("git-alternate-refs-automation-off");
    const alternate = path.join(tmp.path, "alternate");
    const remote = path.join(tmp.path, "remote");
    const marker = path.join(tmp.path, "alternate-refs-ran");
    const helper = path.join(tmp.path, "alternate-refs.sh");
    for (const repo of [alternate, remote]) await fs.mkdir(repo, { recursive: true });
    for (const repo of [alternate, remote]) {
      await Bun.$`git init`.cwd(repo).quiet();
      await Bun.$`git config user.email test@example.com`.cwd(repo).quiet();
      await Bun.$`git config user.name Test`.cwd(repo).quiet();
      await fs.writeFile(path.join(repo, "data.txt"), "payload\n", "utf-8");
      await Bun.$`git add data.txt`.cwd(repo).quiet();
      await Bun.$`git commit -m init`.cwd(repo).quiet();
    }
    await fs.writeFile(
      path.join(remote, ".git", "objects", "info", "alternates"),
      path.join(alternate, ".git", "objects") + "\n",
      "utf-8"
    );
    await fs.writeFile(helper, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, "utf-8");
    await fs.chmod(helper, 0o755);
    await Bun.$`git config core.alternateRefsCommand ${helper}`.cwd(remote).quiet();
    await Bun.$`git rev-list --alternate-refs`.cwd(remote).quiet().nothrow();
    await fs.access(marker);
    await fs.rm(marker);

    await Bun.$`git rev-list --alternate-refs`
      .cwd(remote)
      .env({ ...process.env, ...gitNoRepoAutomationEnv() })
      .quiet()
      .nothrow();
    const markerExists = await fs.access(marker).then(
      () => true,
      () => false
    );
    expect(markerExists).toBe(false);
  });
});

describe("gitHooksAllowed", () => {
  const previousKillSwitch = process.env.MUX_DISABLE_PROJECT_AUTOMATION;

  afterEach(() => {
    if (previousKillSwitch === undefined) {
      delete process.env.MUX_DISABLE_PROJECT_AUTOMATION;
    } else {
      process.env.MUX_DISABLE_PROJECT_AUTOMATION = previousKillSwitch;
    }
  });

  test("hooks run only for trusted projects", () => {
    delete process.env.MUX_DISABLE_PROJECT_AUTOMATION;
    expect(gitHooksAllowed(true)).toBe(true);
    expect(gitHooksAllowed(false)).toBe(false);
    expect(gitHooksAllowed(undefined)).toBe(false);
  });

  test("the automation kill-switch neutralizes hooks even when trusted", () => {
    process.env.MUX_DISABLE_PROJECT_AUTOMATION = "1";
    // Dataset-planted .git/hooks must not execute during git operations
    // (worktree add for task forks, bash-tool git commands) even though the
    // project keeps config trust for delegation.
    expect(gitHooksAllowed(true)).toBe(false);
    const prefix = gitNoHooksPrefix(true);
    expect(prefix).toContain("core.hooksPath");
    // Checkout filters and provider secrets are suppressed in the same
    // prefix, covering remote (SSH/Docker) materialization paths.
    expect(prefix).toContain("GIT_ATTR_SOURCE=");
    expect(prefix).toContain("ANTHROPIC_API_KEY='' ");
  });
});
