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

  test("a malformed trust entry (a directory) does not block uninstall", async () => {
    await install();
    await fsPromises.mkdir(trustFile(), { recursive: true });
    await service.uninstall({ name: "guard", deletePluginData: false });
    expect(await fsPromises.stat(trustFile()).catch(() => null)).toBeNull();
  });
});
