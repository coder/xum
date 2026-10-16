import React, { useEffect, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import { Input } from "@/browser/components/Input/Input";
import { useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { CONNECTION_LOST_MESSAGE, isStreamFailure } from "@/browser/contexts/connectionLink";
import {
  AGENT_RESOURCE_LIMITS_RANGE,
  type AgentResourceLimits,
} from "@/common/config/schemas/agentResourceLimits";
import type { AgentResourceLimitsStatus } from "@/common/orpc/schemas/agentResourceLimits";
import { getErrorMessage } from "@/common/utils/errors";

interface LimitsState {
  limits: AgentResourceLimits;
  status: AgentResourceLimitsStatus;
}

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

/** The limits in the drafts, or why one draft is not a valid limit. */
function parseDrafts(drafts: Drafts): { limits: AgentResourceLimits } | { error: string } {
  const limits: AgentResourceLimits = {};
  for (const { field, label, unit } of FIELDS) {
    const value = parseLimit(field, drafts[field]);
    if (value === null) {
      const range = AGENT_RESOURCE_LIMITS_RANGE[field];
      return {
        error: `${label} must be from ${range.min} to ${range.max} ${unit}, or empty for no limit.`,
      };
    }
    if (value !== undefined) {
      limits[field] = value;
    }
  }
  return { limits };
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

interface LimitsView {
  /** The saved limits and their status, as the server last reported them. */
  state: LimitsState;
  drafts: Drafts;
}

/**
 * The view once the server reports `next`. A field takes the new saved value unless its draft
 * differs from the value saved before, so a change made elsewhere never replaces an edit in
 * progress, and the next save sends the current value of the other field.
 */
function withAppliedLimits(view: LimitsView | null, next: LimitsState): LimitsView {
  const drafts = draftsOf(next.limits);
  for (const { field } of FIELDS) {
    if (view !== null && parseLimit(field, view.drafts[field]) !== view.state.limits[field]) {
      drafts[field] = view.drafts[field];
    }
  }
  return { state: next, drafts };
}

function withDraft(view: LimitsView | null, field: LimitField, draft: string): LimitsView | null {
  return view && { ...view, drafts: { ...view.drafts, [field]: draft } };
}

/** Load the limits, and again after every config change, until `signal` aborts. */
async function followAppliedLimits(
  api: APIClient,
  signal: AbortSignal,
  onLoaded: (state: LimitsState) => void
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

function StatusLine(props: { state: LimitsState; disabled: boolean; onRetry: () => void }) {
  const { limits, status } = props.state;
  if (status.state === "off") {
    return <div className="text-muted text-xs">No limit is set.</div>;
  }
  if (status.state === "active") {
    return (
      <div className="text-muted text-xs">
        Active: agents share {describeActiveLimits(limits)} (cgroup{" "}
        <span className="font-mono">{status.cgroup}</span>).
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
 * elsewhere. Offline the fields are disabled, since a save could not reach the server.
 */
function useAgentResourceLimits() {
  const liveApi = useLiveAPI();
  const [view, setView] = useState<LimitsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // API doubles in tests of other settings can omit this namespace.
    if (liveApi?.agentResourceLimits == null) {
      return;
    }
    const controller = new AbortController();
    let loaded = false;
    followAppliedLimits(liveApi, controller.signal, (next) => {
      // Each connection starts from the saved limits: an edit kept from before would look saved.
      const reset = !loaded;
      loaded = true;
      setView((current) => withAppliedLimits(reset ? null : current, next));
      if (reset) setError(null);
    }).catch((loadError: unknown) => {
      if (isStreamFailure(loadError, controller.signal)) {
        setError(`Failed to load agent resource limits: ${getErrorMessage(loadError)}`);
      }
    });
    return () => controller.abort();
  }, [liveApi]);

  const save = (limits: AgentResourceLimits) => {
    if (liveApi == null) {
      setError(CONNECTION_LOST_MESSAGE);
      return;
    }
    liveApi.agentResourceLimits
      .set(limits)
      .then((saved) => {
        setView((current) => withAppliedLimits(current, saved));
        setError(null);
      })
      .catch((saveError: unknown) => {
        setError(`Failed to save agent resource limits: ${getErrorMessage(saveError)}`);
      });
  };

  const setDraft = (field: LimitField, draft: string) =>
    setView((current) => withDraft(current, field, draft));

  return { view, setDraft, error, setError, save, disabled: view === null || liveApi == null };
}

/** Settings > Agents: one CPU and memory limit that all local agent processes share. */
export function AgentResourceLimitsSettings() {
  const { view, setDraft, error, setError, save, disabled } = useAgentResourceLimits();

  const handleBlur = () => {
    if (!view) {
      return;
    }
    const parsed = parseDrafts(view.drafts);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (!sameLimits(parsed.limits, view.state.limits)) {
      save(parsed.limits);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-foreground text-sm font-medium">Resource limits</h3>
        <DocsLink path="/config/agent-resource-limits" />
      </div>
      <div className="text-muted mb-4 text-xs">
        CPU and memory that all local agent commands share, on Linux with cgroup v2. Empty means no
        limit.
      </div>
      <div className="space-y-4">
        {FIELDS.map(({ field, label, unit, step }) => {
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
                  value={view?.drafts[field] ?? ""}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDraft(field, event.target.value)
                  }
                  onBlur={handleBlur}
                  disabled={disabled}
                  className="border-border-medium bg-background-secondary h-9 w-24 text-right"
                />
                <span className="text-muted w-10 text-sm">{unit}</span>
              </div>
            </div>
          );
        })}
        {view ? (
          <StatusLine
            state={view.state}
            disabled={disabled}
            onRetry={() => save(view.state.limits)}
          />
        ) : null}
        {error ? <div className="text-danger-light text-xs">{error}</div> : null}
      </div>
    </div>
  );
}
