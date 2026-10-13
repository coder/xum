import { describe, expect, test } from "bun:test";
import { mcpServerConsentName, mcpServerDisplayName } from "./pluginServerKey";

describe("plugin server key display", () => {
  test("a canonical plugin key shows its server part; other keys show as they are", () => {
    expect(mcpServerDisplayName("plugin:0123456789abcdef:tray")).toBe("tray");
    // The server part may itself contain colons.
    expect(mcpServerDisplayName("plugin:0123456789abcdef:a:b")).toBe("a:b");
    // A user-defined key that only looks similar is not a plugin key.
    for (const key of [
      "plugin:custom",
      "plugin:0123456789ABCDEF:tray",
      "plugin:0123:tray",
      "tray",
    ]) {
      expect(mcpServerDisplayName(key)).toBe(key);
      expect(mcpServerConsentName(key)).toBe(key);
    }
  });

  test("consent keeps two plugins with the same server name apart", () => {
    const a = mcpServerConsentName("plugin:0123456789abcdef:tray");
    const b = mcpServerConsentName("plugin:fedcba9876543210:tray");
    expect(a).toBe("tray (plugin 01234567)");
    expect(a).not.toBe(b);
  });
});
