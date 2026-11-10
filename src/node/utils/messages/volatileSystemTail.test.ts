import { describe, expect, it } from "bun:test";
import { acceptsVolatileSystemTailRow } from "./volatileSystemTail";

describe("acceptsVolatileSystemTailRow", () => {
  it.each([
    // Mythos 5.1 rejoined the prefix-bound list (#8082), and Anthropic documents
    // mid-conversation system messages for it, so it gets the row like Mythos 5.2.
    ["anthropic:claude-mythos-5-1", "anthropic", true],
    ["anthropic:claude-mythos-5-1", "coder", true],
    ["anthropic:claude-mythos-5-2", "anthropic", true],
    ["anthropic:claude-fable-5-2", "coder", true],
    // OpenRouter converts the body on its side, so no row goes out there.
    ["anthropic:claude-mythos-5-1", "openrouter", false],
    // Only the anthropic and coder routes count; an unknown route sends no row.
    ["anthropic:claude-mythos-5-1", undefined, false],
    // A model that does not bind thinking to the prefix keeps the tail in the system prompt.
    ["anthropic:claude-mythos-5", "anthropic", false],
    ["openai:gpt-5.5", "coder", false],
  ] as const)("%s on route %p accepts the row: %p", (model, route, expected) => {
    expect(acceptsVolatileSystemTailRow(model, route, null)).toBe(expected);
  });
});
