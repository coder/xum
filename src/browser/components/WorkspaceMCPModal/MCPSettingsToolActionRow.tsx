import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useConfirmDialog } from "@/browser/contexts/ConfirmDialogContext";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";
import type { MCPSettingsLayoutItem, MCPSettingsToolAction } from "@/common/utils/mcpSettings";

interface MCPSettingsToolActionRowProps {
  workspaceId: string;
  serverName: string;
  /** The settings read's instanceToken: the tool must belong to the instance the user saw. */
  instanceToken: string;
  item: Extract<MCPSettingsLayoutItem, { kind: "tool" }>;
}

/**
 * A settings layout tool action (`openai/settings`): a button that calls the server's tool with
 * `{}` and shows the text of its result under the row. The spec shows that text in a tooltip;
 * an inline result also works on touch screens. A tool without `readOnlyHint: true` asks the
 * user first. A tool Xum cannot run (unlisted, not allowed, or an MCP App) stays a disabled row.
 */
export function MCPSettingsToolActionRow(props: MCPSettingsToolActionRowProps) {
  const action = props.item.action;
  if (action === undefined || action.opensApp)
    return (
      <div
        className="text-content-secondary flex items-center justify-between gap-3 text-xs opacity-60"
        aria-disabled="true"
      >
        <span className="min-w-0 wrap-anywhere">{action?.title ?? props.item.tool}</span>
        <span className="shrink-0">
          {action === undefined ? "Not available" : "Opens in a later version"}
        </span>
      </div>
    );
  return <RunnableToolRow {...props} action={action} />;
}

interface ToolRunResult {
  text: string;
  isError: boolean;
}

function RunnableToolRow(props: MCPSettingsToolActionRowProps & { action: MCPSettingsToolAction }) {
  const { running, result, run } = useToolActionRun(props);
  const label = props.action.title;
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
          disabled={running}
          aria-label={`Run ${label}`}
        >
          {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Run
        </Button>
      </div>
      {result && (
        <div
          role="status"
          className={cn(
            "max-h-40 overflow-y-auto text-xs whitespace-pre-wrap wrap-anywhere",
            result.isError ? "text-danger-soft" : "text-content-secondary"
          )}
        >
          {result.text === "" ? "Done" : result.text}
        </div>
      )}
    </div>
  );
}

/** Confirm (a tool that can write), run, and keep the latest result. */
function useToolActionRun(
  props: MCPSettingsToolActionRowProps & { action: MCPSettingsToolAction }
) {
  const { api } = useAPI();
  const { confirm } = useConfirmDialog();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ToolRunResult | null>(null);
  const { readOnly, title } = props.action;

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
    setRunning(true);
    setResult(null);
    try {
      const response = await api.mcp.settings.runTool({
        workspaceId: props.workspaceId,
        serverName: props.serverName,
        toolName: props.item.tool,
        instanceToken: props.instanceToken,
        confirmed: !readOnly,
      });
      setResult(response.success ? response.data : { text: response.error, isError: true });
    } catch (caught) {
      setResult({ text: getErrorMessage(caught), isError: true });
    } finally {
      setRunning(false);
    }
  };
  return { running, result, run };
}
