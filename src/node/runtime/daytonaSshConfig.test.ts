import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { XUM_DAYTONA_SSH_BLOCK_END, XUM_DAYTONA_SSH_BLOCK_START } from "@/common/constants/daytona";
import { DaytonaSshConfigWriter, renderDaytonaKnownHosts } from "./daytonaSshConfig";

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

    await writer.verifyResolvedUser("sb-1", "tokenA");

    // The included Host block must not leak to unrelated hosts.
    const other = spawnSync("ssh", ["-G", "-F", sshConfigPath, "unrelated.example.com"]);
    expect(other.stdout.toString()).not.toContain("user tokenA");
  });

  it.skipIf(!hasOpenSsh)("fails clearly when a user Host * User setting wins", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    await fs.writeFile(sshConfigPath, "Host *\n  User me\n", "utf8");
    await writer.writeSandbox({ sandboxId: "sb-1", token: "tokenA", gateway: GATEWAY });

    const error = await writer.verifyResolvedUser("sb-1", "tokenA").catch((e: unknown) => e);
    expect((error as Error).message).toContain('"Host *"');
    expect((error as Error).message).not.toContain("tokenA");
  });
});
