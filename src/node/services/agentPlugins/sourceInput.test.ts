import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

import {
  isFullCommitSha,
  normalizeAgentPluginSubpath,
  parseAgentPluginSourceInput,
} from "./sourceInput";

describe("parseAgentPluginSourceInput", () => {
  // Shorthand expansion depends on SSH-agent presence; pin it for determinism.
  let savedSshAuthSock: string | undefined;
  beforeEach(() => {
    savedSshAuthSock = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
  });
  afterEach(() => {
    if (savedSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = savedSshAuthSock;
    }
  });

  test("expands owner/repo shorthand to an https clone URL", () => {
    expect(parseAgentPluginSourceInput("coder/mux")).toEqual({
      url: "https://github.com/coder/mux.git",
    });
  });

  test("expands owner/repo shorthand to ssh when an SSH agent is present", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock";
    expect(parseAgentPluginSourceInput("coder/mux").url).toBe("git@github.com:coder/mux.git");
  });

  test("parses @ref from shorthand (branch, tag, or sha all land in ref)", () => {
    expect(parseAgentPluginSourceInput("coder/mux@main")).toEqual({
      url: "https://github.com/coder/mux.git",
      ref: "main",
    });
    expect(parseAgentPluginSourceInput("coder/mux@v1.2.3").ref).toBe("v1.2.3");
    const sha = "a".repeat(40);
    expect(parseAgentPluginSourceInput(`coder/mux@${sha}`).ref).toBe(sha);
  });

  test("parses monorepo subpath segments from shorthand", () => {
    expect(parseAgentPluginSourceInput("coder/mux/plugins/demo@main")).toEqual({
      url: "https://github.com/coder/mux.git",
      ref: "main",
      subpath: "plugins/demo",
    });
  });

  test("normalizes the shorthand subpath and rejects escapes before anything is fetched", () => {
    expect(parseAgentPluginSourceInput("cursor/plugins/pstack/@main")).toEqual({
      url: "https://github.com/cursor/plugins.git",
      ref: "main",
      subpath: "pstack",
    });
    expect(() => parseAgentPluginSourceInput("cursor/plugins/../x")).toThrow(
      /not a valid plugin subpath/
    );
    // An inner empty segment is a typo (not an absolute subpath); one
    // trailing slash on owner/repo still means a root install.
    for (const typo of ["cursor/plugins/a//b", "cursor/plugins//pstack"]) {
      expect(() => parseAgentPluginSourceInput(typo)).toThrow(/not a git URL or owner\/repo/);
    }
    expect(parseAgentPluginSourceInput("cursor/plugins/")).toEqual({
      url: "https://github.com/cursor/plugins.git",
    });
  });

  test("passes through full URLs unchanged (with query/fragment stripped)", () => {
    expect(parseAgentPluginSourceInput("https://github.com/coder/mux.git")).toEqual({
      url: "https://github.com/coder/mux.git",
    });
    expect(parseAgentPluginSourceInput("https://github.com/coder/mux.git?tab=readme").url).toBe(
      "https://github.com/coder/mux.git"
    );
    expect(parseAgentPluginSourceInput("git@github.com:coder/mux.git")).toEqual({
      url: "git@github.com:coder/mux.git",
    });
    expect(parseAgentPluginSourceInput("ssh://git@git.corp:2222/x/y.git").url).toBe(
      "ssh://git@git.corp:2222/x/y.git"
    );
    // SCP-style user portion is optional (git-clone#_git_urls): host-only
    // remotes must reach git instead of failing shorthand parsing.
    expect(parseAgentPluginSourceInput("git.example.com:team/plugin.git")).toEqual({
      url: "git.example.com:team/plugin.git",
    });
    // ...while slash-before-colon inputs stay on the shorthand path.
    expect(parseAgentPluginSourceInput("coder/mux@main").ref).toBe("main");
  });

  test("rejects Git remote-helper transports (arbitrary command execution)", () => {
    // `ext::<cmd>` invokes the command via git-remote-ext before any consent
    // UI when protocol.ext.allow permits; the parser must refuse the syntax
    // outright (GIT_ALLOW_PROTOCOL backstops sources that bypass parsing).
    for (const input of ["ext::touch /tmp/pwned", "fd::17", "custom-helper::payload"]) {
      expect(() => parseAgentPluginSourceInput(input)).toThrow(/remote-helper/);
    }
    // SCP-style single-colon hosts still parse.
    expect(parseAgentPluginSourceInput("git@github.com:coder/mux.git").url).toBe(
      "git@github.com:coder/mux.git"
    );
  });

  test("rejects credential-bearing URLs (persisted + rendered verbatim)", () => {
    // Sources land in ~/.mux/plugins.json and Settings; embedded secrets must
    // never reach either. SSH usernames are routing data and stay allowed.
    expect(() => parseAgentPluginSourceInput("https://user:token@host/repo.git")).toThrow(
      /embedded credentials/
    );
    expect(() => parseAgentPluginSourceInput("https://token@host/repo.git")).toThrow(
      /embedded credentials/
    );
    expect(parseAgentPluginSourceInput("git@github.com:coder/mux.git").url).toBe(
      "git@github.com:coder/mux.git"
    );
    expect(parseAgentPluginSourceInput("ssh://git@git.corp:2222/x/y.git").url).toBe(
      "ssh://git@git.corp:2222/x/y.git"
    );
  });

  test("does not treat @ inside URLs as a ref separator", () => {
    // git@host URLs keep their @ — refs for URL inputs come from the ref field.
    const parsed = parseAgentPluginSourceInput("git@github.com:coder/mux.git");
    expect(parsed.ref).toBeUndefined();
  });

  test("passes through absolute local paths (git handles local remotes)", () => {
    expect(parseAgentPluginSourceInput("/tmp/some-repo").url).toBe("/tmp/some-repo");
  });

  test("expands home-relative paths (git is spawned without a shell)", () => {
    expect(parseAgentPluginSourceInput("~/plugins/demo").url).toBe(
      path.join(os.homedir(), "plugins/demo")
    );
    expect(parseAgentPluginSourceInput("~").url).toBe(os.homedir());
    // Windows-native separator: `~\plugins\demo` must expand too, not reach
    // git as a literal tilde.
    expect(parseAgentPluginSourceInput("~\\plugins\\demo").url).toBe(
      path.join(os.homedir(), "plugins\\demo")
    );
  });

  test("rejects unusable inputs with actionable messages", () => {
    expect(() => parseAgentPluginSourceInput("")).toThrow(/git URL or owner\/repo/);
    expect(() => parseAgentPluginSourceInput("just-a-name")).toThrow(/not a git URL/);
    expect(() => parseAgentPluginSourceInput("./relative/path")).toThrow(/relative path/);
    expect(() => parseAgentPluginSourceInput("coder/mux@")).toThrow(/must not be empty/);
    expect(() => parseAgentPluginSourceInput("-bad/owner")).toThrow(/not a valid owner\/repo/);
  });
});

