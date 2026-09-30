import { describe, expect, test } from "bun:test";

import { expandPluginPlaceholders } from "./expansion";

const VARS = { PLUGIN_ROOT: "/plugins/demo", PLUGIN_DATA: "/data/demo" };

describe("expandPluginPlaceholders", () => {
  test("replaces every exact occurrence of both placeholders", () => {
    expect(expandPluginPlaceholders("${PLUGIN_ROOT}/bin:${PLUGIN_DATA}/cache", VARS)).toBe(
      "/plugins/demo/bin:/data/demo/cache"
    );
    expect(expandPluginPlaceholders("${PLUGIN_ROOT}${PLUGIN_ROOT}", VARS)).toBe(
      "/plugins/demo/plugins/demo"
    );
  });

  test("is single-pass and non-recursive: replacement text is never rescanned", () => {
    const vars = { PLUGIN_ROOT: "${PLUGIN_DATA}", PLUGIN_DATA: "/data" };
    // If expansion rescanned replacements, this would become "/data".
    expect(expandPluginPlaceholders("${PLUGIN_ROOT}", vars)).toBe("${PLUGIN_DATA}");
  });

  test("leaves unrecognized placeholder-like text literal", () => {
    expect(
      expandPluginPlaceholders("${HOME}/x ${PLUGIN_ROOTS} $PLUGIN_ROOT ${plugin_root}", VARS)
    ).toBe("${HOME}/x ${PLUGIN_ROOTS} $PLUGIN_ROOT ${plugin_root}");
  });

  test("returns strings without placeholders unchanged", () => {
    expect(expandPluginPlaceholders("plain text", VARS)).toBe("plain text");
    expect(expandPluginPlaceholders("", VARS)).toBe("");
  });
});
