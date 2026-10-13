// Bootstrap Happy DOM before react-dom evaluates.
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { PluginSlashCommandDescriptor } from "@/common/orpc/schemas/agentPlugins";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import { useComposerSuggestions } from "./useComposerSuggestions";

const GREET: PluginSlashCommandDescriptor = {
  name: "greet",
  description: "Say hello",
  expansion: "Please greet the user warmly.",
  pluginName: "my-plugin",
  scope: "global",
};

const GREET_PROMPT: MCPPromptDescriptor = {
  commandKey: "greet-prompt",
  stableKey: "greet-prompt-1a2b",
  serverName: "srv",
  promptName: "greet",
};

let harness: ConnectionHarness;
/** The MCP prompts the next server lists, or a promise of them. */
let serverPrompts: MCPPromptDescriptor[] | Promise<MCPPromptDescriptor[]>;
/** The plugin commands the next server lists, or a promise of them. */
let serverCommands: PluginSlashCommandDescriptor[] | Promise<PluginSlashCommandDescriptor[]>;

function serverOverrides(): TestApiOverrides<APIClient> {
  const commands = serverCommands;
  const prompts = serverPrompts;
  return {
    workspace: {
      plugins: { slashCommands: { list: () => Promise.resolve(commands) } },
      mcp: { prompts: { list: () => Promise.resolve(prompts) } },
    },
  };
}

function renderSuggestions(workspaceId: string) {
  const inputRef = { current: null };
  return renderHook(
    (props: { workspaceId: string }) =>
      useComposerSuggestions({
        input: "/gre",
        setInput: () => undefined,
        inputRef,
        variant: "workspace",
        workspaceId: props.workspaceId,
        projectPath: null,
      }),
    { wrapper: harness.Wrapper, initialProps: { workspaceId } }
  );
}

function hasGreet(suggestions: Array<{ id: string }>): boolean {
  return suggestions.some((suggestion) => suggestion.id === "plugin-command:greet");
}

function hasGreetPrompt(suggestions: Array<{ id: string }>): boolean {
  return suggestions.some((suggestion) => suggestion.id === "mcp-prompt:greet-prompt");
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

// The slash menu lists plugin commands of the workspace. A reconnect keeps them listed until the
// new client answers; a workspace switch (also while offline) never shows the old workspace's.
describe.each([...GAP_MODES])("composer suggestions across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    serverCommands = [GREET];
    serverPrompts = [GREET_PROMPT];
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the listed commands while offline and until the reload answers", async () => {
    const view = renderSuggestions("ws-a");
    await waitFor(() => expect(hasGreet(view.result.current.suggestions)).toBe(true));

    let answer: ((commands: PluginSlashCommandDescriptor[]) => void) | null = null;
    serverCommands = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    await settle();
    expect(hasGreet(view.result.current.suggestions)).toBe(true);
    harness.reconnect();
    await settle();
    expect(hasGreet(view.result.current.suggestions)).toBe(true);

    act(() => answer?.([]));
    await waitFor(() => expect(hasGreet(view.result.current.suggestions)).toBe(false));
  });

  test("a workspace switch while offline drops the old workspace's commands", async () => {
    const view = renderSuggestions("ws-a");
    await waitFor(() => expect(hasGreet(view.result.current.suggestions)).toBe(true));

    await harness.drop();
    view.rerender({ workspaceId: "ws-b" });
    await settle();
    expect(hasGreet(view.result.current.suggestions)).toBe(false);
  });

  test("keeps the listed MCP prompts while offline", async () => {
    const view = renderSuggestions("ws-a");
    await waitFor(() => expect(hasGreetPrompt(view.result.current.suggestions)).toBe(true));

    await harness.drop();
    await settle();
    expect(hasGreetPrompt(view.result.current.suggestions)).toBe(true);
  });

  test("an MCP prompt request lost with the connection is asked again after the reconnect", async () => {
    // The first server never answers: the request is still in flight when the connection drops.
    serverPrompts = new Promise(() => undefined);
    harness = createConnectionHarness(mode, serverOverrides);
    const view = renderSuggestions("ws-a");
    await waitFor(() => expect(hasGreet(view.result.current.suggestions)).toBe(true));

    await harness.drop();
    await settle();
    serverPrompts = [GREET_PROMPT];
    harness.reconnect();
    await waitFor(() => expect(hasGreetPrompt(view.result.current.suggestions)).toBe(true));
  });
});
