import React, { useEffect, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Switch } from "@/browser/components/Switch/Switch";
import { ToggleGroup } from "@/browser/components/ToggleGroup/ToggleGroup";
import { useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { CONNECTION_LOST_MESSAGE, isStreamFailure } from "@/browser/contexts/connectionLink";
import type { AgentSandboxConfig, AgentSandboxNetwork } from "@/common/config/schemas/agentSandbox";
import { DEFAULT_ALLOWED_HOSTS } from "@/common/constants/agentSandbox";
import type { AgentSandboxState } from "@/common/orpc/schemas/agentSandbox";
import { getErrorMessage } from "@/common/utils/errors";
import { getProjectDisplayName, getTopLevelProjectEntries } from "@/common/utils/subProjects";

function allowedHostsOf(config: AgentSandboxConfig): readonly string[] {
  return config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
}

/** One host per line; blank lines and repeats are dropped. */
function parseHosts(text: string): string[] {
  return [...new Set(text.split("\n").map((line) => line.trim()))].filter((host) => host !== "");
}

function countHosts(count: number): string {
  return `${count} ${count === 1 ? "host" : "hosts"}`;
}

/** The default list is named by what it covers; an edited list only by its size. */
function describeAllowedHosts(config: AgentSandboxConfig): string {
  const count = countHosts(allowedHostsOf(config).length);
  return config.allowedHosts === undefined
    ? `npm, PyPI, crates.io, Go modules, GitHub · ${count}`
    : `Edited list · ${count}`;
}

const NETWORK_OPTIONS: ReadonlyArray<{ value: AgentSandboxNetwork; label: string }> = [
  { value: "allowlist", label: "Allowed hosts only" },
  { value: "open", label: "Any host" },
  { value: "loopback", label: "Loopback only" },
];

/** A project's override of `enabled`: absent follows the global setting. */
type ProjectSandboxMode = "global" | "on" | "off";

const PROJECT_MODE_OPTIONS: Array<{ value: ProjectSandboxMode; label: string }> = [
  { value: "global", label: "Global" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

function projectModeOf(sandbox: AgentSandboxConfig | undefined): ProjectSandboxMode {
  if (sandbox?.enabled === undefined) return "global";
  return sandbox.enabled ? "on" : "off";
}

/** The project's override with a new `enabled`; its other fields stay. */
function withProjectMode(
  sandbox: AgentSandboxConfig | undefined,
  mode: ProjectSandboxMode
): AgentSandboxConfig {
  const { enabled: _enabled, ...rest } = sandbox ?? {};
  return mode === "global" ? rest : { ...rest, enabled: mode === "on" };
}

/** Load the setting, and again after every config change, until `signal` aborts. */
async function followAgentSandbox(
  api: APIClient,
  signal: AbortSignal,
  onLoaded: (state: AgentSandboxState) => void
): Promise<void> {
  const load = async () => {
    const state = await api.agentSandbox.get();
    if (!signal.aborted) onLoaded(state);
  };
  // Load only once the subscription is live, so a change made during the load loads again.
  const changes = await api.config.onConfigChanged(undefined, { signal });
  await load();
  for await (const _ of changes) {
    await load();
  }
}

/** The saved setting, following changes made elsewhere. Saves replace the whole value. */
function useAgentSandbox() {
  const api = useLiveAPI();
  const [state, setState] = useState<AgentSandboxState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // API doubles in tests of other settings can omit this namespace.
    if (api?.agentSandbox == null) return;
    const controller = new AbortController();
    followAgentSandbox(api, controller.signal, setState).catch((loadError: unknown) => {
      if (isStreamFailure(loadError, controller.signal)) {
        setError(`Failed to load the agent sandbox setting: ${getErrorMessage(loadError)}`);
      }
    });
    return () => controller.abort();
  }, [api]);

  const send = (request: (client: APIClient) => Promise<AgentSandboxState>) => {
    if (api == null) {
      setError(CONNECTION_LOST_MESSAGE);
      return;
    }
    request(api)
      .then((saved) => {
        setState(saved);
        setError(null);
      })
      .catch((saveError: unknown) => {
        setError(`Failed to save the agent sandbox setting: ${getErrorMessage(saveError)}`);
      });
  };

  return {
    state,
    error,
    offline: api == null,
    save: (sandbox: AgentSandboxConfig) => send((client) => client.agentSandbox.set(sandbox)),
    saveProject: (projectPath: string, sandbox: AgentSandboxConfig) =>
      send((client) => client.agentSandbox.setProject({ projectPath, sandbox })),
  };
}

/** Edits `allowedHosts`, one host per line. Mounted on open, so each open starts from the saved list. */
function AllowedHostsEditor(props: {
  config: AgentSandboxConfig;
  disabled: boolean;
  onSave: (allowedHosts: string[] | undefined) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => allowedHostsOf(props.config).join("\n"));
  return (
    <div className="space-y-2">
      <textarea
        rows={8}
        value={draft}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
        disabled={props.disabled}
        aria-label="Allowed hosts, one per line"
        className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent w-full resize-y rounded-md border p-2 font-mono text-xs focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="xs"
          // Removing the field follows the default list, also when a later version changes it.
          disabled={props.disabled || props.config.allowedHosts === undefined}
          onClick={() => {
            props.onSave(undefined);
            props.onClose();
          }}
        >
          Use defaults
        </Button>
        <Button variant="outline" size="xs" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={props.disabled}
          onClick={() => {
            props.onSave(parseHosts(draft));
            props.onClose();
          }}
        >
          Save hosts
        </Button>
      </div>
    </div>
  );
}

function NetworkModes(props: {
  config: AgentSandboxConfig;
  disabled: boolean;
  onNetwork: (network: AgentSandboxNetwork) => void;
  onSaveHosts: (allowedHosts: string[] | undefined) => void;
}) {
  const [editingHosts, setEditingHosts] = useState(false);
  const network = props.config.network ?? "allowlist";
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Sandbox network" className="space-y-2">
        <div className="text-foreground text-sm">Network</div>
        {NETWORK_OPTIONS.map((option) => (
          <div key={option.value} className="flex flex-wrap items-start justify-between gap-2">
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="agent-sandbox-network"
                value={option.value}
                checked={network === option.value}
                disabled={props.disabled}
                onChange={() => props.onNetwork(option.value)}
                className="accent-accent mt-1 shrink-0"
              />
              <span className="min-w-0">
                <span className="text-foreground block text-sm">{option.label}</span>
                {option.value === "allowlist" && (
                  <span className="text-muted block text-xs">
                    {describeAllowedHosts(props.config)}
                  </span>
                )}
              </span>
            </label>
            {option.value === "allowlist" && !editingHosts && (
              <Button
                variant="outline"
                size="xs"
                disabled={props.disabled}
                onClick={() => setEditingHosts(true)}
              >
                Edit hosts
              </Button>
            )}
          </div>
        ))}
      </div>
      {editingHosts && (
        <AllowedHostsEditor
          config={props.config}
          disabled={props.disabled}
          onSave={props.onSaveHosts}
          onClose={() => setEditingHosts(false)}
        />
      )}
    </div>
  );
}

