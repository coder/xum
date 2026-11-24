import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginInstallPreview } from "@/common/orpc/schemas/agentPlugins";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

function previewOf(overrides: Partial<AgentPluginInstallPreview>): AgentPluginInstallPreview {
  return {
    source: {
      type: "git",
      url: "https://github.com/acme/egm.git",
      ref: "main",
      refType: "branch",
    },
    method: { kind: "claude-plugin" },
    methods: [{ kind: "claude-plugin" }],
    skillsCliSkills: [],
    lockedSha: "b".repeat(40),
    manifest: { name: "egm" },
    skills: [],
    mcpServers: [],
    agents: [],
    readonlyAgents: [],
    shellRemovedAgents: [],
    workflows: [],
    slashCommands: [],
    reviewedComponents: [],
    codexHooks: [],
    notApplied: [],
    fileChanges: [],
    warnings: [],
    targetPath: "~/.mux/plugins/egm",
    consentDigest: "c".repeat(64),
    ...overrides,
  };
}

async function openPreview(preview: AgentPluginInstallPreview) {
  const api = createMockORPCClient({ agentPlugins: { items: [], preview } });
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: "Add plugin" }));
  await userEvent.type(await view.findByLabelText(/Git URL or owner\/repo/), "acme/egm");
  fireEvent.click(view.getByRole("button", { name: /Preview/ }));
  await view.findByRole("button", { name: "Install" });
  return view;
}

const hook = (
  overrides: Partial<AgentPluginInstallPreview["codexHooks"][number]>
): AgentPluginInstallPreview["codexHooks"][number] => ({
  key: "hooks/hooks.json#Stop[0][0]",
  hash: "4".repeat(64),
  event: "Stop",
  handler: { type: "mcp_tool", server: "scanner", tool: "scan", input: {} },
  status: "runnable",
  source: "hooks/hooks.json",
  ...overrides,
});

test("workflows are listed by file name, separated by commas", async () => {
  const view = await openPreview(previewOf({ workflows: ["release-notes.js", "triage.js"] }));

  view.getByText("Workflows (2)");
  expect(view.getByText("release-notes.js").parentElement?.textContent).toStartWith(
    "release-notes.js, triage.js — executable workflow scripts"
  );
  expect(view.getByText("triage.js").tagName).toBe("SPAN");
});

test("the hook list says how each hook is matched, what it does and why it never runs", async () => {
  const view = await openPreview(
    previewOf({
      codexHooks: [
        hook({
          key: "a",
          event: "PreToolUse",
          matcher: "^bash$",
          handler: { type: "command", summary: "node ${CLAUDE_PLUGIN_ROOT}/hooks/check.js" },
          status: "claude-plugin",
        }),
        hook({ key: "b", event: "Stop" }),
        hook({
          key: "c",
          event: "stop",
          handler: { type: "cursor-command", command: "./hooks/stop.sh", declared: "{}" },
        }),
        hook({
          key: "d",
          event: "subagentStop",
          handler: { type: "cursor-command", command: "./hooks/sub.sh", declared: "{}" },
          status: "ignored-event",
        }),
      ],
    })
  );

  view.getByText("hooks.json hooks (4)");
  const items = view
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "")
    .filter((text) => /^(PreToolUse|Stop|stop|subagentStop)/.test(text));
  const remote = "Does not run in remote workspaces (SSH, Docker and devcontainer).";
  expect(items).toEqual([
    "PreToolUse (^bash$) — command: node ${CLAUDE_PLUGIN_ROOT}/hooks/check.js. Never runs: Xum does not run Claude Code plugin hooks.",
    "Stop — MCP tool scanner / scan, default timeout 10s",
    `stop — command ./hooks/stop.sh, default timeout 10s. ${remote}`,
    `subagentStop — command ./hooks/sub.sh, default timeout 10s. Never runs: event not applied in Xum. ${remote}`,
  ]);
});

test("one hook is a list of one, and the run note fits it", async () => {
  const view = await openPreview(previewOf({ codexHooks: [hook({})] }));

  view.getByText("hooks.json hooks (1)");
  view.getByText("None of these run until you trust each one in Settings → Plugins.");
});

test("reviewed definitions show the kind and file name of each, and their text on demand", async () => {
  const view = await openPreview(
    previewOf({
      reviewedComponents: [
        { kind: "agents", name: "reviewer.md", detail: "Reviews a design." },
        { kind: "workflows", name: "triage.js", detail: "Triages issues." },
      ],
    })
  );

  view.getByText("Reviewed definitions (2)");
  const summaries = [...view.container.querySelectorAll("summary")].map(
    (summary) => summary.textContent
  );
  expect(summaries).toEqual(["Agent reviewer.md", "Workflow triage.js"]);
  expect(view.getByText("Triages issues.").closest("details")?.textContent).toStartWith(
    "Workflow triage.js"
  );
});

test("a single reviewed definition is listed, and none shows no section", async () => {
  const one = await openPreview(
    previewOf({ reviewedComponents: [{ kind: "agents", name: "a.md", detail: "A." }] })
  );
  one.getByText("Reviewed definitions (1)");
  cleanup();

  const none = await openPreview(previewOf({}));
  expect(none.queryByText(/^Reviewed definitions/)).toBeNull();
  expect(none.queryByText(/^hooks\.json hooks/)).toBeNull();
});
