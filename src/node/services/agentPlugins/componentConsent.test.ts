import { describe, expect, test } from "bun:test";

import type { MCPHttpServerInfo, MCPStdioServerInfo } from "@/common/types/mcp";
import {
  consentForSelection,
  isComponentConsented,
  serverConsentFingerprint,
  skillConsentFingerprint,
} from "./componentConsent";

const roots = { rootPath: "/home/u/.xum/plugins/demo", dataPath: "/home/u/.xum/plugin-data/abc" };
const stdio: MCPStdioServerInfo = {
  transport: "stdio",
  disabled: false,
  command: "node",
  args: [`${roots.rootPath}/server.js`],
  env: { B: "2", A: "1", PLUGIN_DATA: roots.dataPath },
  cwd: roots.rootPath,
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
    const moved = { rootPath: "/srv/staging/demo", dataPath: "/srv/data/xyz" };
    const relocated: MCPStdioServerInfo = {
      ...stdio,
      args: [`${moved.rootPath}/server.js`],
      env: { A: "1", PLUGIN_DATA: moved.dataPath, B: "2" },
      cwd: moved.rootPath,
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
  });

  test("any launch-relevant change gives a new fingerprint", () => {
    const fp = serverConsentFingerprint(stdio, roots);
    const variants: MCPStdioServerInfo[] = [
      { ...stdio, command: "python3" },
      { ...stdio, args: [...(stdio.args ?? []), "--flag"] },
      { ...stdio, env: { ...stdio.env, NODE_OPTIONS: "--require=x" } },
      { ...stdio, cwd: roots.dataPath },
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
  test("covers the root-relative directory and the whole SKILL.md text", () => {
    const content = "---\nname: foo\ndescription: d\n---\nBody\n";
    const fp = skillConsentFingerprint({ relativeDir: "skills/foo", content });
    expect(skillConsentFingerprint({ relativeDir: "skills\\foo", content })).toBe(fp);
    expect(skillConsentFingerprint({ relativeDir: "extra/foo", content })).not.toBe(fp);
    expect(
      skillConsentFingerprint({ relativeDir: "skills/foo", content: `${content}More\n` })
    ).not.toBe(fp);
  });
});

describe("isComponentConsented", () => {
  test("only an own record with the same fingerprint counts", () => {
    const consent = { skills: { foo: "aa" }, mcpServers: { echo: "bb" } };
    expect(isComponentConsented(consent, "skills", "foo", "aa")).toBe(true);
    expect(isComponentConsented(consent, "skills", "foo", "bb")).toBe(false);
    expect(isComponentConsented(consent, "mcpServers", "foo", "aa")).toBe(false);
    expect(isComponentConsented(consent, "skills", "constructor", "aa")).toBe(false);
    // Every install from before #6498 has no record, so nothing is consented.
    expect(isComponentConsented(undefined, "skills", "foo", "aa")).toBe(false);
  });
});

describe("consentForSelection", () => {
  const shown = { skills: { a: "a2", b: "b2" }, mcpServers: { s: "s2" } };

  test("install records every selected component it showed", () => {
    expect(
      consentForSelection({ selection: { skills: ["a"], mcpServers: ["s", "gone"] }, shown })
    ).toEqual({ skills: { a: "a2" }, mcpServers: { s: "s2" } });
  });

  test("a picker save records only newly added components", () => {
    const consent = consentForSelection({
      selection: { skills: ["a", "b"], mcpServers: ["s"] },
      shown,
      previous: {
        selection: { skills: ["a"], mcpServers: ["s"] },
        // `a` was reviewed at an older fingerprint. `s` was never reviewed.
        consent: { skills: { a: "a1", dropped: "x" }, mcpServers: {} },
      },
    });
    // `a` keeps its old record and `s` stays without one: the picker did not review them.
    expect(consent).toEqual({ skills: { a: "a1", b: "b2" }, mcpServers: {} });
  });

  test("narrowing a legacy import-all entry approves nothing", () => {
    const consent = consentForSelection({
      selection: { skills: ["a"], mcpServers: ["s"] },
      shown,
      previous: { selection: { skills: ["a", "b"], mcpServers: ["s"] }, consent: undefined },
    });
    expect(consent).toEqual({ skills: {}, mcpServers: {} });
  });
});
