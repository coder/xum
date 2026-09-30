import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { fingerprintPromptPrefix } from "./promptPrefixFingerprint";

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
// Which per-tool hashes differ between two fingerprints of the same tools.
const changedToolFields = (a: Tools, b: Tools) => {
  const before = new Map(fingerprint(a).tools.map((tool) => [tool.name, tool]));
  return fingerprint(b).tools.flatMap((tool) =>
    (["description", "schema", "options"] as const)
      .filter((field) => before.get(tool.name)?.[field] !== tool[field])
      .map((field) => `${field}:${tool.name}`)
  );
};

describe("fingerprintPromptPrefix (#5254)", () => {
  const base = [fn("a"), fn("b"), fn("c", { providerOptions: cached })];

  it.each<{ label: string; next: Tools; changed: string[] }>([
    {
      label: "a description",
      next: [fn("a", { description: "new" }), fn("b"), base[2]],
      changed: ["description:a"],
    },
    {
      label: "a schema",
      next: [fn("a"), fn("b", { inputSchema: { type: "object", required: ["x"] } }), base[2]],
      changed: ["schema:b"],
    },
    {
      label: "a moved cache marker",
      next: [fn("a"), fn("b", { providerOptions: cached }), fn("c")],
      changed: ["options:b", "options:c"],
    },
  ])("changes only the tool hashes for $label", ({ next, changed }) => {
    expect(fingerprint(next).toolsHash).not.toBe(fingerprint(base).toolsHash);
    expect(changedToolFields(base, next)).toEqual(changed);
  });

  it("changes the tool block hash, not the per-tool hashes, on a reorder", () => {
    const reordered = [base[1], base[0], base[2]];
    expect(fingerprint(reordered).toolsHash).not.toBe(fingerprint(base).toolsHash);
    expect(changedToolFields(base, reordered)).toEqual([]);
  });

  it("ignores schema key order, which provider caches ignore too (#5252)", () => {
    const reordered = [fn("b", { inputSchema: { properties: {}, type: "object" } })];
    const keyed = [fn("b", { inputSchema: { type: "object", properties: {} } })];
    expect(fingerprint(reordered)).toEqual(fingerprint(keyed));
  });

  it.each([
    ["Anthropic cacheControl", cached],
    ["OpenAI's explicit breakpoint", { openai: { promptCacheBreakpoint: { mode: "explicit" } } }],
  ])("ends the cached system prefix at the last row with %s", (_label, marker) => {
    const withTail = (tail: string) =>
      fingerprintPromptPrefix({
        tools: base,
        prompt: [
          { role: "system", content: "Stable", providerOptions: marker },
          { role: "system", content: tail },
          { role: "user", content: [{ type: "text", text: "Hi" }] },
        ],
      });
    expect(withTail("one").systemPrefixHash).toBe(withTail("two").systemPrefixHash);
    expect(withTail("one").systemTailHash).not.toBe(withTail("two").systemTailHash);
  });

  it("has no tail when no system row is marked", () => {
    const unmarked = fingerprintPromptPrefix({
      tools: base,
      prompt: [{ role: "system", content: "Stable" }],
    });
    expect(unmarked.systemTailHash).toBeNull();
  });
});
