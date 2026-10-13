import { ChevronDown, Target } from "lucide-react";
import React from "react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/browser/components/Input/Input";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import { GoalDefaultsControls } from "@/browser/features/Settings/Sections/GoalsSection";
import { cn } from "@/common/lib/utils";
import type { WorkspaceGoalDefaultsOverride } from "@/browser/utils/goals/resolveGoalSetIntent";
import { mergeGoalDefaults } from "@/browser/utils/goals/resolveGoalSetIntent";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";

/**
 * Editor for goal-creation defaults. Lives inside `GoalDefaultsModal`
 * (the primary surface — opened from "Change defaults" affordances in the
 * GoalTab), or standalone as a long-lived embedded panel.
 *
 * Two stacked panels:
 *
 *   1. **This workspace** — sparse override. Each of the three knobs
 *      (budget / turn cap / always-require-explicit-budget) has an
 *      "Inherit" vs "Override" toggle. Inherit shows the effective value
 *      (from the global panel below) in muted text. Override reveals an
 *      input so the user can pin a workspace-specific value.
 *
 *   2. **All workspaces** — the canonical global editor (`GoalDefaultsControls`
 *      reused from Settings). Persists into `appConfig.goalDefaults` and
 *      acts as the inherit-fallback for workspaces that don't override.
 *
 * When `embedded === false` (the default), the section wraps itself in a
 * collapsible `<details>` so it is unobtrusive on long-running tabs. When
 * embedded inside the modal, the wrapper collapses since the modal itself
 * is already the open/closed envelope.
 */
interface GoalDefaultsSectionProps {
  workspaceId: string;
  /**
   * Hide the outer collapsible `<details>` wrapper. Used by
   * `GoalDefaultsModal` where the Dialog is the open/closed envelope.
   */
  embedded?: boolean;
  /**
   * Notified whenever either the workspace override or the global defaults
   * persist. Lets parent forms re-read effective defaults so pre-filled
   * Budget / Turn cap inputs stay in sync after the user changes anything.
   */
  onPersist?: () => void;
}

function formatBudgetDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseBudgetDollars(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) {
    return null;
  }
  return Math.round(Number(normalized) * 100);
}

