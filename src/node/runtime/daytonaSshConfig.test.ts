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
import { DaytonaSshConfigWriter, renderDaytonaKnownHosts } from "./daytonaSshConfig";
import { resolveSSHConfig } from "./sshConfigParser";
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

  it("puts a Host-scoped Include block before the user's config and writes 0600 files", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    await fs.writeFile(sshConfigPath, "Host work\n  User me\n", "utf8");

    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

    expect(await fs.readFile(sshConfigPath, "utf8")).toBe(
      [
        XUM_DAYTONA_SSH_BLOCK_START,
        "Host *.xum--daytona",
        "  LogLevel QUIET",
        `  Include ${writer.paths.includePath}`,
        "Host *",
        XUM_DAYTONA_SSH_BLOCK_END,
        "Host work",
        "  User me",
        "",
      ].join("\n")
    );
    const include = await fs.readFile(writer.paths.includePath, "utf8");
    expect(include).toContain(
      [
        "Host sb-1.xum--daytona",
        "  ProxyCommand none",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  PermitLocalCommand no",
        "  Tunnel no",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
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
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });
    await writer.writeSandbox({ sandboxName: "sb-2", token: "tokenB", gateway: GATEWAY });
    const sshConfigBefore = await fs.readFile(sshConfigPath, "utf8");
    await fs.rm(writer.paths.knownHostsPath);

    await writer.updateToken({ sandboxName: "sb-1", token: "tokenA2", gateway: GATEWAY });

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

  it("puts back a removed managed block, and leaves an unchanged config untouched", async () => {
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });
    const written = await fs.readFile(sshConfigPath, "utf8");
    const { ino } = await fs.stat(sshConfigPath);

    await writer.ensureManagedBlock();
    // The atomic write renames a new file into place, so an unchanged inode means no write.
    expect((await fs.stat(sshConfigPath)).ino).toBe(ino);

    await fs.writeFile(sshConfigPath, "Host work\n  User me\n", "utf8");
    await writer.ensureManagedBlock();
    expect(await fs.readFile(sshConfigPath, "utf8")).toBe(`${written}Host work\n  User me\n`);
  });

  it("repoints every sandbox at a new gateway in the write that replaces its host keys", async () => {
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });
    await writer.writeSandbox({ sandboxName: "sb-2", token: "tokenB", gateway: GATEWAY });
    const moved = {
      host: "ssh2.daytona.test",
      port: 2222,
      hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewGatewayKey"],
    };

    // sb-1 is refreshed first; sb-2 still has a turn on the shared known_hosts file.
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA2", gateway: moved });

    const include = await fs.readFile(writer.paths.includePath, "utf8");
    expect(include).not.toContain("ssh.daytona.test");
    expect(include).toContain(
      [
        "  HostName ssh2.daytona.test",
        "  Port 2222",
        "  User tokenB",
        "  HostKeyAlias ssh2.daytona.test",
      ].join("\n")
    );
    expect(await writer.readTokens()).toEqual([
      { sandboxName: "sb-1", token: "tokenA2" },
      { sandboxName: "sb-2", token: "tokenB" },
    ]);

    // Moved back without a token refresh: every block follows, tokens kept.
    await writer.repointGateway(GATEWAY);
    expect(await fs.readFile(writer.paths.includePath, "utf8")).not.toContain("ssh2.daytona.test");
    expect(await writer.readTokens()).toHaveLength(2);
    expect(await fs.readFile(writer.paths.knownHostsPath, "utf8")).toContain("GatewayKey");
  });

  it("reads back the tokens the include file holds, for a later Xum process", async () => {
    const later = new DaytonaSshConfigWriter({ xumHome, sshConfigPath });
    expect(await later.readTokens()).toEqual([]);

    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });
    await writer.writeSandbox({ sandboxName: "sb-2", token: "tokenB", gateway: GATEWAY });
    await writer.updateToken({ sandboxName: "sb-1", token: "tokenA2", gateway: GATEWAY });

    expect(await later.readTokens()).toEqual([
      { sandboxName: "sb-1", token: "tokenA2" },
      { sandboxName: "sb-2", token: "tokenB" },
    ]);
  });

  it("refuses control-plane values that would inject ssh directives", async () => {
    for (const input of [
      { sandboxName: "sb-1", token: "tok\n  ProxyCommand touch /tmp/pwned" },
      { sandboxName: "sb-1\nHost *", token: "tok" },
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
    const input = { sandboxName: "sb-1", token: "tok", gateway: GATEWAY };
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
    await spacedWriter.writeSandbox({ sandboxName: "sb-1", token: "tok", gateway: GATEWAY });
    expect(await spacedWriter.readTokens()).toEqual([{ sandboxName: "sb-1", token: "tok" }]);
  });

  it("writes a self-hosted IPv6 gateway as OpenSSH resolves it, refusing zone ids", async () => {
    const gateway = { ...GATEWAY, host: "2001:db8::10", port: 2222 };
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway });

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
        sandboxName: "sb-2",
        token: "t",
        gateway: { ...gateway, host: "fe80::1%eth0" },
      })
    ).rejects.toThrow(/Refusing to write an invalid Daytona gateway host/);
  });

  // Self-hosted deployments may name the gateway absolutely. Kept as written: ssh uses the
  // HostKeyAlias as is, both to look up the pinned key and (ssh2) to match known_hosts lines.
  it("writes an absolute gateway name with its trailing dot, pinned under that name", async () => {
    const gateway = { ...GATEWAY, host: "gateway.example.com.", port: 2222 };
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway });

    const knownHosts = await fs.readFile(writer.paths.knownHostsPath, "utf8");
    expect(knownHosts).toBe(
      [
        "gateway.example.com. ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey",
        "[gateway.example.com.]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey",
        "",
      ].join("\n")
    );
    const parsed = await resolveSSHConfig(toXumDaytonaHost("sb-1"), writer.paths.includePath);
    expect(parsed.hostName).toBe("gateway.example.com.");
    expect(parsed.hostKeyAlias).toBe("gateway.example.com.");
    if (hasOpenSsh) {
      const resolved = spawnSync("ssh", ["-G", "-F", sshConfigPath, "sb-1.xum--daytona"], {
        encoding: "utf8",
      }).stdout.split("\n");
      expect(resolved).toContain("hostname gateway.example.com.");
      expect(resolved).toContain("hostkeyalias gateway.example.com.");
      // What ssh does with that alias: find the pinned key in Xum's known_hosts.
      const lookup = spawnSync("ssh-keygen", [
        "-F",
        "gateway.example.com.",
        "-f",
        writer.paths.knownHostsPath,
      ]);
      expect(lookup.status).toBe(0);
    }

    for (const host of ["gateway.example.com..", "gateway..example.com", ".example.com", "."]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(
        writer.writeSandbox({ sandboxName: "sb-2", token: "t", gateway: { ...gateway, host } })
      ).rejects.toThrow(/Refusing to write an invalid Daytona gateway host/);
    }
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

  // What an editor's Remote-SSH resolves for the workspace's host, through ~/.ssh/config.
  it.skipIf(!hasOpenSsh)("resolves the alias through the managed ssh config block", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    await fs.writeFile(sshConfigPath, "Host other\n  User someone\n", "utf8");
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

    const alias = spawnSync("ssh", ["-G", "-F", sshConfigPath, toXumDaytonaHost("sb-1")]);
    expect(alias.stdout.toString()).toMatch(/^user tokenA$/m);
    // The included Host block must not leak to unrelated hosts.
    const other = spawnSync("ssh", ["-G", "-F", sshConfigPath, "unrelated.example.com"]);
    expect(other.stdout.toString()).not.toContain("user tokenA");
  });

  // OpenSSH names the user (the token) in its fatal `user@host: Permission denied` line, and
  // an editor's or a native terminal's ssh output reaches no Xum redactor.
  it.skipIf(!hasOpenSsh)("keeps your own ssh clients quiet for a Daytona alias", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    await fs.writeFile(sshConfigPath, "Host *\n  LogLevel VERBOSE\n", "utf8");
    await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

    const resolve = (host: string) =>
      spawnSync("ssh", ["-G", "-F", sshConfigPath, host]).stdout.toString();
    // `ssh -G` prints QUIET as SILENT.
    expect(resolve(toXumDaytonaHost("sb-1"))).toMatch(/^loglevel (QUIET|SILENT)$/m);
    expect(resolve("unrelated.example.com")).toMatch(/^loglevel VERBOSE$/m);
  });

  // Any user directive with %r would get the token (the ssh user name), and `-o` cannot
  // override a Match exec, so ssh reads only Xum's include file for a Daytona alias.
  it.skipIf(!hasOpenSsh)("runs no user ssh config directive for a Daytona alias", async () => {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
    const markers = path.join(tempDir, "markers");
    await fs.mkdir(markers);
    const resolve = (host: string) => {
      const args = ["-G", "-F", sshConfigPath];
      appendOpenSSHHostKeyPolicyArgs(args, host);
      return spawnSync("ssh", [...args, host]).stdout.toString();
    };
    for (const [routing, resolvedLine] of [
      ["ProxyCommand nc %r %h %p", "\nproxycommand nc %r %h %p\n"],
      ["ProxyJump jump.example.com", "\nproxyjump jump.example.com\n"],
    ]) {
      await fs.writeFile(
        sshConfigPath,
        [
          `Match exec "touch ${markers}/%r"`,
          "Host *",
          "  KnownHostsCommand /bin/echo %r",
          `  ${routing}`,
          "  PermitLocalCommand yes",
          "  LocalCommand echo %r",
          // Forwards would hand the untrusted sandbox the local agent, display or ports.
          "  ForwardAgent yes",
          "  ForwardX11 yes",
          "  RemoteForward 6000 localhost:6000",
          "",
        ].join("\n"),
        "utf8"
      );
      await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

      const daytona = resolve(toXumDaytonaHost("sb-1"));
      expect(daytona).toMatch(/^user tokenA$/m);
      expect(daytona).not.toContain("knownhostscommand");
      expect(daytona).not.toMatch(/\nproxy(command|jump) /);
      expect(daytona).toContain("\npermitlocalcommand no\n");
      expect(daytona).toContain("\nforwardagent no\n");
      expect(daytona).toContain("\nforwardx11 no\n");
      expect(daytona).not.toContain("remoteforward");
      expect(await fs.readdir(markers)).toEqual([]);
      // Other hosts keep the user's settings.
      const other = resolve("other.example.com");
      expect(other).toContain(resolvedLine);
      expect(other).toContain("\nknownhostscommand /bin/echo %r\n");
      expect((await fs.readdir(markers)).length).toBe(1);
      await fs.rm(markers, { recursive: true });
      await fs.mkdir(markers);
    }
  });

  // Editors (VS Code Remote-SSH, Zed) run the user's own ssh against ~/.ssh/config, without the
  // `-F` Xum passes, and OpenSSH keeps the first value it reads for each option.
  describe("an editor's ssh client reading the user's ssh config", () => {
    const resolveFromUserConfig = (host: string) =>
      spawnSync("ssh", ["-G", "-F", sshConfigPath, host]).stdout.toString();

    it.skipIf(!hasOpenSsh)(
      "applies Xum's hardening to the alias over an earlier user Host * entry",
      async () => {
        await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
        await fs.writeFile(
          sshConfigPath,
          [
            "Host *",
            "  StrictHostKeyChecking no",
            "  UserKnownHostsFile /dev/null",
            "  ForwardAgent yes",
            "  ForwardX11 yes",
            "  PermitLocalCommand yes",
            "  PasswordAuthentication yes",
            "  ProxyCommand nc -X connect -x gateway.example.com:3128 %h %p",
            "  User me",
            "",
          ].join("\n"),
          "utf8"
        );
        await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

        const daytona = resolveFromUserConfig(toXumDaytonaHost("sb-1"));
        expect(daytona).toMatch(/^user tokenA$/m);
        expect(daytona).toContain("\nstricthostkeychecking true\n");
        expect(daytona).toContain(`\nuserknownhostsfile ${writer.paths.knownHostsPath}\n`);
        expect(daytona).toContain("\nforwardagent no\n");
        expect(daytona).toContain("\nforwardx11 no\n");
        expect(daytona).toContain("\npermitlocalcommand no\n");
        expect(daytona).toContain("\npasswordauthentication no\n");
        expect(daytona).not.toMatch(/\nproxy(command|jump) /);

        const other = resolveFromUserConfig("other.example.com");
        expect(other).toMatch(/^user me$/m);
        expect(other).toContain("\nstricthostkeychecking false\n");
        expect(other).toContain("\nuserknownhostsfile /dev/null\n");
        expect(other).toContain("\nforwardagent yes\n");
        expect(other).toContain("\nforwardx11 yes\n");
        expect(other).toContain("\npasswordauthentication yes\n");
        expect(other).toContain("\nproxycommand nc -X connect -x gateway.example.com:3128 %h %p\n");
      }
    );

    it.skipIf(!hasOpenSsh)("ignores a ProxyJump the user sets for every host", async () => {
      await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
      await fs.writeFile(sshConfigPath, "Host *\n  ProxyJump jump.example.com\n", "utf8");
      await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

      expect(resolveFromUserConfig(toXumDaytonaHost("sb-1"))).not.toMatch(/\nproxy(command|jump) /);
      expect(resolveFromUserConfig("other.example.com")).toContain(
        "\nproxyjump jump.example.com\n"
      );
    });

    it.skipIf(!hasOpenSsh)("gives the sandbox no tun device a user Tunnel asks for", async () => {
      await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
      await fs.writeFile(sshConfigPath, "Host *\n  Tunnel yes\n", "utf8");
      await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

      expect(resolveFromUserConfig(toXumDaytonaHost("sb-1"))).toContain("\ntunnel false\n");
      expect(resolveFromUserConfig("other.example.com")).toContain("\ntunnel point-to-point\n");
    });

    it("moves a block an earlier Xum appended to the top of the file", async () => {
      await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
      const userConfig = "Host *\n  ForwardAgent yes\n";
      await fs.writeFile(
        sshConfigPath,
        [
          userConfig.trimEnd(),
          XUM_DAYTONA_SSH_BLOCK_START,
          "Host *.xum--daytona",
          `  Include ${writer.paths.includePath}`,
          XUM_DAYTONA_SSH_BLOCK_END,
          "",
        ].join("\n"),
        "utf8"
      );

      await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });
      const content = await fs.readFile(sshConfigPath, "utf8");
      expect(content.startsWith(`${XUM_DAYTONA_SSH_BLOCK_START}\n`)).toBe(true);
      expect(content.endsWith(`${XUM_DAYTONA_SSH_BLOCK_END}\n${userConfig}`)).toBe(true);
      expect(content.split(XUM_DAYTONA_SSH_BLOCK_START)).toHaveLength(2);

      // Already on top: rewriting it changes nothing.
      await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });
      expect(await fs.readFile(sshConfigPath, "utf8")).toBe(content);
    });
  });

  describe("a user Host * entry that weakens host key checking", () => {
    const WEAKENING_CONFIG = "Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n";

    it.skipIf(!hasOpenSsh)("cannot turn off strict checking for Xum's ssh calls", async () => {
      await fs.mkdir(path.dirname(sshConfigPath), { recursive: true });
      await fs.writeFile(sshConfigPath, WEAKENING_CONFIG, "utf8");
      await writer.writeSandbox({ sandboxName: "sb-1", token: "tokenA", gateway: GATEWAY });

      const args = ["-G", "-F", sshConfigPath];
      appendOpenSSHHostKeyPolicyArgs(args, toXumDaytonaHost("sb-1"));
      const resolved = spawnSync("ssh", [...args, toXumDaytonaHost("sb-1")]).stdout.toString();

      expect(resolved).toContain("\nstricthostkeychecking true\n");
    });
  });
});
