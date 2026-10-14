import {
  type DragEndEvent,
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Inbox,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";

import { useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { ConnectionLostError } from "@/browser/contexts/connectionLink";
import { useGoalDefaults } from "@/browser/utils/goals/useGoalDefaults";
import { loadGoalDefaults, resolveGoalSetIntent } from "@/browser/utils/goals/resolveGoalSetIntent";
import { cn } from "@/common/lib/utils";
import { GOAL_OBJECTIVE_PLACEHOLDER } from "@/constants/goals";
import type { GoalBoardEntry, GoalBoardSnapshot, GoalRecordV1 } from "@/common/types/goal";
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
import {
  parseGoalBudgetInputCents,
  parseGoalTurnCapInput,
} from "@/common/utils/goals/budgetParser";

/**
 * Renderer for the three non-active board sections (upcoming, completed,
 * archived). The active goal is already rendered above by `GoalTab` —
 * this component slots in beneath it.
 *
 * Sections are independently collapsible. Upcoming defaults to open
 * (it's the user's roadmap), completed + archived default to closed
 * (out of the way until explicitly opened). Each row has compact ops:
 *
 *   upcoming → drag handle (reorder) / Edit (inline) / Promote / Remove
 *   completed → Archive
 *   archived → Revive (back to upcoming)
 *
 * Reordering uses `@dnd-kit/sortable` (same pattern as the Settings →
 * Providers route-priority list). The grip handle is a separate button
 * so clicking the row content doesn't fire a drag; `PointerSensor`'s
 * `distance: 6` activation keeps normal clicks intact.
 */
/**
 * The live client for a board change. While Xum reconnects the board stays on screen, so a click
 * must not silently do nothing (or close an editor as if it saved): without a live client this
 * throws, and each handler shows the error like any failed change.
 */
function liveClientFor(api: APIClient | null): APIClient {
  if (api == null) {
    throw new ConnectionLostError();
  }
  return api;
}

interface GoalBoardSectionsProps {
  workspaceId: string;
  board: GoalBoardSnapshot;
  /** Called after a mutation so the parent re-reads board state. */
  onMutated: () => void;
}

export function GoalBoardSections(props: GoalBoardSectionsProps) {
  const upcoming = props.board.entries.filter((e) => e.section === "upcoming");
  const completed = props.board.entries.filter((e) => e.section === "complete");
  const archived = props.board.entries.filter((e) => e.section === "archived");

  // Nothing to show? Don't render the chrome at all — keeps the tab
  // visually quiet when the workspace is using only the active goal.
  if (upcoming.length === 0 && completed.length === 0 && archived.length === 0) {
    return <UpcomingAdder workspaceId={props.workspaceId} onAdded={props.onMutated} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <UpcomingSection
        workspaceId={props.workspaceId}
        entries={upcoming}
        onMutated={props.onMutated}
      />
      <CompletedSection
        workspaceId={props.workspaceId}
        entries={completed}
        onMutated={props.onMutated}
      />
      <ArchivedSection
        workspaceId={props.workspaceId}
        entries={archived}
        onMutated={props.onMutated}
      />
    </div>
  );
}

interface SectionShellProps {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}

function SectionShell(props: SectionShellProps) {
  const [isOpen, setIsOpen] = useState(props.defaultOpen);
  const offline = useLiveAPI() == null;
  return (
    <section className="border-border-light bg-surface-secondary rounded-md border">
      <button
        type="button"
        className="hover:bg-surface-tertiary flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs tracking-wide uppercase"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        {isOpen ? (
          <ChevronDown className="text-muted h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="text-muted h-3 w-3" aria-hidden="true" />
        )}
        <span className="text-foreground font-medium">{props.title}</span>
        <span className="text-muted lowercase">({props.count})</span>
        {props.trailing && <span className="ml-auto">{props.trailing}</span>}
      </button>
      {/* Offline the board stays on screen read-only: its actions are server changes. The header
          above still opens and closes the section. */}
      {isOpen && (
        <fieldset disabled={offline} className="border-border-light min-w-0 border-t p-2">
          {props.children}
        </fieldset>
      )}
    </section>
  );
}

/**
 * Bordered chip-style button for per-row actions (Edit / Promote / Remove /
 * Archive / Revive). Matches the visual weight of the Cancel / Queue-goal
 * controls below so each row reads as a real button row, not a strip of
 * text links — and so the affordance is obvious on first glance without
 * relying on hover state. Tone tints the hover color/background:
 *   • neutral     — Edit / Archive / Revive (Inbox-style moves)
 *   • positive    — Promote (upcoming → active)
 *   • destructive — Remove (drops the goal from the board)
 *
 * Exported so the active-goal card in `GoalTab.tsx` can render the
 * "Archive this goal" / "Clear goal" affordance with the same chip
 * styling (the de-emphasized text-link variant was visually inconsistent
 * with every other Archive control on the same surface).
 */
export type RowActionTone = "neutral" | "positive" | "destructive";

export interface RowActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: RowActionTone;
}

const ROW_ACTION_TONE_CLASS: Record<RowActionTone, string> = {
  neutral: "text-muted hover:text-foreground hover:bg-surface-tertiary",
  positive: "text-muted hover:text-success hover:bg-success/10 hover:border-success/40",
  destructive:
    "text-muted hover:text-danger-soft hover:bg-danger-soft/10 hover:border-danger-soft/40",
};

export function RowActionButton(props: RowActionButtonProps) {
  const { tone = "neutral", className, type, ...rest } = props;
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "border-border-light inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
        ROW_ACTION_TONE_CLASS[tone],
        className
      )}
      {...rest}
    />
  );
}

