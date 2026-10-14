import { afterEach, expect, spyOn, test } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { sharedDurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { codexPluginHookService, type EnsureCodexHooksArgs } from "./codexHookService";
import { agentPluginHookService } from "./hookService";
import { prepareWorkspaceRequestHooks } from "./requestHooks";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

test("a multi-project workspace with an untrusted secondary project runs no Codex hook", async () => {
  // Codex P1 (PRRT_kwDOPxxmWM6r_vUC): Codex hooks run MCP tools in the runtime all projects
  // share, so one untrusted repo must close the gate, as for the repo's own tool hooks.
  const projects: ProjectsConfig["projects"] = new Map([
    ["/repo/primary", { workspaces: [], trusted: true }],
    ["/repo/secondary", { workspaces: [] }],
  ]);
  const config = {
    rootDir: "/xum",
    sessionsDir: "/xum/sessions",
    loadConfigOrDefault: () => ({ projects }),
  } as unknown as Config;
  const metadata: WorkspaceMetadata = {
    id: "ws-multi",
    name: "ws-multi",
    projectName: "primary",
    projectPath: "/repo/primary",
    runtimeConfig: { type: "local" },
    projects: [
      { projectPath: "/repo/primary", projectName: "primary" },
      { projectPath: "/repo/secondary", projectName: "secondary" },
    ],
  };
  let codexArgs: EnsureCodexHooksArgs | undefined;
  spies.push(
    spyOn(agentPluginHookService, "ensureWorkspaceHooksForRequest").mockResolvedValue(undefined),
    spyOn(codexPluginHookService, "ensureWorkspaceHooks").mockImplementation((args) => {
      codexArgs = args;
      return Promise.resolve();
    })
  );
  const mcp = {
    callToolForPluginHook: () => Promise.resolve({}),
    canCallToolForPluginHook: () => true,
  };

  await prepareWorkspaceRequestHooks({
    config,
    metadata,
    hostCheckoutRoot: null,
    journal: sharedDurableEventJournal("/xum/sessions/ws-multi"),
    mcpServerManager: mcp,
  });

  // No host checkout: no plugin MCP context, so no Codex hook can run (PRRT_kwDOPxxmWM6rSBix).
  expect(codexArgs?.noPluginMcp).toBe(true);
  // The service reads this gate at registration and again before every hook call.
  expect(codexArgs?.isProjectTrusted()).toBe(false);
  projects.set("/repo/secondary", { workspaces: [], trusted: true });
  expect(codexArgs?.isProjectTrusted()).toBe(true);
});
