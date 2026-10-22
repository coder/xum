import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentPluginGitSource } from "@/common/config/schemas/agentPluginInstalls";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { SkillsCliInstall } from "./PluginInstallMethods";
import { PluginsSettingsSection } from "./PluginsSettingsSection";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

test("a failed CLI run still refreshes the skill lists: it can copy some skills first", async () => {
  const api = createMockORPCClient({
    agentPlugins: {
      skillsCliStatus: { available: true, nodeVersion: "v22.20.0", package: "skills@1.7.4" },
      skillsCliRun: {
        status: "ran",
        ok: false,
        exitCode: 1,
        timedOut: false,
        output: "✓ pdf (copied)\nfatal: lock file",
        command: "npx --yes skills@1.7.4 add …",
        missingSkills: [],
        failure: "The skills CLI failed with exit code 1.",
      },
    },
  });
  let refreshes = 0;
  const onRefresh = () => refreshes++;
  window.addEventListener(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED, onRefresh);
  try {
    const view = render(
      <APIProvider client={api}>
        <TooltipProvider>
          <SkillsCliInstall
            source="https://github.com/acme/skills.git"
            skills={["pdf", "xlsx"]}
            onBack={() => undefined}
          />
        </TooltipProvider>
      </APIProvider>
    );
    fireEvent.click(await view.findByRole("button", { name: "Run skills CLI (2)" }));
    await view.findByText(/exit code 1/);
    await waitFor(() => expect(refreshes).toBe(1));
  } finally {
    window.removeEventListener(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED, onRefresh);
  }
});

test("a running CLI install locks the Install as choice, so its panel stays open", async () => {
  const source: AgentPluginGitSource = {
    type: "git",
    url: "https://github.com/acme/skills.git",
    ref: "main",
    refType: "branch",
  };
  const api = createMockORPCClient({
    agentPlugins: {
      skillsCliStatus: { available: true, nodeVersion: "v22.20.0", package: "skills@1.7.4" },
      preview: {
        source,
        method: { kind: "skills" },
        methods: [{ kind: "skills" }],
        skillsCliSkills: ["pdf"],
        lockedSha: "b".repeat(40),
        manifest: { name: "skills" },
        skills: [],
        mcpServers: [],
        agents: [],
        workflows: [],
        slashCommands: [],
        reviewedComponents: [],
        codexHooks: [],
        warnings: [],
        targetPath: "~/.mux/plugins/skills",
        consentDigest: "c".repeat(64),
      },
    },
  });
  // The run never settles during the test.
  spyOn(api.agentPlugins, "installWithSkillsCli").mockReturnValue(new Promise(() => undefined));
  const view = render(
    <APIProvider client={api}>
      <TooltipProvider>
        <PluginsSettingsSection />
      </TooltipProvider>
    </APIProvider>
  );
  fireEvent.click(await view.findByRole("button", { name: /Add plugin/ }));
  await userEvent.type(await view.findByLabelText(/Git URL or owner\/repo/), "acme/skills");
  fireEvent.click(await view.findByRole("button", { name: /Preview/ }));
  fireEvent.click(await view.findByRole("radio", { name: "Skills CLI" }));
  fireEvent.click(await view.findByRole("button", { name: "Run skills CLI (1)" }));
  await view.findByRole("button", { name: "Running…" });

  // Another choice would unmount the panel, and the run's result would show nowhere.
  fireEvent.click(view.getByRole("radio", { name: "Skills" }));
  expect(view.getByRole("button", { name: "Running…" })).toBeTruthy();
});
