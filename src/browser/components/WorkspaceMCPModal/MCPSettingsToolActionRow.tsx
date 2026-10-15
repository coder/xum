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
import { useAPI } from "@/browser/contexts/API";
import { useConfirmDialog } from "@/browser/contexts/ConfirmDialogContext";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";
import type {
  MCPSettingsAppView,
  MCPSettingsLayoutItem,
  MCPSettingsToolAction,
} from "@/common/utils/mcpSettings";
import type { SettingsToolRunResult } from "./settingsToolRuns";

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
      {app && <SettingsAppModal workspaceId={props.workspaceId} app={app} onClose={closeApp} />}
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

/**
 * Confirm (a tool that can write), run or open, and keep the latest app. The result goes to the
 * run's end callback (settingsToolRuns keeps it).
 */
function useToolActionRun(
  props: MCPSettingsToolActionRowProps & { action: MCPSettingsToolAction }
) {
  const { api } = useAPI();
  const { confirm } = useConfirmDialog();
  const [app, setApp] = useState<{ view: MCPSettingsAppView; openCount: number } | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const { readOnly, title, opensApp } = props.action;

  const run = async () => {
    if (!api) return;
    // Server text is untrusted: the dialog names the tool and server, nothing the tool claims.
    const confirmed =
      readOnly ||
      (await confirm({
        title: `Run ${title}?`,
        description: `This tool of ${props.serverName} can change data. Run it only if you trust the server.`,
        confirmLabel: "Run",
      }));
    if (!confirmed) return;
    const endRun = props.beginRun();
    let result: SettingsToolRunResult | null = null;
    const request = {
      workspaceId: props.workspaceId,
      serverName: props.serverName,
      toolName: props.item.tool,
      instanceToken: props.instanceToken,
      confirmed: !readOnly,
    };
    try {
      if (opensApp) {
        const response = await api.mcp.settings.openApp(request);
        if (response.success) {
          setApp({ view: response.data, openCount: openCount + 1 });
          setOpenCount(openCount + 1);
        } else result = { text: response.error, isError: true };
      } else {
        const response = await api.mcp.settings.runTool(request);
        result = response.success ? response.data : { text: response.error, isError: true };
      }
    } catch (caught) {
      result = { text: getErrorMessage(caught), isError: true };
    } finally {
      endRun(result);
    }
  };
  return { app, closeApp: () => setApp(null), run };
}