interface UpcomingSectionProps {
  workspaceId: string;
  entries: GoalBoardEntry[];
  onMutated: () => void;
}

function UpcomingSection(props: UpcomingSectionProps) {
  const api = useLiveAPI();
  // Surfaces any backend rejection so users see why a click had no
  // effect. Cleared on next mutation. Backend errors arrive with the
  // server-side `error.message` intact via `ORPCError("BAD_REQUEST")`
  // (router translates `WorkspaceGoalTransitionError`), so this branch
  // shows the real reason instead of the generic "Internal server
  // error" the renderer used to receive.
  const [error, setError] = useState<string | null>(null);
  const clearError = () => setError(null);
  const reportError = (caught: unknown, fallback: string) => {
    setError(caught instanceof Error && caught.message ? caught.message : fallback);
  };

  const sensors = useSensors(
    // distance:6 keeps clicks on the row's action buttons (Promote /
    // Edit / Remove) firing instead of being captured as a drag start.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = props.entries.map((e) => e.goal.goalId);
    const fromIndex = ids.indexOf(String(active.id));
    const toIndex = ids.indexOf(String(over.id));
    if (fromIndex === -1 || toIndex === -1) return;
    const next = arrayMove(ids, fromIndex, toIndex);
    try {
      await liveClientFor(api).workspace.reorderUpcomingGoals({
        workspaceId: props.workspaceId,
        upcomingIds: next,
      });
      clearError();
      props.onMutated();
    } catch (caught) {
      reportError(caught, "Failed to reorder goals.");
    }
  };

  const promote = async (goalId: string) => {
    try {
      await liveClientFor(api).workspace.promoteUpcomingGoal({
        workspaceId: props.workspaceId,
        goalId,
      });
      clearError();
      props.onMutated();
    } catch (caught) {
      reportError(caught, "Failed to promote goal.");
    }
  };

  const archive = async (goalId: string) => {
    try {
      await liveClientFor(api).workspace.archiveGoal({ workspaceId: props.workspaceId, goalId });
      clearError();
      props.onMutated();
    } catch (caught) {
      reportError(caught, "Failed to remove goal.");
    }
  };

  const update = async (goalId: string, patch: UpcomingGoalPatch) => {
    try {
      await liveClientFor(api).workspace.updateUpcomingGoal({
        workspaceId: props.workspaceId,
        goalId,
        objective: patch.objective,
        budgetCents: patch.budgetCents,
        turnCap: patch.turnCap,
      });
      clearError();
      props.onMutated();
    } catch (caught) {
      reportError(caught, "Failed to update goal.");
      // Rethrow so the editor knows to stay open on validation errors.
      throw caught;
    }
  };

  const ids = props.entries.map((e) => e.goal.goalId);

  return (
    <SectionShell title="Upcoming" count={props.entries.length} defaultOpen>
      <div className="flex flex-col gap-1.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => void handleDragEnd(event)}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {props.entries.map((entry) => (
              <UpcomingRow
                key={entry.goal.goalId}
                goal={entry.goal}
                onPromote={() => promote(entry.goal.goalId)}
                onArchive={() => archive(entry.goal.goalId)}
                onSave={(patch) => update(entry.goal.goalId, patch)}
              />
            ))}
          </SortableContext>
        </DndContext>
        {error && (
          <p className="text-danger-soft text-xs" role="alert">
            {error}
          </p>
        )}
        <UpcomingAdder workspaceId={props.workspaceId} onAdded={props.onMutated} />
      </div>
    </SectionShell>
  );
}