describe("normalizeAgentPluginSubpath", () => {
  test("accepts repo-relative folders, trimming whitespace and one trailing slash", () => {
    expect(normalizeAgentPluginSubpath("pstack")).toBe("pstack");
    expect(normalizeAgentPluginSubpath(" packages/demo/ ")).toBe("packages/demo");
    expect(normalizeAgentPluginSubpath("a/.github/b-c_d.e")).toBe("a/.github/b-c_d.e");
  });

  test.each([
    ["", /must not be empty/],
    ["/", /must not be empty/],
    ["/abs/path", /absolute path/],
    ["~/plugins", /absolute path/],
    ["C:/plugins", /absolute path/],
    ["..", /not a valid plugin subpath/],
    ["../x", /not a valid plugin subpath/],
    ["a/../../x", /not a valid plugin subpath/],
    ["./x", /not a valid plugin subpath/],
    ["a//b", /not a valid plugin subpath/],
    ["a/b//", /not a valid plugin subpath/],
    [".git", /\.git folder/],
    ["a/.GIT/hooks", /\.git folder/],
    ["a\\b", /not allowed/],
    ["a*", /not allowed/],
    ["a/[b]", /not allowed/],
    ["!a", /not allowed/],
    ["#a", /not allowed/],
    ["a\u0000b", /control characters/],
    ["a\nb", /control characters/],
    ["a /b", /whitespace/],
  ])("rejects %j", (input, message) => {
    expect(() => normalizeAgentPluginSubpath(input)).toThrow(message);
  });
});

describe("isFullCommitSha", () => {
  test("accepts only full 40-hex SHAs", () => {
    expect(isFullCommitSha("a".repeat(40))).toBe(true);
    expect(isFullCommitSha("A1B2C3D4E5".repeat(4))).toBe(true);
    expect(isFullCommitSha("a".repeat(39))).toBe(false);
    expect(isFullCommitSha("a".repeat(41))).toBe(false);
    expect(isFullCommitSha("main")).toBe(false);
  });
});