/** Turns the sandbox on, off, or back to the global setting for one project at a time. */
function ProjectOverride(props: {
  projects: AgentSandboxState["projects"];
  disabled: boolean;
  onSave: (projectPath: string, sandbox: AgentSandboxConfig) => void;
}) {
  const { userProjects } = useProjectContext();
  // A sub-project without an override of its own follows its parent's, like its checkout.
  const projects = getTopLevelProjectEntries(userProjects).map(([path, config]) => ({
    path,
    name: getProjectDisplayName(path, config),
  }));
  const [picked, setPicked] = useState<string | null>(null);
  // A project removed while Settings is open falls back to the first one.
  const project = projects.find((candidate) => candidate.path === picked) ?? projects[0];
  if (project === undefined) return null;
  const sandbox = props.projects[project.path];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-foreground min-w-0 flex-1 text-sm">Project</div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={project.path} onValueChange={setPicked} disabled={props.disabled}>
            <SelectTrigger
              className="border-border-medium bg-background-secondary hover:bg-hover h-8 w-auto max-w-[200px] min-w-[120px] cursor-pointer rounded-md border px-3 text-sm transition-colors"
              aria-label="Agent sandbox project"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((candidate) => (
                <SelectItem key={candidate.path} value={candidate.path}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div role="group" aria-label={`Agent sandbox for ${project.name}`}>
            <ToggleGroup
              options={PROJECT_MODE_OPTIONS}
              value={projectModeOf(sandbox)}
              disabled={props.disabled}
              onChange={(mode) => props.onSave(project.path, withProjectMode(sandbox, mode))}
            />
          </div>
        </div>
      </div>
      <div className="text-muted text-xs">
        Global follows the setting above. On or Off applies to this project only.
      </div>
    </div>
  );
}

function Header(props: { state: AgentSandboxState | null }) {
  const support = props.state?.support;
  return (
    <div className="mb-4 min-w-0">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-foreground text-sm font-medium">Agent sandbox</h3>
        <DocsLink path="/config/agent-sandbox" />
      </div>
      <div className="text-muted text-xs">
        macOS only. Applies to Local and Worktree workspaces.
      </div>
      {support?.state === "unsupported" && (
        <div className="text-warning mt-1 text-xs">{support.reason}</div>
      )}
    </div>
  );
}

function EnabledSwitch(props: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-foreground text-sm">Run agent commands in a sandbox</div>
        <div className="text-muted text-xs">
          Writes stay in the workspace. Credentials stay hidden.
        </div>
      </div>
      <Switch
        checked={props.enabled}
        onCheckedChange={props.onChange}
        disabled={props.disabled}
        aria-label="Run agent commands in a sandbox"
      />
    </div>
  );
}

/** Which controls can change the setting now. */
function controlsState(state: AgentSandboxState | null, offline: boolean) {
  const global = state?.global ?? {};
  const enabled = global.enabled === true;
  const unavailable = state === null || offline;
  const unsupported = state?.support.state === "unsupported";
  return {
    global,
    enabled,
    disabled: unavailable || unsupported,
    // A switch that is on stays usable, so a sandbox turned on elsewhere can be turned off.
    switchDisabled: unavailable || (unsupported && !enabled),
  };
}

/**
 * Settings > Agents: runs local agent commands in the macOS sandbox. The backend answers
 * whether it can, since the browser can run on another OS than the backend.
 */
export function AgentSandboxSettings() {
  const { state, error, offline, save, saveProject } = useAgentSandbox();
  const { global, enabled, disabled, switchDisabled } = controlsState(state, offline);

  return (
    <div>
      <Header state={state} />
      <div className="space-y-4">
        <EnabledSwitch
          enabled={enabled}
          disabled={switchDisabled}
          onChange={(next) => save({ ...global, enabled: next })}
        />
        <NetworkModes
          config={global}
          disabled={disabled}
          onNetwork={(network) => save({ ...global, network })}
          onSaveHosts={(allowedHosts) => save({ ...global, allowedHosts })}
        />
        <ProjectOverride
          projects={state?.projects ?? {}}
          disabled={disabled}
          onSave={saveProject}
        />
        {error ? <div className="text-danger-light text-xs">{error}</div> : null}
      </div>
    </div>
  );
}
