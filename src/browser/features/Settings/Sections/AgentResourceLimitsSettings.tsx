import React, { useEffect, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import { Input } from "@/browser/components/Input/Input";
import { useAPI, useLiveAPI } from "@/browser/contexts/API";
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

function StatusLine(props: { state: LimitsState; onRetry: () => void }) {
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
      <Button variant="outline" size="xs" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** The saved limits with their status, and the drafts of the two fields. */
function useAgentResourceLimits() {
  const { api } = useAPI();
  const liveApi = useLiveAPI();
  const [state, setState] = useState<LimitsState | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(draftsOf({}));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const request = api?.agentResourceLimits?.get();
    if (!request) {
      return;
    }
    let cancelled = false;
    request
      .then((loaded) => {
        if (cancelled) return;
        setState(loaded);
        setDrafts(draftsOf(loaded.limits));
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(`Failed to load agent resource limits: ${getErrorMessage(loadError)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const save = (limits: AgentResourceLimits) => {
    liveApi?.agentResourceLimits
      ?.set(limits)
      .then((saved) => {
        setState(saved);
        setError(null);
      })
      .catch((saveError: unknown) => {
        setError(`Failed to save agent resource limits: ${getErrorMessage(saveError)}`);
      });
  };

  return { state, drafts, setDrafts, error, setError, save };
}

/** Settings > Agents: one CPU and memory limit that all local agent processes share. */
export function AgentResourceLimitsSettings() {
  const { state, drafts, setDrafts, error, setError, save } = useAgentResourceLimits();

  const handleBlur = () => {
    if (!state) {
      return;
    }
    const parsed = parseDrafts(drafts);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (!sameLimits(parsed.limits, state.limits)) {
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
                  value={drafts[field]}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDrafts((current) => ({ ...current, [field]: event.target.value }))
                  }
                  onBlur={handleBlur}
                  disabled={state === null}
                  className="border-border-medium bg-background-secondary h-9 w-24 text-right"
                />
                <span className="text-muted w-10 text-sm">{unit}</span>
              </div>
            </div>
          );
        })}
        {state ? <StatusLine state={state} onRetry={() => save(state.limits)} /> : null}
        {error ? <div className="text-danger-light text-xs">{error}</div> : null}
      </div>
    </div>
  );
}
