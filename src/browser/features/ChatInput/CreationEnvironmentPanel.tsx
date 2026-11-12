import { useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitBranch,
} from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import { FilterList } from "@/browser/components/FilterList/FilterList";
import {
  MODAL_POPOVER_CONTENT_PROPS,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/browser/components/Popover/Popover";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { usePhoneTouchViewport } from "@/browser/hooks/useNarrowViewport";
import type { IsolationOptionUi } from "@/browser/utils/runtimeUi";
import {
  formatKeybind,
  formatKeybindForAria,
  isAltGraphPressed,
  KEYBINDS,
  matchesKeybind,
  type Keybind,
} from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import type {
  IsolationChoice,
  ProjectIsolation,
  WorkspaceIsolation,
} from "@/common/types/isolation";
import type { BranchLoadStatus } from "./branchListLoad";
import {
  summarizeUnavailableReason,
  type EnvironmentSummary,
  type RuntimeFieldError,
} from "./creationEnvironmentSummary";
import { environmentArrowTarget, environmentOpenFocusTarget } from "./environmentPanelKeys";
import { branchPickerItems } from "./creationPickerGroups";
import { useCreationShortcut } from "./useCreationShortcut";

/** One option on an isolation axis, with its UI and why it cannot be picked (if it cannot). */
export interface IsolationSelectOption<T extends string> {
  value: T;
  ui: IsolationOptionUi;
  disabledReason: string | null;
}

/** The base-branch column's data; null when the selected runtime needs no base branch. */
export interface EnvironmentBranchPicker {
  load: BranchLoadStatus;
  options: string[];
  selected: string;
  /** The repository's default branch, tagged in the list; null when it is not known. */
  defaultBranch: string | null;
  /** The branches committed to most recently, newest first: listed right under the default. */
  recentBranches: string[];
  /** Loads the list again after a failed load. */
  onRetry: () => void;
  onSelect: (branch: string) => void;
}

interface CreationEnvironmentPanelProps {
  summary: EnvironmentSummary;
  /** The selection as one sentence: the chip's tooltip and the panel's footer. */
  description: string;
  disabled: boolean;
  isolation: IsolationChoice;
  projectOptions: Array<IsolationSelectOption<ProjectIsolation>>;
  workspaceOptions: Array<IsolationSelectOption<WorkspaceIsolation>>;
  onSelectIsolation: (choice: IsolationChoice) => void;
  /** Inputs the selected "Run on" option needs (SSH host, Coder form), shown under its row. */
  projectFields: ReactNode;
  /** Inputs the selected isolation needs (Docker image, dev container config). */
  workspaceFields: ReactNode;
  branch: EnvironmentBranchPicker | null;
  fieldError: RuntimeFieldError | null;
  /** Counts the sends refused for a required field; a new one reopens the panel. */
  fieldErrorAttempt: number;
  /** Shown in the footer before Done: making the selection the project's default. */
  footerAction: ReactNode;
  /**
   * Runs the footer action's shortcut while the panel is open. The panel is modal and keeps its
   * key events from the page's window listeners, so the page's own listener never sees it.
   */
  footerShortcut: { keybind: Keybind; run: () => void } | null;
}

// A quiet mono caption: the column names are labels for the eye, not headings to read.
const COLUMN_TITLE_CLASSES =
  "text-muted-light font-mono text-[10.5px] font-medium tracking-[0.06em] uppercase";
const COLUMN_CLASSES = "flex min-w-0 flex-col p-1.5";
// On a touch screen the docs link gets the 44px touch minimum (globals.css), which made a caption
// with the link twice as tall as one without; one fixed caption height keeps the gaps even.
const COLUMN_HEADER_CLASSES =
  "flex items-center justify-between px-2.5 pt-2 pb-1 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-0";

/** One isolation axis as a radio group; the selected row shows the inputs it needs below it. */
function OptionColumn<T extends string>(props: {
  title: string;
  ariaLabel: string;
  value: T;
  options: Array<IsolationSelectOption<T>>;
  onChange: (value: T) => void;
  disabled: boolean;
  fields: ReactNode;
  className?: string;
}) {
  const selected = props.options.find((option) => option.value === props.value);
  return (
    <div data-environment-column className={cn(COLUMN_CLASSES, props.className)}>
      <div className={COLUMN_HEADER_CLASSES}>
        <span className={COLUMN_TITLE_CLASSES}>{props.title}</span>
        {selected && <DocsLink path={selected.ui.docsPath} />}
      </div>
      <div role="radiogroup" aria-label={props.ariaLabel} className="flex flex-col">
        {props.options.map((option) => {
          const Icon = option.ui.Icon;
          const checked = option.value === props.value;
          const unavailable = option.disabledReason !== null;
          const rowDisabled = props.disabled || unavailable;
          const why = unavailable ? summarizeUnavailableReason(option.disabledReason ?? "") : null;
          return (
            <div key={option.value} className="flex flex-col">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  // aria-disabled as well: assistive tech and tests read it on a native-disabled row.
                  aria-disabled={rowDisabled}
                  disabled={rowDisabled}
                  // Re-picking the selected row is a no-op, as with the select this replaced: the
                  // pick rebuilds the runtime and would drop what the row's fields hold (for
                  // example Docker's credential sharing).
                  onClick={() => {
                    if (!checked) props.onChange(option.value);
                  }}
                  className={cn(
                    "focus-visible:ring-accent flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left outline-none focus-visible:ring-1 [@media(pointer:coarse)]:min-h-12",
                    checked ? "bg-hover" : "hover:bg-hover/60",
                    props.disabled && "opacity-50"
                  )}
                >
                  {/* Decorative: the runtime icons carry their own labels ("Local Runtime" on None's
                    icon), which would otherwise become part of the row's accessible name. */}
                  <span
                    aria-hidden
                    className={cn(
                      "flex shrink-0",
                      unavailable ? "text-muted-light" : option.ui.iconClass
                    )}
                  >
                    <Icon size={14} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span
                      className={cn(
                        "text-[13px] font-medium",
                        unavailable ? "text-muted" : "text-foreground"
                      )}
                    >
                      {option.ui.label}
                    </span>
                    {/* One line under the name: what the option is, or why it cannot be picked. An
                      unavailable row is as tall as any other: it shows the reason's short form
                      (a CLI's own message ran to three lines and pushed the options apart) and
                      keeps the whole reason for screen readers and the "Set up" tooltip. */}
                    {why !== null ? (
                      <>
                        <span
                          aria-hidden
                          className="text-warning-text truncate text-xs leading-snug"
                        >
                          {why.summary}
                        </span>
                        <span className="sr-only">{option.disabledReason}</span>
                      </>
                    ) : (
                      <span className="text-muted truncate text-xs leading-snug">
                        {option.ui.description}
                      </span>
                    )}
                  </span>
                  {checked && <Check aria-hidden className="text-foreground size-3.5 shrink-0" />}
                </button>
                {why?.needsSetup && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DocsLink
                        path={option.ui.docsPath}
                        className="border-border-medium bg-hover text-foreground hover:text-foreground mr-1.5 shrink-0 rounded-md border px-2 py-1 text-xs font-medium"
                      >
                        Set up
                      </DocsLink>
                    </TooltipTrigger>
                    {/* Below the link: above it, the tooltip covered the rows the pointer came from. */}
                    <TooltipContent side="bottom" align="end" className="max-w-72 break-words">
                      {option.disabledReason}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              {checked && props.fields != null && (
                <div className="flex flex-col gap-2 pt-1 pr-1.5 pb-2 pl-[2.125rem]">
                  {props.fields}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BranchColumn(props: {
  branch: EnvironmentBranchPicker;
  disabled: boolean;
  className?: string;
  /** The list's height: a column on desktop, most of the sheet on a phone. */
  listClassName?: string;
  /** The phone's branch view names itself in the sheet's header. */
  hideTitle?: boolean;
}) {
  const { branch } = props;
  return (
    <div data-environment-column className={cn(COLUMN_CLASSES, props.className)}>
      {!props.hideTitle && (
        <div className={COLUMN_HEADER_CLASSES}>
          <span className={COLUMN_TITLE_CLASSES}>Base branch</span>
        </div>
      )}
      {branch.load === "loading" ? (
        <div className="flex flex-col gap-3 px-2.5 pt-2 pb-2.5" aria-busy role="status">
          <span className="sr-only">Loading branches</span>
          <Skeleton className="h-3 w-3/5 rounded" />
          <Skeleton className="h-3 w-4/5 rounded" />
          <Skeleton className="h-3 w-2/5 rounded" />
        </div>
      ) : branch.load === "failed" ? (
        <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5">
          <span className="text-error min-w-0 flex-1 text-xs" role="status">
            Could not load branches
          </span>
          {/* Before, the only way to try again was to leave the project and come back. */}
          <Button
            variant="outline"
            size="xs"
            className="text-foreground h-7 px-2.5 text-xs"
            disabled={props.disabled}
            onClick={branch.onRetry}
          >
            Retry
          </Button>
        </div>
      ) : (
        <FilterList
          items={branchPickerItems(branch.options, branch.defaultBranch, branch.recentBranches)}
          selected={branch.selected}
          onSelect={branch.onSelect}
          label="Select source branch"
          placeholder="Filter branches…"
          noun="branches"
          mono
          boxedFilter
          disabled={props.disabled}
          listClassName={props.listClassName ?? "max-h-56 p-0"}
        />
      )}
    </div>
  );
}

const SEPARATOR = (
  <span aria-hidden className="text-muted-light shrink-0">
    ·
  </span>
);

function ChipBranch(props: { branch: EnvironmentSummary["branch"] }) {
  const { branch } = props;
  if (branch.kind === "hidden") return null;
  return (
    <>
      {SEPARATOR}
      <span
        data-component="BranchSelector"
        data-branch-load={branch.kind}
        className="flex min-w-0 items-center gap-1.5"
      >
        {branch.kind === "selected" ? (
          <>
            <span className="text-muted hidden font-normal sm:inline">from</span>
            <GitBranch aria-hidden className="text-muted size-3 shrink-0 sm:hidden" />
            <span className="min-w-0 truncate font-mono text-xs">{branch.name}</span>
          </>
        ) : branch.kind === "failed" ? (
          <span className="text-error min-w-0 truncate">Could not load branches</span>
        ) : (
          <>
            <span className="sr-only">Loading branches</span>
            <Skeleton className="h-3 w-12 rounded" />
          </>
        )}
      </span>
    </>
  );
}

/** The UI of the selected option on one axis, for the chip's icon and colour. */
function selectedOptionUi<T extends string>(
  options: Array<IsolationSelectOption<T>>,
  value: T
): IsolationOptionUi | undefined {
  return options.find((option) => option.value === value)?.ui;
}

/** The closed state: the selection as one line, or the field Send is waiting for. */
function ChipSummary(props: {
  summary: EnvironmentSummary;
  projectUi: IsolationOptionUi | undefined;
  workspaceUi: IsolationOptionUi | undefined;
}) {
  const { summary, projectUi } = props;
  const ProjectIcon = projectUi?.Icon;
  return (
    <>
      <span className="sr-only">Environment:</span>
      {summary.error !== null ? (
        <span className="text-error flex min-w-0 items-center gap-1.5">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{summary.error}</span>
        </span>
      ) : (
        <span
          data-component="ProjectIsolationSummary"
          className="text-foreground flex min-w-0 items-center gap-2"
        >
          {ProjectIcon && (
            <span aria-hidden className={cn("flex shrink-0", projectUi?.iconClass)}>
              <ProjectIcon size={14} />
            </span>
          )}
          <span className="min-w-0 truncate">{summary.where}</span>
        </span>
      )}
      {SEPARATOR}
      {/* Usually a short word; with SSH and no isolation it is the shared directory, so it can
          truncate like the host and the branch. */}
      <span
        data-component="WorkspaceIsolationSummary"
        className={cn("min-w-0 truncate", props.workspaceUi?.iconClass ?? "text-foreground")}
      >
        {summary.isolation}
      </span>
      <ChipBranch branch={summary.branch} />
      <ChevronDown aria-hidden className="text-muted ml-auto size-3.5 shrink-0" />
    </>
  );
}

/**
 * The base branch on a phone: one row that opens the branch list as its own view. A filter and a
 * list of branches do not fit under two option groups on a phone screen, and the keyboard the
 * filter raises would cover them.
 */
function PhoneBranchRow(props: {
  branch: EnvironmentBranchPicker;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { branch } = props;
  return (
    <div className={cn(COLUMN_CLASSES, "border-border-light border-t")}>
      <div className={COLUMN_HEADER_CLASSES}>
        <span className={COLUMN_TITLE_CLASSES}>Base branch</span>
      </div>
      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onOpen}
        className="hover:bg-hover/60 focus-visible:ring-accent flex min-h-12 w-full items-center gap-2.5 rounded-md px-2.5 text-left outline-none focus-visible:ring-1 disabled:opacity-50"
      >
        <GitBranch aria-hidden className="text-muted size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
          {branch.load === "loaded" ? (
            branch.selected
          ) : branch.load === "failed" ? (
            <span className="text-error font-sans">Could not load branches</span>
          ) : (
            <span className="text-muted font-sans">Loading branches…</span>
          )}
        </span>
        <ChevronRight aria-hidden className="text-muted size-4 shrink-0" />
      </button>
    </div>
  );
}

/** Three columns on desktop, stacked on a phone. Literal classes: Tailwind only finds literals. */
function columnsClass(props: Pick<CreationEnvironmentPanelProps, "branch" | "isolation">): string {
  if (props.branch === null) return "md:grid-cols-2";
  // Coder's workspace form is wider than a plain option list.
  return props.isolation.project === "coder"
    ? "md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]"
    : "md:grid-cols-[minmax(0,27fr)_minmax(0,29fr)_minmax(0,34fr)]";
}

/** Whether a key event is the footer action's chord. AltGr input reports Ctrl+Alt: it is text. */
function isFooterShortcut(
  event: React.KeyboardEvent,
  shortcut: CreationEnvironmentPanelProps["footerShortcut"]
): boolean {
  return shortcut !== null && !isAltGraphPressed(event) && matchesKeybind(event, shortcut.keybind);
}

/** The sheet's header on a phone: a grab bar, what the view is, a way back and Done. */
function PhoneSheetHeader(props: { branchView: boolean; onBack: () => void; onClose: () => void }) {
  return (
    <div className="flex shrink-0 flex-col">
      <span aria-hidden className="bg-border-medium mx-auto mt-2 h-1 w-9 rounded-full" />
      <div className="flex min-h-11 items-center gap-1 px-2">
        {props.branchView ? (
          <button
            type="button"
            aria-label="Back to environment"
            onClick={props.onBack}
            className="text-foreground flex size-11 items-center justify-center"
          >
            <ChevronLeft aria-hidden className="size-4" />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <span className="text-foreground flex-1 text-[15px] font-semibold">
          {props.branchView ? "Base branch" : "Environment"}
        </span>
        {/* In the header, within reach while the list below scrolls. */}
        <button
          type="button"
          onClick={props.onClose}
          className="text-foreground flex h-11 items-center px-2 text-sm font-medium"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/** The phone's branch view: the list alone, returning to the overview on a pick. */
function PhoneBranchView(props: {
  branch: EnvironmentBranchPicker;
  disabled: boolean;
  onDone: () => void;
}) {
  return (
    <BranchColumn
      branch={{
        ...props.branch,
        // A pick answers the question this view asked, so it returns to the overview.
        onSelect: (name) => {
          props.branch.onSelect(name);
          props.onDone();
        },
      }}
      disabled={props.disabled}
      listClassName="max-h-[55dvh] p-0"
      hideTitle
    />
  );
}

/** The option groups and the base branch: side by side on desktop, stacked on a phone. */
function EnvironmentColumns(
  props: CreationEnvironmentPanelProps & { phone: boolean; onOpenBranchView: () => void }
) {
  return (
    <div role="presentation" className={cn("grid grid-cols-1", columnsClass(props))}>
      <OptionColumn
        title="Run on"
        ariaLabel="Project isolation"
        value={props.isolation.project}
        options={props.projectOptions}
        onChange={(project) =>
          props.onSelectIsolation({ project, workspace: props.isolation.workspace })
        }
        disabled={props.disabled}
        fields={props.projectFields}
      />
      <OptionColumn
        title="Isolation"
        ariaLabel="Workspace isolation"
        value={props.isolation.workspace}
        options={props.workspaceOptions}
        onChange={(workspace) =>
          props.onSelectIsolation({ project: props.isolation.project, workspace })
        }
        disabled={props.disabled}
        fields={props.workspaceFields}
        className="border-border-light border-t md:border-t-0 md:border-l"
      />
      {props.branch !== null &&
        (props.phone ? (
          <PhoneBranchRow
            branch={props.branch}
            disabled={props.disabled}
            onOpen={props.onOpenBranchView}
          />
        ) : (
          <BranchColumn
            branch={props.branch}
            disabled={props.disabled}
            className="border-border-light border-t md:border-t-0 md:border-l"
          />
        ))}
    </div>
  );
}

/** The sentence that says what the selection means, the default action and Done. */
function EnvironmentFooter(props: {
  descriptionId: string;
  description: string;
  footerAction: ReactNode;
  phone: boolean;
  onClose: () => void;
}) {
  return (
    <div className="border-border-light flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3.5 py-2.5">
      <span id={props.descriptionId} className="text-muted min-w-0 flex-1 basis-48 text-xs">
        {props.description}
      </span>
      {props.footerAction}
      {/* The panel's one primary action, so it is the light button: every pick applies at once
          and Done only closes. On a phone Done is in the sheet's header. */}
      {!props.phone && (
        <Button
          size="xs"
          className="bg-foreground text-background hover:bg-foreground/90 h-7 px-3 text-xs font-medium"
          onClick={props.onClose}
        >
          Done
        </Button>
      )}
    </div>
  );
}

/**
 * What the chip opens. On a touch phone it is a sheet from the bottom edge, where a thumb reaches
 * it, and the branch list is a second view inside it. It mounts when the panel opens, so the
 * sheet always starts on the overview.
 */
function EnvironmentPanelContent(props: CreationEnvironmentPanelProps & { onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const phone = usePhoneTouchViewport();
  const [branchViewOpen, setBranchViewOpen] = useState(false);
  // Only the phone's branch row opens the view, so an open view means a phone.
  const branchView = branchViewOpen ? props.branch : null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isFooterShortcut(event, props.footerShortcut)) {
      event.preventDefault();
      props.footerShortcut?.run();
      return;
    }
    // Arrow keys move between the rows inside; the rows themselves are the controls.
    const next = environmentArrowTarget(
      event.target as HTMLElement,
      event.currentTarget,
      event.key
    );
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <PopoverContent
      {...MODAL_POPOVER_CONTENT_PROPS}
      ref={contentRef}
      align="start"
      // Keeps the same gap to both screen edges when the panel is as wide as the viewport allows.
      collisionPadding={8}
      // globals.css pins the popover carrying this to the bottom edge on a touch phone.
      data-phone-sheet={phone ? "" : undefined}
      aria-label="Environment"
      aria-describedby={descriptionId}
      // The panel is modal and keeps its key events from the page's window listeners.
      onKeyDown={(event) => {
        handleKeyDown(event);
        MODAL_POPOVER_CONTENT_PROPS.onKeyDown(event);
      }}
      // Wide enough for three columns on desktop; scrolls inside the space the popover has.
      className={cn(
        "flex flex-col overflow-y-auto p-0 shadow-xl",
        phone
          ? "max-h-[85dvh] w-screen rounded-t-[14px] rounded-b-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]"
          : "max-h-(--radix-popover-content-available-height) w-[min(56.25rem,calc(100vw-1rem))] rounded-[10px]"
      )}
      onOpenAutoFocus={(event) => {
        const target = environmentOpenFocusTarget(contentRef.current);
        if (!target) return;
        event.preventDefault();
        target.focus();
      }}
    >
      {phone && (
        <PhoneSheetHeader
          branchView={branchView !== null}
          onBack={() => setBranchViewOpen(false)}
          onClose={props.onClose}
        />
      )}
      {branchView !== null ? (
        <PhoneBranchView
          branch={branchView}
          disabled={props.disabled}
          onDone={() => setBranchViewOpen(false)}
        />
      ) : (
        <>
          <EnvironmentColumns
            {...props}
            phone={phone}
            onOpenBranchView={() => setBranchViewOpen(true)}
          />
          <EnvironmentFooter
            descriptionId={descriptionId}
            description={props.description}
            footerAction={props.footerAction}
            phone={phone}
            onClose={props.onClose}
          />
        </>
      )}
    </PopoverContent>
  );
}

/**
 * The creation page's environment: one chip that reads as the selection ("Local · Worktree · from
 * main") and opens one panel holding where it runs, the isolation and the base branch side by
 * side. It replaces a row of three separate selects, so the choices that depend on each other are
 * seen and changed together, and the reason an option is unavailable is shown in full.
 */
export function CreationEnvironmentPanel(props: CreationEnvironmentPanelProps) {
  const [open, setOpen] = useState(false);
  // Each Send refused for an empty required field opens the panel on that field. The fields live
  // in the panel, so a closed panel would hide what Send is waiting for. Keyed on the attempt, not
  // on the error: the error is the same for a second refused send. Adjusted during render (not in
  // an effect): it is state derived from a prop change.
  const [seenAttempt, setSeenAttempt] = useState(props.fieldErrorAttempt);
  if (props.fieldErrorAttempt !== seenAttempt) {
    setSeenAttempt(props.fieldErrorAttempt);
    if (props.fieldError !== null) setOpen(true);
  }

  useCreationShortcut(!props.disabled && !open, KEYBINDS.OPEN_CREATION_ENVIRONMENT, () =>
    setOpen(true)
  );

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <Tooltip>
        {/* Hover only. Radix also opens a tooltip on focus, and closing the panel returns focus to
            the chip: the tooltip then sat on top of the project heading, which could not be
            clicked, and on a phone it showed the keyboard shortcut. Cancelling the focus event
            keeps the focus return and skips the tooltip. */}
        <TooltipTrigger asChild onFocus={(event) => event.preventDefault()}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="creation-environment"
              // The tutorial's base-branch step points here. On the chip, not on its branch
              // segment: the segment is hidden for runtimes with no base branch, and a step with
              // no target shows only its backdrop.
              data-tutorial="trunk-branch"
              aria-haspopup="dialog"
              aria-keyshortcuts={formatKeybindForAria(KEYBINDS.OPEN_CREATION_ENVIRONMENT)}
              disabled={props.disabled}
              className={cn(
                // A phone gets a full-width, thumb-sized chip; the desktop chip is as wide as its text.
                "bg-background-secondary hover:bg-hover focus-visible:ring-accent flex h-8 max-w-full min-w-0 items-center gap-2 rounded-[7px] border px-2.5 text-[13px] font-medium outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50 [@media(max-width:768px)_and_(pointer:coarse)]:h-11 [@media(max-width:768px)_and_(pointer:coarse)]:w-full",
                props.summary.error !== null ? "border-error" : "border-border-medium",
                open && "bg-hover"
              )}
            >
              <ChipSummary
                summary={props.summary}
                projectUi={selectedOptionUi(props.projectOptions, props.isolation.project)}
                workspaceUi={selectedOptionUi(props.workspaceOptions, props.isolation.workspace)}
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-72">
          {props.description} ({formatKeybind(KEYBINDS.OPEN_CREATION_ENVIRONMENT)})
        </TooltipContent>
      </Tooltip>
      {/* Mounted only while open: Radix unmounts the popover's content, but not this component,
          and the phone's branch view must not still be showing at the next open. */}
      {open && <EnvironmentPanelContent {...props} onClose={() => setOpen(false)} />}
    </Popover>
  );
}
