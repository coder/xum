import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
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
});
