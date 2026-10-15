import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  VisuallyHidden,
} from "@/browser/components/Dialog/Dialog";
import { McpAppFrame } from "@/browser/features/RightSidebar/ArtifactsTab/McpAppFrame";
import type { McpAppViewRef } from "@/browser/features/RightSidebar/ArtifactsTab/mcpAppViewsStore";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { useConfirmDialog } from "@/browser/contexts/ConfirmDialogContext";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";
import { getOwn } from "@/common/utils/getOwn";
import type {
  MCPSettingsAppView,
  MCPSettingsLayoutItem,
  MCPSettingsSnapshot,
  MCPSettingsToolAction,
} from "@/common/utils/mcpSettings";
import { publishSettingsToolWrite, type SettingsToolRunResult } from "./settingsToolRuns";

interface MCPSettingsToolActionRowProps {
  workspaceId: string;
  serverName: string;
  /** The settings read's instanceToken: the tool must belong to the instance the user saw. */
  instanceToken: string;
  item: Extract<MCPSettingsLayoutItem, { kind: "tool" }>;
  /** A save or refresh of the section is in flight. */
  disabled: boolean;
  /** A run of this tool is in flight (it can predate this mount: settingsToolRuns). */
  running: boolean;
  /** The last run's text result, or null. */
  result: SettingsToolRunResult | null;
  /**
   * The run starts; the returned callback ends it with the result to show (the section and
   * dialog wait for it).
   */
  beginRun: () => (result: SettingsToolRunResult | null) => void;
}

/**
 * A settings layout tool action (`openai/settings`): a button that calls the server's tool with
 * `{}`. A regular tool shows the text of its result under the row (the spec shows it in a
 * tooltip; inline also works on touch screens). An MCP App tool opens its view in a modal on top
 * of the settings, as the spec says. A tool without `readOnlyHint: true` asks the user first. A
 * tool Xum cannot run (unlisted or not allowed) stays a disabled row.
 */
export function MCPSettingsToolActionRow(props: MCPSettingsToolActionRowProps) {
  const action = props.item.action;
  if (action === undefined)
    return (
      <div
        className="text-content-secondary flex items-center justify-between gap-3 text-xs opacity-60"
        aria-disabled="true"
      >
        <span className="min-w-0 wrap-anywhere">{props.item.tool}</span>
        <span className="shrink-0">Not available</span>
      </div>
    );
  return <RunnableToolRow {...props} action={action} />;
}

