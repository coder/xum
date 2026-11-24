import { describe, expect, test } from "bun:test";
import { buildMcpToolName, normalizeMcpToolNamePart } from "@/common/utils/tools/mcpToolName";
import { mcpToolDisplayName } from "./mcpToolDisplayName";

const INSTANCE = "656443adaa7377b9";
const KEY = `plugin:${INSTANCE}:coder`;
const RAW = `plugin_${INSTANCE}_coder_coder_create_chat`;

describe("mcpToolDisplayName", () => {
  test("drops the exact normalized prefix of a canonical plugin connection", () => {
    expect(mcpToolDisplayName(RAW, { key: KEY })).toBe("coder_create_chat");
    // Normalization of the key must match the backend's tool-name builder,
    // including server names that need lowercasing or separator folding.
    const spaced = buildMcpToolName({
      serverName: `plugin:${INSTANCE}:My Server`,
      toolName: "Do Thing",
      usedNames: new Set(),
    });
    expect(spaced?.toolName).toBe(`plugin_${INSTANCE}_my_server_do_thing`);
    expect(mcpToolDisplayName(spaced!.toolName, { key: `plugin:${INSTANCE}:My Server` })).toBe(
      "do_thing"
    );
  });

  test("keeps collision and truncation suffixes on the shortened identifier", () => {
    const used = new Set([RAW]);
    const collided = buildMcpToolName({
      serverName: KEY,
      toolName: "coder_create_chat",
      usedNames: used,
    });
    expect(collided?.wasSuffixed).toBe(true);
    expect(mcpToolDisplayName(collided!.toolName, { key: KEY })).toMatch(
      /^coder_create_chat_[a-z0-9]{8}$/
    );
  });

  test("returns the raw name when the tool is not positively associated with the key", () => {
    for (const [toolName, key] of [
      // Same server name under a different installation: never cross-shortened.
      [RAW, "plugin:0000000000000000:coder"],
      // Prefix matches only partially (server part differs).
      [RAW, `plugin:${INSTANCE}:code`],
      // Only the prefix survived (nothing readable left to show).
      [`plugin_${INSTANCE}_coder`, KEY],
      [`plugin_${INSTANCE}_coder_`, KEY],
      // Truncation ate the prefix: the remainder cannot be trusted.
      [`plugin_${INSTANCE}_cod_1a2b3c4d`, KEY],
    ] as const) {
      expect(mcpToolDisplayName(toolName, { key })).toBe(toolName);
    }
  });

  test("never parses non-canonical keys, even when their normalized prefix would match", () => {
    for (const key of [
      "notion-work",
      "plugin:custom",
      // Wrong hash width / case (not a computePluginInstanceId output).
      "plugin:656443adaa7377b:coder",
      "plugin:656443ADAA7377B9:coder",
      "plugin:656443adaa7377b9",
      " plugin:656443adaa7377b9:coder",
    ]) {
      const toolName = `${normalizeMcpToolNamePart(key)}_search`;
      expect(mcpToolDisplayName(toolName, { key })).toBe(toolName);
    }
  });
});
