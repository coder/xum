import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { diffPromptPrefix, fingerprintPromptPrefix } from "./promptPrefixFingerprint";

const cached = { anthropic: { cacheControl: { type: "ephemeral" as const } } };
type Tools = NonNullable<LanguageModelV4CallOptions["tools"]>;
const fn = (
  name: string,
  extra: Partial<LanguageModelV4FunctionTool> = {}
): LanguageModelV4FunctionTool => ({
  type: "function",
  name,
  description: name,
  inputSchema: { type: "object" },
  ...extra,
});
const fingerprint = (tools: Tools) =>
  fingerprintPromptPrefix({
    tools,
    prompt: [{ role: "system", content: "Stable", providerOptions: cached }],
  });

describe("diffPromptPrefix (#5254)", () => {
  const base = [fn("a"), fn("b"), fn("c", { providerOptions: cached })];

  it.each<{ label: string; next: Tools; components: string[] }>([
    { label: "nothing", next: base, components: [] },
    {
      label: "an added and a removed tool",
      next: [fn("a"), fn("d"), fn("c", { providerOptions: cached })],
      components: ["tool-added:d", "tool-removed:b"],
    },
    {
      label: "order only",
      next: [fn("b"), fn("a"), fn("c", { providerOptions: cached })],
      components: ["tool-order"],
    },
    {
      label: "a schema",
      next: [fn("a"), fn("b", { inputSchema: { type: "object", required: ["x"] } }), base[2]],
      components: ["tool-schema:b"],
    },
    {
      label: "a moved cache marker",
      next: [fn("a"), fn("b", { providerOptions: cached }), fn("c")],
      components: ["tool-options:b", "tool-options:c"],
    },
    {
      label: "other provider options",
      next: [fn("a", { providerOptions: { anthropic: { deferLoading: true } } }), fn("b"), base[2]],
      components: ["tool-options:a"],
    },
    {
      label: "options changed together with a description",
      next: [fn("a", { description: "new" }), fn("b", { providerOptions: cached }), fn("c")],
      components: ["tool-description:a", "tool-options:b", "tool-options:c"],
    },
  ])("reports $label", ({ next, components }) => {
    expect(diffPromptPrefix(fingerprint(base), fingerprint(next))).toEqual(components);
  });

  it("ignores schema key order, which provider caches ignore too (#5252)", () => {
    const reordered = [
      fn("a"),
      fn("b", { inputSchema: { properties: {}, type: "object" } }),
      base[2],
    ];
    const keyed = [fn("a"), fn("b", { inputSchema: { type: "object", properties: {} } }), base[2]];
    expect(diffPromptPrefix(fingerprint(keyed), fingerprint(reordered))).toEqual([]);
  });

  it("separates the cached system rows from the uncached tail", () => {
    const withTail = fingerprintPromptPrefix({
      tools: base,
      prompt: [
        { role: "system", content: "Stable", providerOptions: cached },
        { role: "system", content: "MCP warning" },
      ],
    });
    expect(diffPromptPrefix(fingerprint(base), withTail)).toEqual(["system-tail-only"]);
    const changedPrefix = fingerprintPromptPrefix({
      tools: base,
      prompt: [{ role: "system", content: "Changed", providerOptions: cached }],
    });
    expect(diffPromptPrefix(fingerprint(base), changedPrefix)).toEqual(["system-prefix"]);
  });
});