interface UpcomingGoalPatch {
  objective?: string;
  budgetCents?: number | null;
  turnCap?: number | null;
}

interface UpcomingRowProps {
  goal: GoalRecordV1;
  onPromote: () => Promise<void> | void;
  onArchive: () => Promise<void> | void;
  onSave: (patch: UpcomingGoalPatch) => Promise<void>;
}

function UpcomingRow(props: UpcomingRowProps) {
  const offline = useLiveAPI() == null;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.goal.goalId,
    // A reorder is a server change: no drag while offline (the section's fieldset disables the
    // buttons, not dnd-kit's pointer listeners).
    disabled: offline,
  });
  const [isEditing, setIsEditing] = useState(false);
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  if (isEditing) {
    return (
      <div ref={setNodeRef} style={style}>
        <UpcomingRowEditor
          goal={props.goal}
          onCancel={() => setIsEditing(false)}
          onSubmit={async (patch) => {
            try {
              await props.onSave(patch);
              setIsEditing(false);
            } catch {
              // Surface stays handled by the parent error banner; keep
              // the editor open so the user can correct the input.
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border-border-light bg-surface-primary flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
    >
      <button
        type="button"
        // Drag handle: keeps the rest of the row clickable. The button
        // semantics (vs a bare div) preserve keyboard focus and screen-
        // reader access; `aria-describedby` is unnecessary because the
        // row contents are already announced before the handle.
        className="text-muted hover:text-foreground cursor-grab rounded p-0.5 active:cursor-grabbing"
        aria-label={`Reorder ${props.goal.objective}`}
        {...attributes}
        {...(listeners ?? {})}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span className="text-foreground line-clamp-1 flex-1 font-medium">
        {props.goal.objective}
      </span>
      <span className="text-muted counter-nums shrink-0 text-xs">
        {props.goal.budgetCents == null ? "no budget" : formatGoalCents(props.goal.budgetCents)}
      </span>
      <div className="flex items-center gap-1.5">
        <RowActionButton
          aria-label={`Edit ${props.goal.objective}`}
          onClick={() => setIsEditing(true)}
        >
          <Pencil className="h-3 w-3" aria-hidden="true" />
        </RowActionButton>
        <RowActionButton
          tone="positive"
          aria-label={`Promote ${props.goal.objective}`}
          onClick={() => void props.onPromote()}
        >
          <Play className="h-3 w-3" aria-hidden="true" />
          Promote
        </RowActionButton>
        <RowActionButton
          tone="destructive"
          aria-label={`Remove ${props.goal.objective}`}
          onClick={() => void props.onArchive()}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </RowActionButton>
      </div>
    </div>
  );
}

interface UpcomingRowEditorProps {
  goal: GoalRecordV1;
  onCancel: () => void;
  onSubmit: (patch: UpcomingGoalPatch) => Promise<void>;
}

function UpcomingRowEditor(props: UpcomingRowEditorProps) {
  const objectiveRef = useRef<HTMLInputElement | null>(null);
  const budgetRef = useRef<HTMLInputElement | null>(null);
  const turnCapRef = useRef<HTMLInputElement | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const submit = async () => {
    const nextObjective = (objectiveRef.current?.value ?? "").trim();
    if (nextObjective.length === 0) {
      setLocalError("Goal objective is required.");
      objectiveRef.current?.focus();
      return;
    }
    let budgetPatch: number | null | undefined;
    const rawBudget = (budgetRef.current?.value ?? "").trim();
    if (rawBudget.length === 0) {
      // Empty input ⇒ clear the limit (null). Matches the Adder UX.
      budgetPatch = null;
    } else {
      const parsed = parseGoalBudgetInputCents(rawBudget);
      if (parsed === undefined) {
        setLocalError("Enter a budget like $5 or 500c. Use 0 or blank for no budget.");
        return;
      }
      budgetPatch = parsed;
    }

    // Use the shared parser so partial-int inputs like `1.5` or `12abc`
    // fail validation; `null` is the editor's "blank = no cap" path.
    const parsedTurnCap = parseGoalTurnCapInput(turnCapRef.current?.value ?? "");
    if (parsedTurnCap === undefined) {
      setLocalError("Enter a positive whole-number turn cap, or leave blank for no cap.");
      return;
    }
    const turnCapPatch: number | null = parsedTurnCap;

    const patch: UpcomingGoalPatch = {};
    if (nextObjective !== props.goal.objective) patch.objective = nextObjective;
    if (budgetPatch !== props.goal.budgetCents) patch.budgetCents = budgetPatch;
    if (turnCapPatch !== props.goal.turnCap) patch.turnCap = turnCapPatch;
    if (Object.keys(patch).length === 0) {
      // Nothing to save — just close.
      props.onCancel();
      return;
    }

    setIsSaving(true);
    setLocalError(null);
    try {
      await props.onSubmit(patch);
    } catch (caught) {
      setLocalError(caught instanceof Error && caught.message ? caught.message : "Save failed.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="border-border-light bg-surface-primary flex flex-col gap-2 rounded-md border p-2">
      <input
        ref={objectiveRef}
        aria-label="Goal objective"
        defaultValue={props.goal.objective}
        className="border-border bg-surface-primary text-foreground focus:border-accent rounded-md border p-1.5 text-sm outline-none"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <input
          ref={budgetRef}
          aria-label="Goal budget"
          defaultValue={
            props.goal.budgetCents == null ? "" : (props.goal.budgetCents / 100).toFixed(2)
          }
          placeholder="$ budget (blank = no budget)"
          className="border-border bg-surface-primary text-foreground focus:border-accent w-28 rounded-md border p-1.5 text-xs outline-none"
        />
        <input
          ref={turnCapRef}
          aria-label="Goal turn cap"
          defaultValue={props.goal.turnCap == null ? "" : String(props.goal.turnCap)}
          placeholder="turns (blank = no cap)"
          inputMode="numeric"
          className="border-border bg-surface-primary text-foreground focus:border-accent w-28 rounded-md border p-1.5 text-xs outline-none"
        />
        <button
          type="button"
          className="bg-accent text-accent-foreground rounded-md px-2 py-1 text-xs disabled:opacity-60"
          disabled={isSaving}
          onClick={() => void submit()}
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="border-border-light text-muted hover:text-foreground inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
          onClick={props.onCancel}
          aria-label="Cancel goal edit"
        >
          <X className="h-3 w-3" aria-hidden="true" />
          Cancel
        </button>
      </div>
      {localError && (
        <p className="text-danger-soft text-xs" role="alert">
          {localError}
        </p>
      )}
    </div>
  );
}

interface CompletedSectionProps {
  workspaceId: string;
  entries: GoalBoardEntry[];
  onMutated: () => void;
}

function CompletedSection(props: CompletedSectionProps) {
  const api = useLiveAPI();
  const [error, setError] = useState<string | null>(null);

  if (props.entries.length === 0) return null;

  const archive = async (goalId: string) => {
    try {
      await liveClientFor(api).workspace.archiveGoal({ workspaceId: props.workspaceId, goalId });
      setError(null);
      props.onMutated();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "Failed to archive.");
    }
  };

  return (
    <SectionShell title="Completed" count={props.entries.length} defaultOpen={false}>
      <div className="flex flex-col gap-1.5">
        {props.entries.map((entry) => (
          <div
            key={entry.goal.goalId}
            className="border-border-light bg-surface-primary flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
          >
            <span className="text-foreground line-clamp-1 flex-1">{entry.goal.objective}</span>
            <span className="text-muted counter-nums shrink-0 text-xs">
              {formatGoalCents(entry.goal.costCents)}
            </span>
            <RowActionButton
              aria-label={`Archive ${entry.goal.objective}`}
              onClick={() => void archive(entry.goal.goalId)}
            >
              <Inbox className="h-3 w-3" aria-hidden="true" />
              Archive
            </RowActionButton>
          </div>
        ))}
        {error && (
          <p className="text-danger-soft text-xs" role="alert">
            {error}
          </p>
        )}
      </div>
    </SectionShell>
  );
}

interface ArchivedSectionProps {
  workspaceId: string;
  entries: GoalBoardEntry[];
  onMutated: () => void;
}

function ArchivedSection(props: ArchivedSectionProps) {
  const api = useLiveAPI();
  const [error, setError] = useState<string | null>(null);
  if (props.entries.length === 0) return null;

  const revive = async (goalId: string) => {
    try {
      await liveClientFor(api).workspace.reviveArchivedGoal({
        workspaceId: props.workspaceId,
        goalId,
      });
      setError(null);
      props.onMutated();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "Failed to revive.");
    }
  };

  return (
    <SectionShell title="Archived" count={props.entries.length} defaultOpen={false}>
      <div className="flex flex-col gap-1.5">
        {props.entries.map((entry) => (
          <div
            key={entry.goal.goalId}
            className="border-border-light bg-surface-primary flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
          >
            <span className="text-foreground line-clamp-1 flex-1">{entry.goal.objective}</span>
            <RowActionButton
              aria-label={`Revive ${entry.goal.objective}`}
              onClick={() => void revive(entry.goal.goalId)}
            >
              <ArchiveRestore className="h-3 w-3" aria-hidden="true" />
              Revive
            </RowActionButton>
          </div>
        ))}
        {error && (
          <p className="text-danger-soft text-xs" role="alert">
            {error}
          </p>
        )}
      </div>
    </SectionShell>
  );
}

interface UpcomingAdderProps {
  workspaceId: string;
  onAdded: () => void;
}

function UpcomingAdder(props: UpcomingAdderProps) {
  const api = useLiveAPI();
  const { defaults } = useGoalDefaults(props.workspaceId);
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const objectiveRef = useRef<HTMLInputElement | null>(null);
  const budgetRef = useRef<HTMLInputElement | null>(null);
  const turnCapRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    if (objectiveRef.current) objectiveRef.current.value = "";
    if (budgetRef.current) budgetRef.current.value = "";
    if (turnCapRef.current) turnCapRef.current.value = "";
    setError(null);
  };

  const submit = async () => {
    const objective = (objectiveRef.current?.value ?? "").trim();
    if (objective.length === 0) {
      setError("Goal objective is required.");
      objectiveRef.current?.focus();
      return;
    }
    let budgetCents: number | null | undefined;
    const rawBudget = (budgetRef.current?.value ?? "").trim();
    if (rawBudget.length > 0) {
      const parsed = parseGoalBudgetInputCents(rawBudget);
      if (parsed === undefined) {
        setError("Enter a budget like $5 or 500c. Use 0 or blank for no budget.");
        return;
      }
      budgetCents = parsed;
    }
    // Queued goals expose turn caps so inherited workspace/global defaults
    // are visible before auto-promote. Blank falls through to defaults;
    // explicit values use the shared parser for the same validation as the
    // main create form.
    let turnCap: number | null | undefined;
    const rawTurnCap = (turnCapRef.current?.value ?? "").trim();
    if (rawTurnCap.length > 0) {
      const parsed = parseGoalTurnCapInput(rawTurnCap);
      if (parsed === undefined) {
        setError("Enter a positive whole-number turn cap, or leave blank for the default.");
        return;
      }
      // `null` from the parser means "blank input" — handled by the
      // length check above, so this branch only ever gets a positive
      // integer. Use `??` to coerce `null → undefined` explicitly.
      turnCap = parsed ?? undefined;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const client = liveClientFor(api);
      // Load effective defaults at submit time so a quick submit before
      // the hook fetch resolves still persists the current workspace/global
      // limits. Fall back to the hook snapshot if the network read fails.
      let effective = defaults;
      try {
        effective = await loadGoalDefaults(client, props.workspaceId);
      } catch {
        // Keep `effective` at the hook value (which is itself a
        // best-effort snapshot or the canonical default).
      }
      const resolved = resolveGoalSetIntent({ objective, budgetCents, turnCap }, effective);
      await client.workspace.addUpcomingGoal({
        workspaceId: props.workspaceId,
        objective: resolved.objective,
        budgetCents: resolved.budgetCents,
        turnCap: resolved.turnCap,
      });
      reset();
      setIsOpen(false);
      props.onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to queue goal.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        className={cn(
          "text-muted hover:text-foreground border-border-light inline-flex items-center gap-1",
          "rounded-md border border-dashed px-2 py-1.5 text-xs"
        )}
        aria-label="Queue another goal"
        disabled={api == null}
        onClick={() => setIsOpen(true)}
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        Queue another goal
      </button>
    );
  }

  return (
    <fieldset
      disabled={api == null}
      className="border-border-light bg-surface-primary flex min-w-0 flex-col gap-2 rounded-md border p-2"
    >
      <input
        ref={objectiveRef}
        aria-label="Queued goal objective"
        placeholder={GOAL_OBJECTIVE_PLACEHOLDER}
        className="border-border bg-surface-primary text-foreground focus:border-accent rounded-md border p-1.5 text-sm outline-none"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setIsOpen(false);
            reset();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <input
          ref={budgetRef}
          aria-label="Queued goal budget"
          // Keep the placeholder aligned with resolveGoalSetIntent's
          // blank-budget behavior so the queued goal uses the limit the
          // user expects.
          placeholder={
            defaults.alwaysRequireExplicitBudget
              ? `$${(defaults.defaultBudgetCents / 100).toFixed(2)} (default)`
              : "no budget (default)"
          }
          className="border-border bg-surface-primary text-foreground focus:border-accent w-28 rounded-md border p-1.5 text-xs outline-none"
        />
        <input
          ref={turnCapRef}
          aria-label="Queued goal turn cap"
          // Show the inherited turn cap before auto-promote so queued
          // goals do not pick up an invisible limit.
          placeholder={
            defaults.defaultTurnCap == null
              ? "no cap (default)"
              : `${defaults.defaultTurnCap} turns (default)`
          }
          inputMode="numeric"
          className="border-border bg-surface-primary text-foreground focus:border-accent w-28 rounded-md border p-1.5 text-xs outline-none"
        />
        <button
          type="button"
          className="bg-accent text-accent-foreground rounded-md px-2 py-1 text-xs disabled:opacity-60"
          disabled={isSubmitting}
          onClick={() => void submit()}
        >
          {isSubmitting ? "Queuing…" : "Queue goal"}
        </button>
        <button
          type="button"
          className="border-border-light text-muted hover:text-foreground rounded-md border px-2 py-1 text-xs"
          onClick={() => {
            setIsOpen(false);
            reset();
          }}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="text-danger-soft text-xs" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
