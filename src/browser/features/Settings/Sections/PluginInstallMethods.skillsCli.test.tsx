import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { SkillsCliInstall } from "./PluginInstallMethods";

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