function parseTurnCapValue(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface GoalOverrideWrite {
  workspaceId: string;
  override: WorkspaceGoalDefaultsOverride;
  onSaved: (() => void) | undefined;
}

/**
 * Serializes workspace-default writes. The backend setter reads → mutates → writes the full
 * config record, so two writes in flight could land out of order — a slower first request could
 * complete after a later edit and overwrite it on disk while the UI continues to show the latest
 * optimistic state, silently reverting the user's edit on next refetch. Each write waits for the
 * previous one.
 *
 * The controls stay editable while Xum reconnects. A write that no client received (made without
 * a client, or cut off by the lost connection) is kept until `sendUnsent` hands it to the next
 * client. Otherwise the edit would look saved but never reach the backend.
 */
class GoalOverrideWriter {
  private chain: Promise<void> = Promise.resolve();
  private latest: WorkspaceGoalDefaultsOverride | null = null;
  private unsent: GoalOverrideWrite | null = null;
  private readonly writesByWorkspace = new Map<string, number>();

  /**
   * How many writes this workspace has had. A read that began before a write must not show its
   * (older) answer over the written value.
   */
  writeCount(workspaceId: string): number {
    return this.writesByWorkspace.get(workspaceId) ?? 0;
  }

  write(api: APIClient | null, edit: GoalOverrideWrite): void {
    this.writesByWorkspace.set(edit.workspaceId, this.writeCount(edit.workspaceId) + 1);
    this.latest = edit.override;
    if (api == null) {
      this.unsent = edit;
      return;
    }
    this.unsent = null;
    this.chain = this.chain.then(() =>
      api.workspace.goalDefaults
        .set({
          workspaceId: edit.workspaceId,
          defaultBudgetCents: edit.override.defaultBudgetCents,
          defaultTurnCap: edit.override.defaultTurnCap,
          alwaysRequireExplicitBudget: edit.override.alwaysRequireExplicitBudget,
        })
        .then(() => {
          // Notify parent so prefilled create-form inputs can re-read the effective defaults.
          edit.onSaved?.();
        })
        .catch((error: unknown) => {
          // Other errors are swallowed (the optimistic edit already updated local state), as
          // in the global panel. A newer edit replaces a lost one.
          if (isAbortError(error) && this.latest === edit.override) {
            this.unsent = edit;
          }
        })
    );
  }

  /** Sends the write the last client did not get to `api`. */
  sendUnsent(api: APIClient): void {
    if (this.unsent != null) {
      this.write(api, this.unsent);
    }
  }
}

/**
 * The workspace's stored override, read once per workspace. The panel edits it optimistically
 * through `edit`, which also writes it.
 */
function useWorkspaceGoalOverride(workspaceId: string, onPersist: (() => void) | undefined) {
  const { api } = useAPI();
  const [override, setOverride] = useState<WorkspaceGoalDefaultsOverride | null>(null);
  // Distinguishes "loaded; no override stored" (override === null, isLoading
  // === false) from "still loading" (override === null, isLoading === true).
  // Without this flag, a user toggling a field before the read resolves
  // would call persistOverride() against the synthesized all-null shape,
  // which `set` then writes — clobbering any saved override on disk.
  // Preserve saved workspace defaults while loading.
  const [isLoading, setIsLoading] = useState(true);
  // The workspace whose override is loaded. A re-read for it (a new API client after a reconnect)
  // keeps the controls shown and enabled; only another workspace resets them.
  const loadedWorkspaceIdRef = useRef<string | null>(null);
  // Also counts the user's edits, so an edit made while a re-read is in flight wins over its result.
  const [writer] = useState(() => new GoalOverrideWriter());

  // Workspace override is loaded once per workspaceId. `null` (the
  // canonical "no override" state) is what we expect for fresh workspaces.
  // Reset `isLoading` whenever the workspaceId changes so a workspace
  // switch doesn't let the new workspace's edits race the old read.
  useEffect(() => {
    if (loadedWorkspaceIdRef.current !== workspaceId) {
      loadedWorkspaceIdRef.current = null;
      setOverride(null);
      setIsLoading(true);
    }
    if (!api) return;
    let cancelled = false;
    const writesAtStart = writer.writeCount(workspaceId);
    // An edit the last client did not get goes to this one first. It counts as a write after the
    // read began, so the read's answer (maybe still the older stored value) does not show over it.
    writer.sendUnsent(api);
    void api.workspace.goalDefaults
      .get({ workspaceId })
      .then((value) => {
        if (cancelled) return;
        if (writer.writeCount(workspaceId) === writesAtStart) {
          setOverride(value ?? null);
        }
        setIsLoading(false);
        loadedWorkspaceIdRef.current = workspaceId;
      })
      .catch((error: unknown) => {
        // A lost connection keeps what is shown for the next client. Another failure enables
        // the controls on what is shown (the empty override on a first read), as before.
        if (cancelled || isAbortError(error)) return;
        setIsLoading(false);
        loadedWorkspaceIdRef.current = workspaceId;
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, writer]);

  const edit = (next: WorkspaceGoalDefaultsOverride) => {
    setOverride(next);
    writer.write(api, { workspaceId, override: next, onSaved: onPersist });
  };

  return { override, isLoading, edit };
}

export function GoalDefaultsSection(props: GoalDefaultsSectionProps) {
  const { api } = useAPI();
  const [globalDefaults, setGlobalDefaults] = useState<GoalDefaults>(() => ({
    ...DEFAULT_GOAL_DEFAULTS,
  }));
  const onPersistProp = props.onPersist;
  const { override, isLoading, edit } = useWorkspaceGoalOverride(props.workspaceId, onPersistProp);

  // Pull the global defaults so we can render inherited values inside the
  // workspace-override panel. We only re-read on mount/api change; updates
  // from the wrapped `GoalDefaultsControls` are pushed in via its
  // `onPersist(next)` callback so we don't have to re-query the backend
  // Re-reading after an unawaited `updateGoalDefaults` could
  // race the underlying saveConfig and show stale inherited labels).
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.config
      .getConfig()
      .then((config) => {
        if (cancelled) return;
        setGlobalDefaults(normalizeGoalDefaults(config?.goalDefaults));
      })
      .catch(() => {
        // Defaults already initialized; keep going so the override panel
        // remains editable even if the config read fails transiently.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const persistOverride = (next: WorkspaceGoalDefaultsOverride) => {
    // Ignore edits while the initial read is in flight.
    // Otherwise a stale all-null shape could overwrite saved overrides.
    // The UI also disables the toggles via `isLoading` below.
    if (isLoading) return;
    edit(next);
  };

  // Synthesize a "current override" object (all-null is what the
  // workspaceService stores for "no override at all") so the per-field
  // toggles below have a stable shape to work against.
  const currentOverride: WorkspaceGoalDefaultsOverride = override ?? {
    defaultBudgetCents: null,
    defaultTurnCap: null,
    alwaysRequireExplicitBudget: null,
  };

  // Effective defaults this workspace would actually use right now (for the
  // small "current effective values" summary at the top of the section).
  const effective = mergeGoalDefaults(globalDefaults, override);
  const hasAnyOverride =
    currentOverride.defaultBudgetCents != null ||
    currentOverride.defaultTurnCap != null ||
    currentOverride.alwaysRequireExplicitBudget != null;

  const body = (
    <div className="flex flex-col gap-4">
      <WorkspaceOverridePanel
        override={currentOverride}
        globalDefaults={globalDefaults}
        onChange={persistOverride}
        isLoading={isLoading}
      />

      <details className="border-border-light rounded-md border">
        <summary className="text-muted cursor-pointer list-none p-2 text-xs font-medium uppercase">
          All workspaces (global default)
        </summary>
        <div className="bg-surface-primary border-border-light border-t p-3">
          <GoalDefaultsControls
            // Push the freshly-normalized global defaults straight into
            // our local `globalDefaults` state so the inherited-value
            // labels in the workspace override panel are always in
            // sync. We avoid re-querying the config because the wrapped
            // `updateGoalDefaults` write is async and a refetch can
            // race it.
            onPersist={(next) => {
              setGlobalDefaults(next);
              onPersistProp?.();
            }}
          />
        </div>
      </details>
    </div>
  );

  if (props.embedded === true) {
    // Modal mode: skip the outer summary header — the Dialog title already
    // owns the affordance — and render the body straight into the modal
    // body.
    return body;
  }

  return (
    <details
      className="border-border-light bg-surface-secondary group rounded-md border"
      // Defaults to closed so the section is unobtrusive while the user is
      // looking at the current goal; one click away when needed.
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-sm">
        <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
          <Target className="h-3.5 w-3.5" aria-hidden="true" />
          Goal defaults
          {hasAnyOverride && (
            <span
              className="bg-accent-soft text-accent rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase"
              aria-label="Workspace overrides active"
            >
              Workspace
            </span>
          )}
        </span>
        <span className="text-muted inline-flex items-center gap-2 text-xs">
          <span className="tabular-nums">
            ${formatBudgetDollars(effective.defaultBudgetCents)}
            {" • "}
            {effective.defaultTurnCap == null ? "no turn cap" : `${effective.defaultTurnCap} turns`}
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>

      <div className="border-border-light border-t p-3">{body}</div>
    </details>
  );
}

interface WorkspaceOverridePanelProps {
  override: WorkspaceGoalDefaultsOverride;
  globalDefaults: GoalDefaults;
  onChange: (next: WorkspaceGoalDefaultsOverride) => void;
  isLoading: boolean;
}

function WorkspaceOverridePanel(props: WorkspaceOverridePanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-foreground flex items-center gap-2 text-xs font-medium uppercase">
        This workspace
        {props.isLoading && (
          <span className="text-muted text-[10px] font-normal normal-case" aria-live="polite">
            Loading…
          </span>
        )}
      </div>

      <BudgetOverrideRow
        override={props.override.defaultBudgetCents}
        inheritValue={props.globalDefaults.defaultBudgetCents}
        onChange={(value) => props.onChange({ ...props.override, defaultBudgetCents: value })}
        disabled={props.isLoading}
      />

      <TurnCapOverrideRow
        override={props.override.defaultTurnCap}
        inheritValue={props.globalDefaults.defaultTurnCap}
        onChange={(value) => props.onChange({ ...props.override, defaultTurnCap: value })}
        disabled={props.isLoading}
      />

      <ExplicitBudgetOverrideRow
        override={props.override.alwaysRequireExplicitBudget}
        inheritValue={props.globalDefaults.alwaysRequireExplicitBudget}
        onChange={(value) =>
          props.onChange({ ...props.override, alwaysRequireExplicitBudget: value })
        }
        disabled={props.isLoading}
      />
    </div>
  );
}

interface BudgetOverrideRowProps {
  override: number | null;
  inheritValue: number;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}

function BudgetOverrideRow(props: BudgetOverrideRowProps) {
  const isOverriding = props.override != null;
  const [draft, setDraft] = useState(isOverriding ? formatBudgetDollars(props.override ?? 0) : "");

  // Keep the draft in sync when the override changes from outside (e.g.,
  // toggling the inherit/override switch resets the input).
  useEffect(() => {
    if (props.override != null) {
      setDraft(formatBudgetDollars(props.override));
    }
  }, [props.override]);

  const commit = (value: string) => {
    const parsed = parseBudgetDollars(value);
    if (parsed == null) {
      // Reject malformed value silently — revert the draft to the prior
      // override (or the inherited value if not currently overriding).
      setDraft(isOverriding ? formatBudgetDollars(props.override ?? 0) : "");
      return;
    }
    setDraft(formatBudgetDollars(parsed));
    props.onChange(parsed);
  };

  return (
    <OverrideRow
      label="Default budget"
      helperInherit={`Inherits $${formatBudgetDollars(props.inheritValue)} from All workspaces`}
      isOverriding={isOverriding}
      onToggleOverride={(next) => {
        if (next) {
          props.onChange(props.inheritValue);
        } else {
          props.onChange(null);
        }
      }}
      disabled={props.disabled}
      input={
        <div className="flex items-center gap-1">
          <span className="text-muted text-sm">$</span>
          <Input
            aria-label="Workspace default goal budget in dollars"
            type="text"
            inputMode="decimal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.currentTarget.value)}
            className="border-border-medium bg-background-secondary h-8 w-20 text-right text-sm"
          />
        </div>
      }
    />
  );
}

interface TurnCapOverrideRowProps {
  override: number | null;
  inheritValue: number | null;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}

function TurnCapOverrideRow(props: TurnCapOverrideRowProps) {
  // The override is tri-state from the user's perspective but the schema
  // we send is binary (`null` = inherit, positive integer = override).
  // We track an explicit "is overriding" UI flag locally so the user can
  // pick "Override → no cap" by toggling the override on while leaving
  // the input blank — which on commit stays as `null` AND keeps the
  // toggle on (handled below).
  const [isOverriding, setIsOverriding] = useState(props.override != null);
  const [draft, setDraft] = useState(props.override != null ? String(props.override) : "");

  useEffect(() => {
    setIsOverriding(props.override != null);
    setDraft(props.override != null ? String(props.override) : "");
  }, [props.override]);

  const commit = (value: string) => {
    const parsed = parseTurnCapValue(value);
    setDraft(parsed == null ? "" : String(parsed));
    // We don't allow "override on with null input" to round-trip — when
    // the input clears, we drop back to inherit. Users who want "no cap"
    // for this workspace specifically should set the global default to
    // null instead (and we surface that effective value in the inherit
    // label so they can see what they'd be inheriting).
    if (parsed == null) {
      setIsOverriding(false);
      props.onChange(null);
    } else {
      props.onChange(parsed);
    }
  };

  return (
    <OverrideRow
      label="Default turn cap"
      helperInherit={
        props.inheritValue == null
          ? "Inherits no turn cap from All workspaces"
          : `Inherits ${props.inheritValue} turns from All workspaces`
      }
      isOverriding={isOverriding}
      onToggleOverride={(next) => {
        setIsOverriding(next);
        if (next) {
          // Toggle-on without a global default starts the input blank;
          // committing a blank value will toggle back off (above).
          if (props.inheritValue != null) {
            props.onChange(props.inheritValue);
          }
        } else {
          props.onChange(null);
        }
      }}
      disabled={props.disabled}
      input={
        <Input
          aria-label="Workspace default goal turn cap"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.currentTarget.value)}
          className="border-border-medium bg-background-secondary h-8 w-20 text-right text-sm"
        />
      }
    />
  );
}

interface ExplicitBudgetOverrideRowProps {
  override: boolean | null;
  inheritValue: boolean;
  onChange: (next: boolean | null) => void;
  disabled?: boolean;
}

function ExplicitBudgetOverrideRow(props: ExplicitBudgetOverrideRowProps) {
  const isOverriding = props.override != null;
  return (
    <OverrideRow
      label="Always require explicit budget"
      helperInherit={`Inherits ${props.inheritValue ? "ON" : "OFF"} from All workspaces`}
      isOverriding={isOverriding}
      onToggleOverride={(next) => {
        if (next) {
          props.onChange(props.inheritValue);
        } else {
          props.onChange(null);
        }
      }}
      disabled={props.disabled}
      input={
        <label className="text-foreground inline-flex items-center gap-1.5 text-sm">
          <input
            aria-label="Workspace always-require-explicit-budget"
            type="checkbox"
            checked={props.override ?? false}
            onChange={(event) => props.onChange(event.target.checked)}
            className="accent-accent h-4 w-4"
          />
          <span className="text-muted text-xs">{(props.override ?? false) ? "ON" : "OFF"}</span>
        </label>
      }
    />
  );
}

interface OverrideRowProps {
  label: string;
  helperInherit: string;
  isOverriding: boolean;
  onToggleOverride: (next: boolean) => void;
  input: React.ReactNode;
  disabled?: boolean;
}

function OverrideRow(props: OverrideRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        props.disabled === true && "pointer-events-none opacity-60"
      )}
      aria-busy={props.disabled === true}
    >
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-medium">{props.label}</div>
        <div className="text-muted mt-0.5 text-xs">
          {props.isOverriding ? "Using a workspace-specific value." : props.helperInherit}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => props.onToggleOverride(!props.isOverriding)}
          className={cn(
            "border-border-medium rounded-md border px-2 py-1 text-xs",
            props.isOverriding
              ? "bg-accent-soft text-accent border-accent"
              : "bg-surface-primary text-muted hover:text-foreground"
          )}
          aria-pressed={props.isOverriding}
          aria-label={
            props.isOverriding ? `Stop overriding ${props.label}` : `Override ${props.label}`
          }
          disabled={props.disabled === true}
        >
          {props.isOverriding ? "Override" : "Inherit"}
        </button>
        {props.isOverriding && props.input}
      </div>
    </div>
  );
}
