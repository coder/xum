import React, { useEffect, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import { Input } from "@/browser/components/Input/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Switch } from "@/browser/components/Switch/Switch";
import { useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { CONNECTION_LOST_MESSAGE, isStreamFailure } from "@/browser/contexts/connectionLink";
import {
  AGENT_RESOURCE_LIMITS_RANGE,
  type AgentResourceLimits,
} from "@/common/config/schemas/agentResourceLimits";
import type {
  AgentResourceLimitsState,
  AgentResourceLimitsSupport,
} from "@/common/orpc/schemas/agentResourceLimits";
import { getErrorMessage } from "@/common/utils/errors";
import { getProjectDisplayName, getTopLevelProjectEntries } from "@/common/utils/subProjects";

type LimitField = keyof AgentResourceLimits;

const FIELDS: ReadonlyArray<{ field: LimitField; label: string; unit: string; step: number }> = [
  { field: "cpuCores", label: "CPU limit", unit: "cores", step: 0.5 },
  { field: "memoryGiB", label: "Memory limit", unit: "GiB", step: 1 },
];

function formatLimit(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** The value of a field, undefined when it is empty, or null when it is not a valid limit. */
function parseLimit(field: LimitField, draft: string): number | undefined | null {
  const trimmed = draft.trim();
  if (trimmed === "") {
    return undefined;
  }
  const value = Number(trimmed);
  const range = AGENT_RESOURCE_LIMITS_RANGE[field];
  return Number.isFinite(value) && value >= range.min && value <= range.max ? value : null;
}

type Drafts = Record<LimitField, string>;

function draftsOf(limits: AgentResourceLimits): Drafts {
  return { cpuCores: formatLimit(limits.cpuCores), memoryGiB: formatLimit(limits.memoryGiB) };
}

/** The limits in the drafts, or why each invalid draft is not a valid limit. */
function parseDrafts(drafts: Drafts): { limits: AgentResourceLimits } | { errors: string[] } {
  const limits: AgentResourceLimits = {};
  const errors: string[] = [];
  for (const { field, label, unit } of FIELDS) {
    const value = parseLimit(field, drafts[field]);
    if (value === null) {
      const range = AGENT_RESOURCE_LIMITS_RANGE[field];
      errors.push(
        `${label} must be from ${range.min} to ${range.max} ${unit}, or empty for no limit.`
      );
    } else if (value !== undefined) {
      limits[field] = value;
    }
  }
  return errors.length > 0 ? { errors } : { limits };
}

function sameLimits(a: AgentResourceLimits, b: AgentResourceLimits): boolean {
  return a.cpuCores === b.cpuCores && a.memoryGiB === b.memoryGiB;
}

function describeActiveLimits(limits: AgentResourceLimits): string {
  const parts: string[] = [];
  if (limits.cpuCores !== undefined) {
    parts.push(`${limits.cpuCores} CPU ${limits.cpuCores === 1 ? "core" : "cores"}`);
  }
  if (limits.memoryGiB !== undefined) {
    parts.push(`${limits.memoryGiB} GiB of memory`);
  }
  return parts.join(" and ");
}

/** The fields edit the limit that all projects share, or the limit of one project path. */
const ALL_PROJECTS = "__all__";
type LimitsScope = typeof ALL_PROJECTS | (string & {});

/** The saved limits that the fields of `scope` edit. */
function scopedLimits(state: AgentResourceLimitsState, scope: LimitsScope): AgentResourceLimits {
  return scope === ALL_PROJECTS ? state.limits : (state.projects[scope]?.limits ?? {});
}

interface LimitsView {
  /** The saved limits and their status, as the server last reported them. */
  state: AgentResourceLimitsState;
  scope: LimitsScope;
  drafts: Drafts;
}

/**
 * The view once the server reports `next`. A field takes the new saved value unless its draft
 * differs from the value saved before, so a change made elsewhere never replaces an edit in
 * progress, and the next save sends the current value of the other field.
 */
function withAppliedLimits(view: LimitsView | null, next: AgentResourceLimitsState): LimitsView {
  const scope = view?.scope ?? ALL_PROJECTS;
  const drafts = draftsOf(scopedLimits(next, scope));
  for (const { field } of FIELDS) {
    if (
      view !== null &&
      parseLimit(field, view.drafts[field]) !== scopedLimits(view.state, scope)[field]
    ) {
      drafts[field] = view.drafts[field];
    }
  }
  return { state: next, scope, drafts };
}

/** The view with the fields of `scope`, from its saved limits; edits of the old scope are dropped. */
function withScope(view: LimitsView | null, scope: LimitsScope): LimitsView | null {
  return view && { ...view, scope, drafts: draftsOf(scopedLimits(view.state, scope)) };
}

function withDraft(view: LimitsView | null, field: LimitField, draft: string): LimitsView | null {
  return view && { ...view, drafts: { ...view.drafts, [field]: draft } };
}

/** Load the limits, and again after every config change, until `signal` aborts. */
async function followAppliedLimits(
  api: APIClient,
  signal: AbortSignal,
  onLoaded: (state: AgentResourceLimitsState) => void
): Promise<void> {
  const load = async () => {
    const state = await api.agentResourceLimits.get();
    if (!signal.aborted) onLoaded(state);
  };
  // Load only once the subscription is live, so a change made during the load loads again.
  const changes = await api.config.onConfigChanged(undefined, { signal });
  await load();
  for await (const _ of changes) {
    await load();
  }
}

/** What applying the limits takes here, shown while none applies; nothing when they just apply. */
function SupportNote(props: { support: AgentResourceLimitsSupport }) {
  const { support } = props;
  if (support.state === "ready") {
    return null;
  }
  if (support.state === "sudo") {
    return (
      <div className="text-muted text-xs">
        To apply limits, Xum gives cgroup <span className="font-mono">{support.cgroup}</span> to its
        user with sudo, then moves every process in that cgroup into{" "}
        <span className="font-mono">{support.cgroup}/xum-app</span>.
      </div>
    );
  }
  return <div className="text-muted text-xs">Not available: {support.reason}</div>;
}

/** Notes that a project limit above the shared one does not raise it: the kernel applies the lower. */
function AboveSharedNote(props: { state: AgentResourceLimitsState; projectPath: string }) {
  const shared = props.state.limits;
  const project = props.state.projects[props.projectPath]?.limits ?? {};
  const notes = FIELDS.flatMap(({ field, unit }) => {
    const sharedValue = shared[field];
    const projectValue = project[field];
    return sharedValue !== undefined && projectValue !== undefined && projectValue > sharedValue
      ? [`The limit for all projects is ${sharedValue} ${unit}.`]
      : [];
  });
  if (notes.length === 0) {
    return null;
  }
  return <div className="text-warning text-xs">{notes.join(" ")} The lower limit applies.</div>;
}

/** The status of one project's own limit, while the limits are active. */
function ProjectStatusLine(props: {
  state: AgentResourceLimitsState;
  projectPath: string;
  projectName: string;
}) {
  const project = props.state.projects[props.projectPath];
  if (project?.cgroup === undefined) {
    return (
      <div className="text-muted text-xs">
        {props.projectName} has no limit of its own. Its agents share the limit of all projects.
      </div>
    );
  }
  return (
    <div className="text-muted text-xs">
      Active: agents of {props.projectName} share {describeActiveLimits(project.limits)} (cgroup{" "}
      <span className="font-mono">{project.cgroup}</span>), inside the limit of all projects.
    </div>
  );
}

function StatusLine(props: {
  state: AgentResourceLimitsState;
  disabled: boolean;
  onRetry: () => void;
  /** The project whose fields show, or null for the limit of all projects. */
  project: { path: string; name: string } | null;
}) {
  const { enabled, limits, status, support } = props.state;
  // While off, the fields still show the saved limits, so "No limit is set." would be wrong.
  if (!enabled && status.state !== "unavailable") {
    return <SupportNote support={support} />;
  }
  if (status.state === "off") {
    return (
      <>
        <div className="text-muted text-xs">No limit is set.</div>
        <SupportNote support={support} />
      </>
    );
  }
  if (status.state === "active" && props.project !== null) {
    return (
      <>
        <ProjectStatusLine
          state={props.state}
          projectPath={props.project.path}
          projectName={props.project.name}
        />
        <AboveSharedNote state={props.state} projectPath={props.project.path} />
      </>
    );
  }
  if (status.state === "active") {
    return (
      <div className="text-muted text-xs">
        {/* Only project limits are set: the projects without one have no limit. */}
        {limits.cpuCores === undefined && limits.memoryGiB === undefined
          ? "Active: only project limits apply"
          : `Active: agents share ${describeActiveLimits(limits)}`}{" "}
        (cgroup <span className="font-mono">{status.cgroup}</span>).
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-danger-light">Not applied: {status.reason}</span>
      <Button variant="outline" size="xs" disabled={props.disabled} onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * The saved limits with their status and the drafts of the two fields, following changes made
 * elsewhere. Offline the switch and the fields are disabled, since a save could not reach the
 * server.
 */
function useAgentResourceLimits() {
  const api = useLiveAPI();
  const [view, setView] = useState<LimitsView | null>(null);
  // A failed load or save. A later request that succeeds clears it.
  const [error, setError] = useState<string | null>(null);
  // Why the drafts are not valid limits. Only a blur checks them again, so a request that succeeds
  // (Try again saves the saved limits) does not hide them while a field still holds the value.
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);

  useEffect(() => {
    // API doubles in tests of other settings can omit this namespace.
    if (api?.agentResourceLimits == null) {
      return;
    }
    const controller = new AbortController();
    let loaded = false;
    followAppliedLimits(api, controller.signal, (next) => {
      // Each connection starts from the saved limits: an edit kept from before would look saved.
      const reset = !loaded;
      loaded = true;
      setView((current) => withAppliedLimits(reset ? null : current, next));
      if (reset) {
        setError(null);
        setFieldErrors([]);
      }
    }).catch((loadError: unknown) => {
      if (isStreamFailure(loadError, controller.signal)) {
        setError(`Failed to load agent resource limits: ${getErrorMessage(loadError)}`);
      }
    });
    return () => controller.abort();
  }, [api]);

  const send = (request: (client: APIClient) => Promise<AgentResourceLimitsState>) => {
    if (api == null) {
      setError(CONNECTION_LOST_MESSAGE);
      return;
    }
    request(api)
      .then((saved) => {
        setView((current) => withAppliedLimits(current, saved));
        setError(null);
      })
      .catch((saveError: unknown) => {
        setError(`Failed to save agent resource limits: ${getErrorMessage(saveError)}`);
      });
  };
  const save = (limits: AgentResourceLimits) =>
    send((client) => client.agentResourceLimits.set(limits));
  const saveProject = (projectPath: string, limits: AgentResourceLimits) =>
    send((client) => client.agentResourceLimits.setProject({ projectPath, limits }));
  // The fields of the new scope show its saved limits, so the old fields' errors no longer apply.
  const setScope = (scope: LimitsScope) => {
    setView((current) => withScope(current, scope));
    setFieldErrors([]);
  };
  // A separate request, so a save of the fields that is still on its way is not undone.
  const setEnabled = (enabled: boolean) =>
    send((client) => client.agentResourceLimits.setEnabled({ enabled }));

  const setDraft = (field: LimitField, draft: string) =>
    setView((current) => withDraft(current, field, draft));

  return {
    view,
    setDraft,
    error,
    fieldErrors,
    setFieldErrors,
    save,
    saveProject,
    setScope,
    setEnabled,
    disabled: view === null || api == null,
  };
}

/** The CPU and memory fields. They are disabled offline and while the limits are off. */
function LimitFields(props: {
  view: LimitsView | null;
  disabled: boolean;
  onDraft: (field: LimitField, draft: string) => void;
  onBlur: () => void;
}) {
  const locked = props.disabled || props.view?.state.enabled !== true;
  return FIELDS.map(({ field, label, unit, step }) => {
    const range = AGENT_RESOURCE_LIMITS_RANGE[field];
    const inputId = `agent-resource-limit-${field}`;
    return (
      <div key={field} className="flex items-center justify-between gap-4">
        <label htmlFor={inputId} className="text-foreground min-w-0 flex-1 text-sm">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            type="number"
            inputMode="decimal"
            min={range.min}
            max={range.max}
            step={step}
            placeholder="None"
            value={props.view?.drafts[field] ?? ""}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              props.onDraft(field, event.target.value)
            }
            onBlur={props.onBlur}
            disabled={locked}
            className="border-border-medium bg-background-secondary h-9 w-24 text-right"
          />
          <span className="text-muted w-10 text-sm">{unit}</span>
        </div>
      </div>
    );
  });
}

/** The title, the description and the switch of the section. */
function Header(props: {
  view: LimitsView | null;
  disabled: boolean;
  onEnabled: (enabled: boolean) => void;
}) {
  const state = props.view?.state;
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="text-foreground text-sm font-medium">Resource limits</h3>
          <DocsLink path="/config/agent-resource-limits" />
        </div>
        <div className="text-muted text-xs">
          CPU and memory that all local agent commands share, on Linux with cgroup v2. A project can
          also get its own limit inside it. Empty means no limit.
        </div>
      </div>
      <Switch
        checked={state?.enabled === true}
        onCheckedChange={props.onEnabled}
        // A switch that is on stays usable, so limits turned on elsewhere can be turned off.
        disabled={props.disabled || (state?.support.state === "unsupported" && !state.enabled)}
        aria-label="Resource limits"
      />
    </div>
  );
}

/** What leaving a field saves: the errors to show, the new limits, or null when nothing changed. */
function changedLimits(
  view: LimitsView,
  scope: LimitsScope
): { errors: string[] } | { limits: AgentResourceLimits } | null {
  const parsed = parseDrafts(view.drafts);
  if ("errors" in parsed) {
    return parsed;
  }
  return sameLimits(parsed.limits, scopedLimits(view.state, scope)) ? null : parsed;
}

/** The projects to pick from, and the picked one; null for the limit of all projects. */
function useScopedProject(view: LimitsView | null, setScope: (scope: LimitsScope) => void) {
  const { userProjects } = useProjectContext();
  // A sub-project's agents run in its parent's checkout and share the parent's limits.
  const projects = getTopLevelProjectEntries(userProjects).map(([path, config]) => ({
    path,
    name: getProjectDisplayName(path, config),
  }));
  // A project removed while Settings is open falls back to the limit of all projects.
  const project =
    view && view.scope !== ALL_PROJECTS
      ? (projects.find((candidate) => candidate.path === view.scope) ?? null)
      : null;
  const scope: LimitsScope = project?.path ?? ALL_PROJECTS;
  // A removed project leaves its drafts behind, and the next blur would save them as the limit of
  // all projects. Adjust the state during render, so no blur and no frame sees the stale drafts.
  if (view !== null && view.scope !== scope) {
    setScope(scope);
  }
  return { projects, project, scope };
}

/** Picks whether the fields edit the limit of all projects or the limit of one project. */
function ScopePicker(props: {
  scope: LimitsScope;
  projects: ReadonlyArray<{ path: string; name: string }>;
  disabled: boolean;
  onScope: (scope: LimitsScope) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="text-foreground min-w-0 flex-1 text-sm">Project</div>
      <Select value={props.scope} onValueChange={props.onScope} disabled={props.disabled}>
        <SelectTrigger
          className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors"
          aria-label="Resource limits project"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
          {props.projects.map((project) => (
            <SelectItem key={project.path} value={project.path}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Settings > Agents: the CPU and memory limit that all local agent processes share, and the limit
 * of single projects inside it.
 */
export function AgentResourceLimitsSettings() {
  const {
    view,
    setDraft,
    error,
    fieldErrors,
    setFieldErrors,
    save,
    saveProject,
    setScope,
    setEnabled,
    disabled,
  } = useAgentResourceLimits();
  const { projects, project, scope } = useScopedProject(view, setScope);

  const handleBlur = () => {
    const change = view && changedLimits(view, scope);
    if (change != null && "errors" in change) {
      setFieldErrors(change.errors);
      return;
    }
    setFieldErrors([]);
    if (change == null) {
      return;
    }
    if (project === null) save(change.limits);
    else saveProject(project.path, change.limits);
  };

  return (
    <div>
      <Header view={view} disabled={disabled} onEnabled={setEnabled} />
      <div className="space-y-4">
        {projects.length > 0 ? (
          <ScopePicker scope={scope} projects={projects} disabled={disabled} onScope={setScope} />
        ) : null}
        <LimitFields view={view} disabled={disabled} onDraft={setDraft} onBlur={handleBlur} />
        {view ? (
          <StatusLine
            state={view.state}
            disabled={disabled}
            // Saving the shared limit again re-applies every limit, the project limits too.
            onRetry={() => save(view.state.limits)}
            project={project}
          />
        ) : null}
        {fieldErrors.map((fieldError) => (
          <div key={fieldError} className="text-danger-light text-xs">
            {fieldError}
          </div>
        ))}
        {error ? <div className="text-danger-light text-xs">{error}</div> : null}
      </div>
    </div>
  );
}
