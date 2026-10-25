/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
/**
 * Codex hook trust through the install service, against a real local git "remote": install
 * trusts nothing, trust applies to one exact hash, a changed hook needs review again, and an
 * uninstall drops trust.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import { execFileAsync } from "@/node/utils/disposableExec";
import { AgentPluginInstallService } from "./installService";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { computePluginInstanceId } from "./mcpConfig";
import { getPluginHookTrustPath } from "./pluginHookTrust";
import { PLUGIN_REGISTRY_FILE_NAME } from "./registry";

async function git(cwd: string, ...args: string[]): Promise<string> {
  using proc = execFileAsync("git", [`-C`, cwd, ...args]);
  return (await proc.result).stdout;
}

const scan = { type: "mcp_tool", server: "scanner", tool: "scan" };
const hooksDocument = (input: Record<string, unknown> = {}) => ({
  hooks: {
    PreToolUse: [{ matcher: "^bash$", hooks: [{ ...scan, input }] }],
    Stop: [{ hooks: [{ type: "command", command: "./stop.sh" }] }],
  },
});

describe("AgentPluginInstallService hook trust", () => {
  let xumRoot: string;
  let remoteDir: string;
  let service: AgentPluginInstallService;
  const installedHooksFile = () => path.join(xumRoot, "plugins", "guard", "hooks", "hooks.json");

  async function install(): Promise<void> {
    const preview = await service.preview({ input: remoteDir });
    await service.install({ source: preview.source, expectedSha: preview.lockedSha });
  }

  beforeEach(async () => {
    xumRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-hook-trust-"));
    remoteDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-hook-trust-remote-"));
    service = new AgentPluginInstallService(new Config(xumRoot), {});
    await git(remoteDir, "init", "-q", "-b", "main");
    await git(remoteDir, "config", "user.email", "test@example.com");
    await git(remoteDir, "config", "user.name", "Test");
    await fsPromises.writeFile(
      path.join(remoteDir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "guard", version: "1.0.0" })
    );
    await fsPromises.mkdir(path.join(remoteDir, "hooks"));
    await fsPromises.writeFile(
      path.join(remoteDir, "hooks", "hooks.json"),
      JSON.stringify(hooksDocument())
    );
    await git(remoteDir, "add", "-A");
    await git(remoteDir, "commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    await fsPromises.rm(xumRoot, { recursive: true, force: true });
    await fsPromises.rm(remoteDir, { recursive: true, force: true });
  });

  test("the consent preview lists every hooks.json hook", async () => {
    const preview = await service.preview({ input: remoteDir });
    expect(preview.codexHooks.map((hook) => [hook.event, hook.status])).toEqual([
      ["PreToolUse", "runnable"],
      ["Stop", "unsupported-handler"],
    ]);
  });

  test("install trusts nothing; trust applies to the reviewed hash only", async () => {
    await install();
    const { hooks } = await service.getHooks({ name: "guard" });
    expect(hooks.map((hook) => [hook.event, hook.status, hook.review])).toEqual([
      ["PreToolUse", "runnable", "new"],
      ["Stop", "unsupported-handler", "new"],
    ]);
    const [scanHook, commandHook] = hooks;

    await service.setHookTrust({
      name: "guard",
      key: scanHook.key,
      hash: scanHook.hash,
      state: "trusted",
    });
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("trusted");

    // A command hook never runs, so it cannot be trusted.
    await expect(
      service.setHookTrust({
        name: "guard",
        key: commandHook.key,
        hash: commandHook.hash,
        state: "trusted",
      })
    ).rejects.toThrow("cannot be trusted");

    // The definition changes (an update, or an edit in place): it needs review again.
    await fsPromises.writeFile(installedHooksFile(), JSON.stringify(hooksDocument({ cmd: "x" })));
    const [changed] = (await service.getHooks({ name: "guard" })).hooks;
    expect(changed?.review).toBe("changed");
    expect(changed?.key).toBe(scanHook.key);
    // A trust for the hash the user saw earlier never applies to the new definition.
    await expect(
      service.setHookTrust({
        name: "guard",
        key: scanHook.key,
        hash: scanHook.hash,
        state: "trusted",
      })
    ).rejects.toThrow("changed since you reviewed it");
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("changed");

    await service.setHookTrust({
      name: "guard",
      key: changed.key,
      hash: changed.hash,
      state: "disabled",
    });
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("disabled");
    await service.setHookTrust({
      name: "guard",
      key: changed.key,
      hash: changed.hash,
      state: null,
    });
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("new");
  });

  test("the trust file lives outside PLUGIN_DATA and fails closed when tampered", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    await service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "trusted" });

    const instanceId = computePluginInstanceId(path.join(xumRoot, "plugins", "guard"));
    const trustFile = getPluginHookTrustPath(xumRoot, instanceId);
    expect(trustFile.startsWith(path.join(xumRoot, "plugin-hook-trust"))).toBe(true);
    // A file this build does not understand (another version) trusts nothing.
    await fsPromises.writeFile(
      trustFile,
      JSON.stringify({ version: 2, hooks: { [hook.key]: { hash: hook.hash, state: "trusted" } } })
    );
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("new");
    await fsPromises.writeFile(trustFile, "{ not json");
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("new");
  });

  test("an uninstall drops trust, so a reinstall starts untrusted", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    await service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "trusted" });

    await service.uninstall({ name: "guard", deletePluginData: false });
    await install();

    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("new");
  });

  const trustFile = () =>
    getPluginHookTrustPath(
      xumRoot,
      computePluginInstanceId(path.join(xumRoot, "plugins", "guard"))
    );

  test("trust stays with its install even when the trust file outlives an uninstall", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    await service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "trusted" });
    const saved = await fsPromises.readFile(trustFile(), "utf8");

    // An older build uninstalls and reinstalls without knowing about the trust file.
    await service.uninstall({ name: "guard", deletePluginData: false });
    await install();
    await fsPromises.writeFile(trustFile(), saved);

    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("new");
  });

  test("a trust decision waits for an overlapping uninstall instead of recreating trust", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    const uninstall = service.uninstall({ name: "guard", deletePluginData: false });
    const decision = service.setHookTrust({
      name: "guard",
      key: hook.key,
      hash: hook.hash,
      state: "trusted",
    });
    await uninstall;
    await expect(decision).rejects.toThrow("No managed plugin named 'guard'");
    expect(await fsPromises.stat(trustFile()).catch(() => null)).toBeNull();
  });

  test("a FIFO at the trust path trusts nothing instead of hanging", async () => {
    if (process.platform === "win32") return;
    await install();
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    using proc = execFileAsync("mkfifo", [trustFile()]);
    await proc.result;

    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("new");
  });

  test("a trust file from a newer Xum is kept, not rewritten", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    const newer = JSON.stringify({ version: 2, decisions: [{ key: hook.key, hash: hook.hash }] });
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    await fsPromises.writeFile(trustFile(), newer);

    await expect(
      service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "disabled" })
    ).rejects.toThrow("newer Xum version");
    expect(await fsPromises.readFile(trustFile(), "utf8")).toBe(newer);
  });

  /** The registry's installedAt for the installed plugin (the trust file's install binding). */
  const installedAt = async (): Promise<string> => {
    const registry = JSON.parse(
      await fsPromises.readFile(path.join(xumRoot, PLUGIN_REGISTRY_FILE_NAME), "utf8")
    ) as { plugins: Array<{ installedAt: string }> };
    return registry.plugins[0].installedAt;
  };

  test("a newer-format record for this install is kept, not rewritten", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    const newer = JSON.stringify({ version: 2, installedAt: await installedAt(), hooks: {} });
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    await fsPromises.writeFile(trustFile(), newer);

    await expect(
      service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "trusted" })
    ).rejects.toThrow("newer Xum version");
    expect(await fsPromises.readFile(trustFile(), "utf8")).toBe(newer);
  });

  test("one malformed trust entry drops only itself, also on the next rewrite", async () => {
    await install();
    const [hook, stopHook] = (await service.getHooks({ name: "guard" })).hooks;
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    await fsPromises.writeFile(
      trustFile(),
      JSON.stringify({
        version: 1,
        installedAt: await installedAt(),
        hooks: {
          [hook.key]: { hash: hook.hash, state: "trusted" },
          other: { hash: 1, state: "trusted" },
        },
      })
    );
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("trusted");

    // A decision for another hook rewrites the file: the valid decision survives it.
    await service.setHookTrust({
      name: "guard",
      key: stopHook.key,
      hash: stopHook.hash,
      state: "disabled",
    });
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("trusted");
  });

  test("a malformed trust entry (a directory) does not block a trust decision", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    await fsPromises.mkdir(trustFile(), { recursive: true });

    await service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "trusted" });

    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("trusted");
  });

  test("a trust decision replaces a symlinked trust file, never writes its target", async () => {
    await install();
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    const target = path.join(xumRoot, "victim.txt");
    await fsPromises.writeFile(target, "keep me");
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    await fsPromises.symlink(target, trustFile());

    await service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "trusted" });

    expect(await fsPromises.readFile(target, "utf8")).toBe("keep me");
    expect((await fsPromises.lstat(trustFile())).isFile()).toBe(true);
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("trusted");
  });

  const trustFirstHook = async () => {
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    await service.setHookTrust({ name: "guard", key: hook.key, hash: hook.hash, state: "trusted" });
    return (await service.getHooks({ name: "guard" })).hooks[0]?.review;
  };

  test("a non-finite trust version is malformed, not a newer format", async () => {
    await install();
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    // 1e400 parses to Infinity.
    await fsPromises.writeFile(trustFile(), '{ "version": 1e400, "hooks": {} }');

    expect(await trustFirstHook()).toBe("trusted");
  });

  test("a fractional trust version is malformed, not a newer format", async () => {
    await install();
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    await fsPromises.writeFile(
      trustFile(),
      JSON.stringify({ version: 1.5, installedAt: await installedAt(), hooks: {} })
    );

    expect(await trustFirstHook()).toBe("trusted");
  });

  test("a newer-format record from an earlier install does not block trust changes", async () => {
    await install();
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    // A newer build wrote this before a downgrade and a reinstall (a new installedAt).
    await fsPromises.writeFile(
      trustFile(),
      JSON.stringify({ version: 2, installedAt: "2000-01-01T00:00:00.000Z", hooks: {} })
    );

    expect(await trustFirstHook()).toBe("trusted");
  });

  test("a regular file at the trust-store root is replaced, not an ENOTDIR error", async () => {
    await install();
    const root = path.join(xumRoot, "plugin-hook-trust");
    await fsPromises.writeFile(root, "corrupted");

    expect(await trustFirstHook()).toBe("trusted");
    // Uninstall with a corrupted root succeeds and removes it.
    await fsPromises.rm(root, { recursive: true });
    await fsPromises.writeFile(root, "corrupted");
    await service.uninstall({ name: "guard", deletePluginData: false });
    expect(await fsPromises.stat(root).catch(() => null)).toBeNull();
  });

  test("a symlinked trust-store root is unlinked; its target is never written", async () => {
    if (process.platform === "win32") return;
    await install();
    const elsewhere = path.join(xumRoot, "elsewhere");
    await fsPromises.mkdir(elsewhere);
    const root = path.join(xumRoot, "plugin-hook-trust");
    await fsPromises.symlink(elsewhere, root);

    expect(await trustFirstHook()).toBe("trusted");
    expect((await fsPromises.lstat(root)).isDirectory()).toBe(true);
    expect(await fsPromises.readdir(elsewhere)).toEqual([]);
  });

  test("a trust file with mode 000 is repaired on the next decision", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    await install();
    await fsPromises.mkdir(path.dirname(trustFile()), { recursive: true });
    const [hook] = (await service.getHooks({ name: "guard" })).hooks;
    // A valid record that cannot be read: it trusts nothing until the repair.
    const record = {
      version: 1,
      installedAt: await installedAt(),
      hooks: { [hook.key]: { hash: hook.hash, state: "trusted" } },
    };
    await fsPromises.writeFile(trustFile(), JSON.stringify(record), { mode: 0o000 });
    expect((await service.getHooks({ name: "guard" })).hooks[0]?.review).toBe("new");

    expect(await trustFirstHook()).toBe("trusted");
    expect((await fsPromises.stat(trustFile())).mode & 0o777).toBe(0o600);
  });

  test("hook review reads its plugin's registry row even when another row is unparseable", async () => {
    await install();
    const registryFile = path.join(xumRoot, "plugins.json");
    const document = JSON.parse(await fsPromises.readFile(registryFile, "utf8")) as {
      plugins: unknown[];
    };
    // A row a newer Xum wrote (an unknown shape) for another plugin.
    document.plugins.push({ name: "other", source: { kind: "future" } });
    await fsPromises.writeFile(registryFile, JSON.stringify(document));

    expect(await trustFirstHook()).toBe("trusted");
  });

  test("hook review rejects a pending installer journal instead of showing stale trust", async () => {
    await install();
    const journal = path.join(xumRoot, "plugin-staging", "update-guard.json");
    await fsPromises.mkdir(path.dirname(journal), { recursive: true });
    await fsPromises.writeFile(journal, "{}");

    await expect(service.getHooks({ name: "guard" })).rejects.toThrow(/changed.*review/i);
  });

  test("a malformed trust entry (a directory) does not block uninstall", async () => {
    await install();
    await fsPromises.mkdir(trustFile(), { recursive: true });
    await service.uninstall({ name: "guard", deletePluginData: false });
    expect(await fsPromises.stat(trustFile()).catch(() => null)).toBeNull();
  });
});
