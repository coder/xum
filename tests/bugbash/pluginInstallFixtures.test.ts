/**
 * The install-method fixtures preview as the charters describe them (charters.install-methods.txt):
 * which "Install as" choices fit, which marketplace entries install, and which skills Xum rejects.
 * A change in the install service that silently changes a fixture's meaning fails here, not in a
 * paid bug-bash run.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentPluginSourcePreview } from "../../src/common/orpc/schemas/agentPlugins";
import { Config } from "../../src/node/config";
import { AgentPluginInstallService } from "../../src/node/services/agentPlugins/installService";
import { writeInstallSources } from "./pluginInstallFixtures";

let tmpRoot: string;
let sources: Map<string, string>;
let service: AgentPluginInstallService;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xum-bugbash-install-fixtures-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmpRoot, ".gitconfig") };
  sources = writeInstallSources(path.join(tmpRoot, "sources"), env);
  service = new AgentPluginInstallService(new Config(path.join(tmpRoot, "xum")), {});
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

async function preview(name: string): Promise<AgentPluginSourcePreview> {
  const input = sources.get(name);
  if (input == null) throw new Error(`no fixture ${name}`);
  return service.previewSource({ input });
}

async function pluginPreview(name: string) {
  const result = await preview(name);
  if (result.kind !== "plugin") throw new Error(`${name} previewed as a ${result.kind}`);
  return result.preview;
}

test("claude-review-kit is a Claude Code plugin that also fits Skills", async () => {
  const kit = await pluginPreview("claude-review-kit");
  expect(kit.methods.map((method) => method.kind)).toEqual(["claude-plugin", "skills"]);
  // commands/review.md (with a bracketed argument-hint) loads as a skill next to the two skills.
  expect(kit.skills.map((skill) => skill.name).sort()).toEqual([
    "lint-rules",
    "review",
    "test-plan",
  ]);
  expect(kit.agents).toEqual(["reviewer.md"]);
  expect(kit.mcpServers.map((server) => server.serverName)).toEqual(["review-index"]);
  // The Claude hook is listed and never runs.
  expect(kit.codexHooks.map((hook) => [hook.event, hook.status])).toEqual([
    ["PostToolUse", "claude-plugin"],
  ]);
});

test("claude-market lists five entries, one of them not installable", async () => {
  const result = await preview("claude-market");
  if (result.kind !== "marketplace") throw new Error(`previewed as a ${result.kind}`);
  const entries = result.marketplace.entries.map((entry) => [
    entry.name,
    entry.builds.some((build) => build.installable),
  ]);
  // The github entry is listed as installable; it fails only when Xum fetches it.
  expect(entries).toEqual([
    ["document-skills", true],
    ["art-skills", true],
    ["tools", true],
    ["npm-tools", false],
    ["remote-kit", true],
  ]);
  // "Install the repository as Skills".
  expect(result.marketplace.methods.map((method) => method.kind)).toEqual(["skills"]);
});

test("cursor-market lists pstack once with both builds, and a nested Cursor folder", async () => {
  const result = await preview("cursor-market");
  if (result.kind !== "marketplace") throw new Error(`previewed as a ${result.kind}`);
  expect(
    result.marketplace.entries.map((entry) => [
      entry.name,
      entry.builds.map((build) => [build.file, build.installable]),
    ])
  ).toEqual([
    [
      "pstack",
      [
        ["cursor", true],
        ["claude", true],
      ],
    ],
    ["notes", [["cursor", true]]],
  ]);
});

test("plain-skills installs as Skills only, without the skill whose description is too long", async () => {
  const skills = await pluginPreview("plain-skills");
  expect(skills.methods.map((method) => method.kind)).toEqual(["skills"]);
  expect(skills.skills.map((skill) => skill.name).sort()).toEqual([
    "changelog",
    "commit-message",
    "doc-outline",
    "merge-risk",
    "plain-english",
    "release-check",
  ]);
});

test("agent-plugin-with-skills fits only Agent Plugin from a local path", async () => {
  const plugin = await pluginPreview("agent-plugin-with-skills");
  expect(plugin.methods.map((method) => method.kind)).toEqual(["agent-plugin"]);
  expect(plugin.skills.map((skill) => skill.name).sort()).toEqual(["api-docs", "changelog-writer"]);
});

test("snake-case-skills offers each snake_case skill folder under its kebab-case name", async () => {
  const plugin = await pluginPreview("snake-case-skills");
  expect(plugin.skills.map((skill) => skill.name).sort()).toEqual([
    "egm-bootstrap",
    "egm-review-loop",
  ]);
  expect(plugin.warnings).toEqual([]);
});
