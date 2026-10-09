import React from "react";
import { MessagesSquare, Terminal as TerminalIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { formatKeybind, KEYBINDS, type Keybind } from "@/browser/utils/ui/keybinds";
import { TAB_REGISTRY, type BaseTabType } from "./Tabs";

/** Tools with a global shortcut of their own; the launcher shows it as a hint. */
const TOOL_KEYBINDS: Partial<Record<BaseTabType, Keybind>> = {
  artifacts: KEYBINDS.OPEN_ARTIFACTS_TAB,
};

interface NewTabLauncherProps {
  /** Tools this workspace can open, in launcher order (already filtered for availability). */
  tools: BaseTabType[];
  onOpenTool: (tool: BaseTabType) => void;
  onOpenTerminal: () => void;
  onOpenSideChat?: () => void;
  creatingSideChat: boolean;
  /**
   * Focus the first row once shown. Set only when the user asked for a New tab ("+" or the
   * shortcut), never for the New tab a fresh workspace starts with, so the launcher does not
   * steal focus from the chat input.
   */
  autoFocus: boolean;
  onAutoFocusConsumed: () => void;
}

/**
 * The New tab (Codex-style empty tab): instead of showing every tool as an idle tab, the strip
 * holds only open tabs, and this panel lists what a pane can show. Picking a row replaces the
 * New tab with that tool.
 */
export const NewTabLauncher: React.FC<NewTabLauncherProps> = (props) => {
  const listRef = React.useRef<HTMLDivElement>(null);
  const { autoFocus, onAutoFocusConsumed } = props;

  // Moving DOM focus is a side effect on the rendered rows, so it runs after commit.
  React.useEffect(() => {
    if (!autoFocus) return;
    listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    onAutoFocusConsumed();
  }, [autoFocus, onAutoFocusConsumed]);

  // Arrow keys move between rows (Tab works too, since every row is a button).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
    );
    if (rows.length === 0) return;
    e.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % rows.length;
    else next = current <= 0 ? rows.length - 1 : current - 1;
    rows[next].focus();
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-4">
      <div className="px-2">
        <h2 className="text-foreground text-sm font-medium">Open a tool</h2>
        <p className="text-muted mt-0.5 text-xs">Pick what this pane shows.</p>
      </div>
      <div ref={listRef} className="flex flex-col gap-0.5" onKeyDown={handleKeyDown}>
        {props.tools.map((tool) => {
          const reg = TAB_REGISTRY[tool];
          const keybind = TOOL_KEYBINDS[tool];
          return (
            <LauncherRow
              key={tool}
              Icon={reg.Icon}
              name={reg.name}
              description={reg.description}
              shortcut={keybind ? formatKeybind(keybind) : undefined}
              onClick={() => props.onOpenTool(tool)}
            />
          );
        })}
        <LauncherRow
          Icon={TerminalIcon}
          name="Terminal"
          description="Run commands in this workspace"
          shortcut={formatKeybind(KEYBINDS.OPEN_TERMINAL)}
          onClick={props.onOpenTerminal}
        />
        {props.onOpenSideChat != null && (
          <LauncherRow
            Icon={MessagesSquare}
            name="Side chat"
            description="Ask separately with this conversation as context"
            shortcut="/side"
            onClick={props.onOpenSideChat}
            disabled={props.creatingSideChat}
          />
        )}
      </div>
    </div>
  );
};

const LauncherRow: React.FC<{
  Icon: LucideIcon;
  name: string;
  description: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}> = (props) => {
  // The tool name is the row's accessible name; the description is read as its description.
  const descriptionId = React.useId();
  return (
    <button
      type="button"
      aria-label={props.name}
      aria-describedby={descriptionId}
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "group flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-2 text-left transition-colors",
        "hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
      )}
    >
      <props.Icon
        className="text-muted group-hover:text-foreground mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-xs font-medium">{props.name}</span>
        <span id={descriptionId} className="text-muted text-[11px] leading-snug">
          {props.description}
        </span>
      </span>
      {props.shortcut != null && (
        <kbd className="mobile-hide-shortcut-hints text-muted mt-0.5 shrink-0 font-sans text-[10px] max-[768px]:hidden">
          {props.shortcut}
        </kbd>
      )}
    </button>
  );
};
