import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { XUM_DAYTONA_SSH_BLOCK_START } from "@/common/constants/daytona";
import { DaytonaSshConfigWriter } from "./daytonaSshConfig";
import { resolveSSHConfig } from "./sshConfigParser";

describe("resolveSSHConfig", () => {
  test("applies Host + Match host proxy rules", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-config-"));
    const previousUserProfile = process.env.USERPROFILE;

    process.env.USERPROFILE = tempDir;

    try {
      await fs.mkdir(path.join(tempDir, ".ssh"), { recursive: true });

      const config = [
        "Host *.mux--coder",
        "  User coder-user",
        "  UserKnownHostsFile /dev/null",
        "",
        'Match host *.mux--coder !exec "exit 1"',
        "  ProxyCommand /usr/local/bin/coder --stdio %h",
        "",
      ].join("\n");

      await fs.writeFile(path.join(tempDir, ".ssh", "config"), config, "utf8");

      const resolved = await resolveSSHConfig("pog2.mux--coder");

      expect(resolved.user).toBe("coder-user");
      expect(resolved.hostName).toBe("pog2.mux--coder");
      expect(resolved.proxyCommand).toBe("/usr/local/bin/coder --stdio %h");
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }

      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("defaults %r to local username when no User is specified", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-config-"));
    const previousUserProfile = process.env.USERPROFILE;

    process.env.USERPROFILE = tempDir;

    try {
      await fs.mkdir(path.join(tempDir, ".ssh"), { recursive: true });

      // Config with no User directive - %r should default to local username
      // The !exec command checks if %r is non-empty; if it were empty, exit 0
      // would cause the Match to NOT apply (since !exec means "apply if command fails")
      const config = [
        "Host test-host",
        "  HostName 10.0.0.1",
        "",
        // !exec "test -n %r" fails when %r is non-empty (test -n returns 0 for non-empty)
        // So we use "test -z %r" which returns 0 when %r IS empty, 1 when non-empty
        // With %r defaulting to local username, test -z will fail, Match applies
        'Match host 10.0.0.1 !exec "test -z %r"',
        "  ProxyCommand /usr/bin/proxy --user %r",
        "",
      ].join("\n");

      await fs.writeFile(path.join(tempDir, ".ssh", "config"), config, "utf8");

      const resolved = await resolveSSHConfig("test-host");

      // Should apply ProxyCommand because %r is non-empty (local username)
      expect(resolved.proxyCommand).toBe("/usr/bin/proxy --user %r");
      // user should be undefined since no User directive
      expect(resolved.user).toBeUndefined();
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }

      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function withTempHome(fn: (homeDir: string) => Promise<void>): Promise<void> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-config-"));
    const previousUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = tempDir;
    try {
      await fs.mkdir(path.join(tempDir, ".ssh"), { recursive: true });
      await fn(tempDir);
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  // The Daytona block goes first in the file; the user's global options and Host entries after
  // it must resolve as they did before for every other host.
  test("resolves other hosts the same after Xum puts its Daytona block on top", async () => {
    await withTempHome(async (homeDir) => {
      const configPath = path.join(homeDir, ".ssh", "config");
      await fs.writeFile(
        configPath,
        [
          "User globaluser",
          "ServerAliveInterval 30",
          "Host box",
          "  HostName 10.0.0.1",
          "  ProxyCommand nc %h %p",
          "Host *",
          "  Port 2222",
          "  ForwardAgent yes",
          "",
        ].join("\n"),
        "utf8"
      );
      const hosts = ["box", "plain.example.com"];
      const snapshot = () => Promise.all(hosts.map((host) => resolveSSHConfig(host)));
      const before = await snapshot();

      const writer = new DaytonaSshConfigWriter({
        xumHome: path.join(homeDir, ".xum"),
        sshConfigPath: configPath,
      });
      await writer.writeSandbox({
        sandboxId: "sb-1",
        token: "tokenA",
        gateway: { host: "ssh.daytona.test", port: 2222, hostKeys: ["ssh-ed25519 AAAA"] },
      });

      expect((await fs.readFile(configPath, "utf8")).startsWith(XUM_DAYTONA_SSH_BLOCK_START)).toBe(
        true
      );
      expect(await snapshot()).toEqual(before);
      expect(before[0].user).toBe("globaluser");
      expect(before[1].port).toBe(2222);
      const daytona = await resolveSSHConfig("sb-1.xum--daytona", writer.paths.includePath);
      expect(daytona.user).toBe("tokenA");
      expect(daytona.hostName).toBe("ssh.daytona.test");
      expect(daytona.port).toBe(2222);
    });
  });

  test("keeps a space in a quoted UserKnownHostsFile and splits unquoted files", async () => {
    await withTempHome(async (homeDir) => {
      const configPath = path.join(homeDir, ".ssh", "config");
      await fs.writeFile(
        configPath,
        "Host plain\n  UserKnownHostsFile ~/kh1 ~/kh2\n" +
          'Host quoted-first\n  UserKnownHostsFile "~/J S/kh" ~/kh2\n',
        "utf8"
      );
      // Rendered as daytonaSshConfig does for a home dir like "/Users/John Smith".
      const writer = new DaytonaSshConfigWriter({
        xumHome: path.join(homeDir, "John Smith", ".xum"),
        sshConfigPath: configPath,
      });
      await writer.writeSandbox({
        sandboxId: "sb-1",
        token: "tokenA",
        gateway: { host: "ssh.daytona.test", port: 22, hostKeys: ["ssh-ed25519 AAAA"] },
      });

      const daytona = await resolveSSHConfig("sb-1.xum--daytona", writer.paths.includePath);
      expect(daytona.userKnownHostsFile).toBe(writer.paths.knownHostsPath);
      expect(daytona.hostKeyAlias).toBe("ssh.daytona.test");
      expect((await resolveSSHConfig("plain")).userKnownHostsFile).toBe(path.join(homeDir, "kh1"));
      expect((await resolveSSHConfig("quoted-first")).userKnownHostsFile).toBe(
        path.join(homeDir, "J S", "kh")
      );
    });
  });
});
