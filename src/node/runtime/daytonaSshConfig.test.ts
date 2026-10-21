import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  XUM_DAYTONA_SSH_BLOCK_END,
  XUM_DAYTONA_SSH_BLOCK_START,
  toXumDaytonaHost,
} from "@/common/constants/daytona";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import { DaytonaSshConfigWriter, renderDaytonaKnownHosts } from "./daytonaSshConfig";
import { appendOpenSSHHostKeyPolicyArgs } from "./sshConnectionPool";

const GATEWAY = {
  host: "ssh.daytona.test",
  port: 22,
  hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey gateway@daytona"],
};

const hasOpenSsh = spawnSync("ssh", ["-V"]).status === 0;

describe("DaytonaSshConfigWriter", () => {
  let tempDir: string;
  let xumHome: string;
  let sshConfigPath: string;
  let writer: DaytonaSshConfigWriter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-daytona-ssh-"));
    xumHome = path.join(tempDir, "xum");
    sshConfigPath = path.join(tempDir, ".ssh", "config");
    writer = new DaytonaSshConfigWriter({ xumHome, sshConfigPath });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("appends a Host-scoped Include block after the user's config and writes 0600 files", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    await fs.writeFile(sshConfigPath, "Host work\n  User me\n", "utf8");

    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });

    expect(await fs.readFile(sshConfigPath, "utf8")).toBe(
      [
        "Host work",
        "  User me",
        XUM_DAYTONA_SSH_BLOCK_START,
        "Host *.xum--daytona",
        `  Include ${writer.paths.includePath}`,
        XUM_DAYTONA_SSH_BLOCK_END,
        "",
      ].join("\n")
    );
    const include = await fs.readFile(writer.paths.includePath, "utf8");
    expect(include).toContain(
      [
        "Host sb-1.xum--daytona",
        "  HostName ssh.daytona.test",
        "  Port 22",
        "  User tokenA",
        "  HostKeyAlias ssh.daytona.test",
        `  UserKnownHostsFile ${writer.paths.knownHostsPath}`,
        "  StrictHostKeyChecking yes",
      ].join("\n")
    );
    expect(await fs.readFile(writer.paths.knownHostsPath, "utf8")).toBe(
      "ssh.daytona.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey\n"
    );
    for (const file of [writer.paths.includePath, writer.paths.knownHostsPath]) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("refreshes a token by rewriting only the include file, keeping other sandboxes", async () => {
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });
    await writer.writeSandbox({ sandboxId: "sb-2", token: "tokenB", gateway: GATEWAY });
    const sshConfigBefore = await fs.readFile(sshConfigPath, "utf8");
    await fs.rm(writer.paths.knownHostsPath);

    await writer.updateToken({ sandboxId: "sb-1", token: "tokenA2", gateway: GATEWAY });

    const include = await fs.readFile(writer.paths.includePath, "utf8");
    expect(include).toContain("User tokenA2");
    expect(include).not.toContain("User tokenA\n");
    expect(include).toContain("User tokenB");
    expect(await fs.readFile(sshConfigPath, "utf8")).toBe(sshConfigBefore);
    expect(await Bun.file(writer.paths.knownHostsPath).exists()).toBe(false);

    await writer.removeSandbox("sb-1");
    const afterRemove = await fs.readFile(writer.paths.includePath, "utf8");
    expect(afterRemove).not.toContain("sb-1.xum--daytona");
    expect(afterRemove).toContain("Host sb-2.xum--daytona");
  });

  it("repoints every sandbox at a new gateway in the write that replaces its host keys", async () => {
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });
    await writer.writeSandbox({ sandboxId: "sb-2", token: "tokenB", gateway: GATEWAY });
    const moved = {
      host: "ssh2.daytona.test",
      port: 2222,
      hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewGatewayKey"],
    };

    // sb-1 is refreshed first; sb-2 still has a turn on the shared known_hosts file.
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA2", gateway: moved });

    const include = await fs.readFile(writer.paths.includePath, "utf8");
    expect(include).not.toContain("ssh.daytona.test");
    expect(include).toContain(
      [
        "Host sb-2.xum--daytona",
        "  HostName ssh2.daytona.test",
        "  Port 2222",
        "  User tokenB",
        "  HostKeyAlias ssh2.daytona.test",
      ].join("\n")
    );
    expect(await writer.readTokens()).toEqual([
      { sandboxId: "sb-1", token: "tokenA2" },
      { sandboxId: "sb-2", token: "tokenB" },
    ]);

    // Moved back without a token refresh: every block follows, tokens kept.
    await writer.repointGateway(GATEWAY);
    expect(await fs.readFile(writer.paths.includePath, "utf8")).not.toContain("ssh2.daytona.test");
    expect(await writer.readTokens()).toHaveLength(2);
    expect(await fs.readFile(writer.paths.knownHostsPath, "utf8")).toContain("GatewayKey");
  });

  it("waits for another backend's include file update before reading the file", async () => {
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });
    const updates = [
      () => writer.writeSandbox({ sandboxId: "sb-2", token: "tokenB", gateway: GATEWAY }),
      () => writer.updateToken({ sandboxId: "sb-1", token: "tokenA2", gateway: GATEWAY }),
      () => writer.repointGateway(GATEWAY),
      () => writer.removeSandbox("sb-1"),
    ];
    for (const update of updates) {
      // Held by this process, the file lock looks to the writer like another backend mid-write.
      const release = await acquireCrossProcessLock({
        lockPath: `${writer.paths.includePath}.lock`,
        acquireTimeoutMs: 1_000,
        staleMs: 60_000,
        timeoutMessage: "test holder",
      });
      const before = await fs.readFile(writer.paths.includePath, "utf8");
      let settled = false;
      const running = update().finally(() => {
        settled = true;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        expect(await fs.readFile(writer.paths.includePath, "utf8")).toBe(before);
      } finally {
        await release();
      }
      await running;
    }
    expect(await writer.readTokens()).toEqual([{ sandboxId: "sb-2", token: "tokenB" }]);
  });

  it("reads back the tokens the include file holds, for a later Xum process", async () => {
    const later = new DaytonaSshConfigWriter({ xumHome, sshConfigPath });
    expect(await later.readTokens()).toEqual([]);

    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });
    await writer.writeSandbox({ sandboxId: "sb-2", token: "tokenB", gateway: GATEWAY });
    await writer.updateToken({ sandboxId: "sb-1", token: "tokenA2", gateway: GATEWAY });

    expect(await later.readTokens()).toEqual([
      { sandboxId: "sb-1", token: "tokenA2" },
      { sandboxId: "sb-2", token: "tokenB" },
    ]);
  });

  it("refuses control-plane values that would inject ssh directives", async () => {
    for (const input of [
      { sandboxId: "sb-1", token: "tok\n  ProxyCommand touch /tmp/pwned" },
      { sandboxId: "sb-1\nHost *", token: "tok" },
    ]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(writer.writeSandbox({ ...input, gateway: GATEWAY })).rejects.toThrow(
        /Refusing to write an invalid Daytona/
      );
    }
    expect(await Bun.file(sshConfigPath).exists()).toBe(false);
  });

  it.each([
    "xum%d",
    "xum*",
    "xum?",
    "xum[abc]",
    "xum's",
    'xum"q',
    "xum$HOME",
    "xum#1",
    // A path separator on Windows.
    ...(process.platform === "win32" ? [] : ["xum\\b"]),
  ])("refuses a Xum root that ssh would not read literally (%s), writing nothing", async (root) => {
    const tokenWriter = new DaytonaSshConfigWriter({
      xumHome: path.join(tempDir, root),
      sshConfigPath,
    });
    const input = { sandboxId: "sb-1", token: "tok", gateway: GATEWAY };
    for (const update of [
      () => tokenWriter.writeSandbox(input),
      () => tokenWriter.updateToken(input),
      () => tokenWriter.repointGateway(GATEWAY),
    ]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(update()).rejects.toThrow(
        `Daytona ssh setup cannot use ${tokenWriter.paths.dir}`
      );
    }
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it("accepts a Xum root with a space and non-ASCII letters", async () => {
    const spacedWriter = new DaytonaSshConfigWriter({
      xumHome: path.join(tempDir, "José Smith", ".xum"),
      sshConfigPath,
    });
    await spacedWriter.writeSandbox({ sandboxId: "sb-1", token: "tok", gateway: GATEWAY });
    expect(await spacedWriter.readTokens()).toEqual([{ sandboxId: "sb-1", token: "tok" }]);
  });

  it("writes a self-hosted IPv6 gateway as OpenSSH resolves it, refusing zone ids", async () => {
    const gateway = { ...GATEWAY, host: "2001:db8::10", port: 2222 };
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway });

    expect(await fs.readFile(writer.paths.knownHostsPath, "utf8")).toBe(
      [
        "2001:db8::10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey",
        "[2001:db8::10]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey",
        "",
      ].join("\n")
    );
    if (hasOpenSsh) {
      const resolved = spawnSync("ssh", ["-G", "-F", sshConfigPath, "sb-1.xum--daytona"], {
        encoding: "utf8",
      }).stdout;
      for (const line of ["hostname 2001:db8::10", "port 2222", "hostkeyalias 2001:db8::10"]) {
        expect(resolved.split("\n")).toContain(line);
      }
    }

    // A zone id carries `%`, which ssh config expands as a token.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(
      writer.writeSandbox({
        sandboxId: "sb-2",
        token: "t",
        gateway: { ...gateway, host: "fe80::1%eth0" },
      })
    ).rejects.toThrow(/Refusing to write an invalid Daytona gateway host/);
  });

  it("port-qualifies known_hosts entries for a gateway off port 22", () => {
    expect(renderDaytonaKnownHosts({ ...GATEWAY, port: 2222 })).toBe(
      [
        "ssh.daytona.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey",
        "[ssh.daytona.test]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey",
        "",
      ].join("\n")
    );
  });

  it.skipIf(!hasOpenSsh)("resolves the token as the ssh user through OpenSSH", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    await fs.writeFile(sshConfigPath, "Host other\n  User someone\n", "utf8");
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });

    await writer.verifyResolvedConfig("sb-1", "tokenA");

    // The included Host block must not leak to unrelated hosts.
    const other = spawnSync("ssh", ["-G", "-F", sshConfigPath, "unrelated.example.com"]);
    expect(other.stdout.toString()).not.toContain("user tokenA");
  });

  it.skipIf(!hasOpenSsh)("fails clearly when a user Host * User setting wins", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    await fs.writeFile(sshConfigPath, "Host *\n  User me\n", "utf8");
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });

    const error = await writer.verifyResolvedConfig("sb-1", "tokenA").catch((e: unknown) => e);
    expect((error as Error).message).toContain('"Host *"');
    expect((error as Error).message).not.toContain("tokenA");
  });

  it.skipIf(!hasOpenSsh)("fails clearly when a user Host * routing setting wins", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    for (const [setting, line] of [
      ["Port", "Port 2222"],
      ["HostName", "HostName elsewhere.example.com"],
      ["HostKeyAlias", "HostKeyAlias elsewhere.example.com"],
    ]) {
      await fs.writeFile(sshConfigPath, `Host *\n  ${line}\n`, "utf8");
      await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });

      const error = await writer.verifyResolvedConfig("sb-1", "tokenA").catch((e: unknown) => e);
      expect(String(error)).toContain(`sets ${setting} for`);
    }
    // The block's own values (a mixed-case gateway host included) pass as ssh -G prints them.
    await fs.writeFile(sshConfigPath, "Host other\n  Port 2222\n", "utf8");
    await writer.writeSandbox({
      sandboxId: "sb-1",
      token: "tokenA",
      gateway: { ...GATEWAY, host: "SSH.Daytona.test", port: 2200 },
    });
    await writer.verifyResolvedConfig("sb-1", "tokenA");
  });

  describe("a user Host * entry that weakens host key checking", () => {
    const WEAKENING_CONFIG = "Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n";

    it.skipIf(!hasOpenSsh)("cannot turn off strict checking for Xum's ssh calls", async () => {
      await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
      await fs.writeFile(sshConfigPath, WEAKENING_CONFIG, "utf8");
      await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });

      const args = ["-G", "-F", sshConfigPath];
      appendOpenSSHHostKeyPolicyArgs(args, toXumDaytonaHost("sb-1"));
      const resolved = spawnSync("ssh", [...args, toXumDaytonaHost("sb-1")]).stdout.toString();

      expect(resolved).toContain("\nstricthostkeychecking true\n");
    });

    it.skipIf(!hasOpenSsh)("fails the ssh config check, naming the setting", async () => {
      await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
      await fs.writeFile(sshConfigPath, WEAKENING_CONFIG, "utf8");
      await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });

      const error = await writer.verifyResolvedConfig("sb-1", "tokenA").catch((e: unknown) => e);
      expect((error as Error).message).toContain("sets UserKnownHostsFile");
    });
  });
});
