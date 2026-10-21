import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DaytonaSshConfigWriter } from "./daytonaSshConfig";
import { resolveSSHConfig } from "./sshConfigParser";

const hasOpenSsh = spawnSync("ssh", ["-V"]).status === 0;

/** What OpenSSH resolves for `host` from `configPath` alone: the parity reference. */
function opensshUserAndProxy(configPath: string, host: string) {
  const output = spawnSync("ssh", ["-G", "-F", configPath, host], { encoding: "utf8" }).stdout;
  const value = (key: string) =>
    output
      .split("\n")
      .find((line) => line.startsWith(`${key} `))
      ?.slice(key.length + 1);
  return { user: value("user"), proxyCommand: value("proxycommand") };
}

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

  test("resolves a Daytona sandbox through the managed Host-scoped Include", async () => {
    await withTempHome(async (homeDir) => {
      await fs.writeFile(path.join(homeDir, ".ssh", "config"), "Host work\n  User me\n", "utf8");
      const writer = new DaytonaSshConfigWriter({
        xumHome: path.join(homeDir, ".xum"),
        sshConfigPath: path.join(homeDir, ".ssh", "config"),
      });
      await writer.writeSandbox({
        sandboxId: "sb-1",
        token: "tokenA",
        gateway: { host: "ssh.daytona.test", port: 2222, hostKeys: ["ssh-ed25519 AAAA"] },
      });

      const resolved = await resolveSSHConfig("sb-1.xum--daytona");

      expect(resolved.user).toBe("tokenA");
      expect(resolved.hostName).toBe("ssh.daytona.test");
      expect(resolved.port).toBe(2222);
      expect((await resolveSSHConfig("work")).user).toBe("me");
    });
  });

  test("resolves relative and wildcard Includes and keeps later lines in the enclosing block", async () => {
    await withTempHome(async (homeDir) => {
      await fs.mkdir(path.join(homeDir, ".ssh", "conf.d"));
      await fs.writeFile(
        path.join(homeDir, ".ssh", "conf.d", "10-box.conf"),
        // Lines before the first Host apply to the enclosing block, as in OpenSSH.
        "HostName 10.0.0.5\nHost other\n  User otheruser\n",
        "utf8"
      );
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        ["Host box", "  Include conf.d/*.conf", "  User boxuser", ""].join("\n"),
        "utf8"
      );

      const resolved = await resolveSSHConfig("box");

      expect(resolved.hostName).toBe("10.0.0.5");
      expect(resolved.user).toBe("boxuser");
    });
  });

  // OpenSSH globs an Include's whole pathname (glob(3), sorted), not only its file name.
  test("reads every file an Include's directory wildcard matches, in sorted order", async () => {
    await withTempHome(async (homeDir) => {
      // Written out of order: the sorted first match sets HostName (the first value wins).
      for (const [dir, hostName] of [
        ["b", "10.0.0.2"],
        ["a", "10.0.0.1"],
      ]) {
        await fs.mkdir(path.join(homeDir, ".ssh", "conf.d", dir), { recursive: true });
        await fs.writeFile(
          path.join(homeDir, ".ssh", "conf.d", dir, "hosts.conf"),
          `Host box\n  HostName ${hostName}\nHost only-${dir}\n  User user-${dir}\n`,
          "utf8"
        );
      }
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        "Include conf.d/*/hosts.conf\n",
        "utf8"
      );

      expect((await resolveSSHConfig("box")).hostName).toBe("10.0.0.1");
      expect((await resolveSSHConfig("only-a")).user).toBe("user-a");
      expect((await resolveSSHConfig("only-b")).user).toBe("user-b");
    });
  });

  test("expands wildcards in several segments of an absolute Include path", async () => {
    await withTempHome(async (homeDir) => {
      const dir = path.join(homeDir, "teams", "team-1", "nested");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "box.conf"), "Host box\n  User teamuser\n", "utf8");
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        `Include ${path.join(homeDir, "te?ms", "team-*", "nested", "*.conf")}\n`,
        "utf8"
      );

      expect((await resolveSSHConfig("box")).user).toBe("teamuser");
    });
  });

  test("includes nothing for an Include pattern no path matches", async () => {
    await withTempHome(async (homeDir) => {
      await fs.mkdir(path.join(homeDir, ".ssh", "conf.d", "a"), { recursive: true });
      await fs.writeFile(
        path.join(homeDir, ".ssh", "conf.d", "a", "hosts.conf"),
        "Host box\n  User wrong\n",
        "utf8"
      );
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        ["Include conf.d/*/other.conf missing/*/hosts.conf", "Host box", "  User right", ""].join(
          "\n"
        ),
        "utf8"
      );

      expect((await resolveSSHConfig("box")).user).toBe("right");
    });
  });

  test("expands glob(3) bracket expressions in an Include path", async () => {
    await withTempHome(async (homeDir) => {
      const confDir = path.join(homeDir, ".ssh", "conf.d");
      await fs.mkdir(confDir);
      // Each file sets User for its own host; the pattern decides which ones are read.
      for (const name of ["a", "b", "c", "m", "x", "[odd"]) {
        await fs.writeFile(
          path.join(confDir, `${name}.conf`),
          `Host host-${name}\n  User user-${name}\n`,
          "utf8"
        );
      }
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        [
          "Include conf.d/[ab].conf conf.d/[k-n].conf conf.d/[!a-m].conf conf.d/[odd.conf",
          "Host *",
          "  User none",
          "",
        ].join("\n"),
        "utf8"
      );

      const user = async (name: string) => (await resolveSSHConfig(`host-${name}`)).user;
      expect(await user("a")).toBe("user-a");
      expect(await user("b")).toBe("user-b");
      expect(await user("m")).toBe("user-m");
      expect(await user("x")).toBe("user-x");
      // An unclosed "[" is a literal character.
      expect(await user("[odd")).toBe("user-[odd");
      expect(await user("c")).toBe("none");
    });
  });

  test("matches an Include wildcard as glob(3) does: ? is one character, * skips dot files", async () => {
    await withTempHome(async (homeDir) => {
      const confDir = path.join(homeDir, ".ssh", "conf.d");
      await fs.mkdir(confDir);
      for (const [name, host] of [
        ["1.conf", "one"],
        ["12.conf", "two"],
        [".hidden.conf", "hidden"],
      ]) {
        await fs.writeFile(path.join(confDir, name), `Host ${host}\n  User user-${host}\n`, "utf8");
      }
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        ["Include conf.d/1?.conf conf.d/*hidden.conf", "Host *", "  User none", ""].join("\n"),
        "utf8"
      );

      expect((await resolveSSHConfig("one")).user).toBe("none");
      expect((await resolveSSHConfig("two")).user).toBe("user-two");
      expect((await resolveSSHConfig("hidden")).user).toBe("none");
    });
  });

  test("matches glob(3) named classes in an Include path; an unknown class matches nothing", async () => {
    await withTempHome(async (homeDir) => {
      const confDir = path.join(homeDir, ".ssh", "conf.d");
      await fs.mkdir(confDir);
      for (const [name, host] of [
        ["1", "one"],
        ["a", "letter"],
      ]) {
        await fs.writeFile(
          path.join(confDir, `${name}.conf`),
          `Host ${host}\n  User user-${host}\n`
        );
      }
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        [
          "Include conf.d/[[:digit:]].conf conf.d/[[:bogus:]a].conf",
          "Host *",
          "  User none",
          "",
        ].join("\n")
      );

      expect((await resolveSSHConfig("one")).user).toBe("user-one");
      expect((await resolveSSHConfig("letter")).user).toBe("none");
    });
  });

  test("expands environment variables and local %-tokens in an Include path (OpenSSH 9.9+)", async () => {
    const variable = "XUM_SSH_CONFIG_TEST_DIR";
    await withTempHome(async (homeDir) => {
      const confDir = path.join(homeDir, ".ssh", "conf.d");
      await fs.mkdir(confDir);
      process.env[variable] = confDir;
      const unset = `\${XUM_SSH_CONFIG_TEST_UNSET}`;
      await fs.mkdir(path.join(confDir, unset));
      const files = [
        ["env.conf", "env-host"],
        ["home.conf", "home-host"],
        ["named-host.conf", "named-host"],
        // Only a literal reading of an unset variable or the port token finds these files.
        [`${unset}/unset.conf`, "unset-host"],
        ["%p.conf", "port-host"],
      ];
      for (const [file, host] of files) {
        await fs.writeFile(path.join(confDir, file), `Host ${host}\n  User user-${host}\n`);
      }
      await fs.writeFile(
        path.join(homeDir, ".ssh", "config"),
        [
          `Include \${${variable}}/env.conf %d/.ssh/conf.d/home.conf conf.d/%n.conf`,
          `Include conf.d/${unset}/unset.conf conf.d/%p.conf`,
          "Host *",
          "  User none",
          "",
        ].join("\n")
      );

      try {
        expect((await resolveSSHConfig("env-host")).user).toBe("user-env-host");
        expect((await resolveSSHConfig("home-host")).user).toBe("user-home-host");
        expect((await resolveSSHConfig("named-host")).user).toBe("user-named-host");
        expect((await resolveSSHConfig("unset-host")).user).toBe("none");
        expect((await resolveSSHConfig("port-host")).user).toBe("none");
      } finally {
        Reflect.deleteProperty(process.env, variable);
      }
    });
  });

  // OpenSSH 8.6+ splits config arguments with argv_split (misc.c): backslash escapes, quotes
  // anywhere in an argument, and a # that starts an argument ends the line.
  test("reads Include paths with escaped spaces and quotes as OpenSSH does", async () => {
    await withTempHome(async (homeDir) => {
      const sshDir = path.join(homeDir, ".ssh");
      const files = {
        a: path.join(sshDir, "conf dir", "a.conf"),
        b: path.join(sshDir, 'say "hi"', "b.conf"),
        c: path.join(sshDir, "single dir", "c.conf"),
      };
      for (const [host, file] of Object.entries(files)) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `Host ${host}\n  User ${host}user\n`, "utf8");
      }
      const configPath = path.join(sshDir, "config");
      await fs.writeFile(
        configPath,
        [
          // Absolute: ssh -G resolves a relative Include against the real ~/.ssh.
          `Include ${sshDir}/conf\\ dir/a.conf`,
          `Include "${sshDir}/say \\"hi\\"/b.conf"`,
          `Include ${sshDir}/'single dir'/c.conf # not a path`,
          "Host *",
          "  User fallback",
          "",
        ].join("\n"),
        "utf8"
      );

      for (const host of ["a", "b", "c"]) {
        expect((await resolveSSHConfig(host)).user).toBe(`${host}user`);
        if (hasOpenSsh) {
          expect(opensshUserAndProxy(configPath, host).user).toBe(`${host}user`);
        }
      }
    });
  });

  test("applies an Include inside a Host block only to the hosts that block matches", async () => {
    await withTempHome(async (homeDir) => {
      const included = path.join(homeDir, ".ssh", "gated.conf");
      await fs.writeFile(included, "Host *\n  User gateduser\n  ProxyCommand nc %h %p\n", "utf8");
      const configPath = path.join(homeDir, ".ssh", "config");
      await fs.writeFile(
        configPath,
        ["Host gated !gated-not", `  Include ${included}`, "Host *", "  User fallback", ""].join(
          "\n"
        ),
        "utf8"
      );

      const resolve = async (host: string) => {
        const { user, proxyCommand } = await resolveSSHConfig(host);
        return { user, proxyCommand };
      };
      expect(await resolve("gated")).toEqual({ user: "gateduser", proxyCommand: "nc %h %p" });
      for (const host of ["elsewhere", "gated-not"]) {
        expect(await resolve(host)).toEqual({ user: "fallback", proxyCommand: undefined });
      }
      if (hasOpenSsh) {
        for (const host of ["gated", "elsewhere", "gated-not"]) {
          expect(await resolve(host)).toEqual(opensshUserAndProxy(configPath, host));
        }
      }
    });
  });
});