function RunnableToolRow(props: MCPSettingsToolActionRowProps & { action: MCPSettingsToolAction }) {
  const { app, closeApp, run } = useToolActionRun(props);
  const { running, result } = props;
  const label = props.action.title;
  const verb = props.action.opensApp ? "Open" : "Run";
  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm wrap-anywhere">{label}</div>
          {props.item.description && (
            <div className="text-content-secondary text-xs wrap-anywhere">
              {props.item.description}
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => void run()}
          disabled={running || props.disabled}
          aria-label={`${verb} ${label}`}
        >
          {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {verb}
        </Button>
      </div>
      {result && <ToolRunResultText result={result} />}
      {app && (
        <SettingsAppModal
          workspaceId={props.workspaceId}
          app={app}
          onClose={() => void closeApp()}
        />
      )}
    </div>
  );
}

/** A run's text result (or error) under its row. */
function ToolRunResultText(props: { result: SettingsToolRunResult }) {
  return (
    <div
      role="status"
      className={cn(
        "max-h-40 overflow-y-auto text-xs whitespace-pre-wrap wrap-anywhere",
        props.result.isError ? "text-danger-soft" : "text-content-secondary"
      )}
    >
      {props.result.text !== "" ? props.result.text : props.result.isError ? "Failed" : "Done"}
    </div>
  );
}

/** An opened app action's view, in a modal on top of the settings dialog. */
function SettingsAppModal(props: {
  workspaceId: string;
  app: { view: MCPSettingsAppView; openCount: number };
  onClose: () => void;
}) {
  const { view } = props.app;
  // The frame's close sequence: Escape and outside clicks give the view its teardown too.
  const closeFrame = useRef<(() => void) | null>(null);
  // A failed view read (getView) offers Reload: it mounts the stored record again. Open would
  // call the tool again.
  const [reloads, setReloads] = useState(0);
  const ref: McpAppViewRef = {
    toolCallId: view.viewKey,
    serverName: view.serverName,
    serverLabel: view.serverLabel,
    resourceUri: view.resourceUri,
    toolName: view.toolName,
    label: view.title,
    arguments: {},
    cancelled: false,
    failed: false,
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (closeFrame.current) closeFrame.current();
        else props.onClose();
      }}
    >
      {/* The panel frame has its own Close header. */}
      <DialogContent
        showCloseButton={false}
        // Focus the dialog, not its first control (the header's Close, a tooltip trigger whose
        // tooltip would take the first Escape): Escape then closes the app modal at once.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
        className="flex h-[80vh] max-w-2xl flex-col gap-0 overflow-hidden p-0"
      >
        <VisuallyHidden>
          <DialogTitle>{view.title}</DialogTitle>
        </VisuallyHidden>
        <McpAppFrame
          // Each open calls the tool again: a new result is a new document.
          key={`${props.app.openCount}:${reloads}`}
          workspaceId={props.workspaceId}
          view={ref}
          variant="panel"
          onReload={() => setReloads(reloads + 1)}
          onClose={props.onClose}
          closeRef={closeFrame}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Which tool a run calls, on the server instance the user saw. */
interface ToolActionTarget {
  workspaceId: string;
  serverName: string;
  toolName: string;
  instanceToken: string;
}

/** A run's outcome: its text result or opened view, and whether the tool may have written. */
type ToolActionOutcome =
  | { success: false; error: string }
  | {
      success: true;
      result: SettingsToolRunResult | null;
      view: MCPSettingsAppView | null;
      wrote: boolean;
    };

/** Run or open `action` once. */
async function callToolAction(
  api: APIClient,
  target: ToolActionTarget,
  action: MCPSettingsToolAction,
  confirmed: boolean
): Promise<ToolActionOutcome> {
  const request = { ...target, confirmed };
  if (action.opensApp) {
    const response = await api.mcp.settings.openApp(request);
    // The open (or the app's own calls) can change the settings, but a re-read now would
    // remount the section and close the app modal: closeApp re-reads instead.
    return response.success
      ? { success: true, result: null, view: response.data, wrote: false }
      : response;
  }
  const response = await api.mcp.settings.runTool(request);
  return response.success
    ? {
        success: true,
        result: response.data,
        view: null,
        wrote: confirmed && !response.data.isError,
      }
    : response;
}

/** The action of `toolName` in a settings read, or null when it cannot run. */
function toolActionOf(snapshot: MCPSettingsSnapshot, toolName: string) {
  const item = snapshot.layout
    .flatMap((group) => group.items)
    .find((candidate) => candidate.kind === "tool" && candidate.tool === toolName);
  return item?.kind === "tool" ? (item.action ?? null) : null;
}

/** The target's action, read again; null when the read fails or the tool cannot run. */
async function readToolAction(
  api: APIClient,
  target: ToolActionTarget
): Promise<MCPSettingsToolAction | null> {
  try {
    const reads = await api.mcp.settings.read({
      workspaceId: target.workspaceId,
      serverNames: [target.serverName],
      ifConnected: true,
    });
    const read = getOwn(reads, target.serverName);
    if (read?.success !== true || read.data === null || "notConnected" in read.data) return null;
    return toolActionOf(read.data, target.toolName);
  } catch {
    // The run's own error is the one to show.
    return null;
  }
}

/**
 * Run `action`, and learn its new flag when the read-only flag is stale. A server can drop a
 * tool's readOnlyHint (tools/list_changed) after the dialog read its settings. The backend
 * refreshes the catalog before a run and refuses the unconfirmed run, but the row kept the old
 * flag, so every click failed the same way. So after a failed read-only run, read the action
 * again: if it can write now, `onFresh` keeps the new flag, and the next click asks for the
 * confirmation. This run does not repeat on its own: the failure can also come after the
 * dispatch (a transport error), and a second call could run a writing tool twice.
 */
async function callWithFreshFlag(
  api: APIClient,
  target: ToolActionTarget,
  action: MCPSettingsToolAction,
  onFresh: (action: MCPSettingsToolAction) => void
): Promise<ToolActionOutcome> {
  const outcome = await callToolAction(api, target, action, !action.readOnly);
  if (outcome.success || !action.readOnly) return outcome;
  const fresh = await readToolAction(api, target);
  if (fresh !== null && !fresh.readOnly && fresh.opensApp === action.opensApp) onFresh(fresh);
  return outcome;
}

/**
 * Show an outcome: open its app, and read the settings again after a tool that can write (a
 * reset, an import): it may have changed them, and the backend's read refreshes its settings
 * caches too. Returns the text result to show.
 */
async function settleOutcome(
  outcome: ToolActionOutcome,
  openApp: (view: MCPSettingsAppView) => void,
  rereadSettings: () => Promise<void>
): Promise<SettingsToolRunResult | null> {
  if (!outcome.success) return { text: outcome.error, isError: true };
  if (outcome.view !== null) openApp(outcome.view);
  if (outcome.wrote) await rereadSettings();
  return outcome.result;
}

/**
 * Confirm (a tool that can write), run or open, and keep the latest app. The result goes to the
 * run's end callback (settingsToolRuns keeps it). The run ends after a settings re-read, so
 * Save and Refresh Tools wait for it.
 */
function useToolActionRun(
  props: MCPSettingsToolActionRowProps & { action: MCPSettingsToolAction }
) {
  const { api } = useAPI();
  const { confirm } = useConfirmDialog();
  const [app, setApp] = useState<{
    view: MCPSettingsAppView;
    openCount: number;
    /** A tool that can write opened it: the settings are read again when it closes. */
    canWrite: boolean;
  } | null>(null);
  const [openCount, setOpenCount] = useState(0);
  // The action as this row's latest re-read saw it (callWithFreshFlag).
  const [refreshed, setRefreshed] = useState<MCPSettingsToolAction | null>(null);

  // Server text is untrusted: the dialog names the tool and server, nothing the tool claims.
  const ask = (action: MCPSettingsToolAction) =>
    confirm({
      title: `Run ${action.title}?`,
      description: `This tool of ${props.serverName} can change data. Run it only if you trust the server.`,
      confirmLabel: "Run",
    });
  const openApp = (view: MCPSettingsAppView, canWrite: boolean) => {
    setApp({ view, openCount: openCount + 1, canWrite });
    setOpenCount(openCount + 1);
  };

  const run = async () => {
    if (!api) return;
    const action = refreshed ?? props.action;
    if (!action.readOnly && !(await ask(action))) return;
    const endRun = props.beginRun();
    const target = {
      workspaceId: props.workspaceId,
      serverName: props.serverName,
      toolName: props.item.tool,
      instanceToken: props.instanceToken,
    };
    let result: SettingsToolRunResult | null = null;
    try {
      const outcome = await callWithFreshFlag(api, target, action, setRefreshed);
      result = await settleOutcome(
        outcome,
        (view) => openApp(view, !action.readOnly),
        () => publishSettingsToolWrite(props.workspaceId, props.serverName)
      );
    } catch (caught) {
      result = { text: getErrorMessage(caught), isError: true };
    } finally {
      endRun(result);
    }
  };
  /**
   * The app of a tool that can write may have changed the settings (the open or its own tool
   * calls): read them again once it closes. The read counts as a run, so Save waits for it.
   */
  const closeApp = async () => {
    setApp(null);
    if (app?.canWrite !== true) return;
    const endRun = props.beginRun();
    try {
      await publishSettingsToolWrite(props.workspaceId, props.serverName);
    } finally {
      endRun(null);
    }
  };
  return { app, closeApp, run };
}
