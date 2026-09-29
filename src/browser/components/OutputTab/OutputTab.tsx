import { type UIEvent, useEffect, useReducer, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { isAbortError } from "@/browser/utils/isAbortError";
import { MAX_LOG_ENTRIES } from "@/common/constants/ui";
import { OUTPUT_TAB_LEVEL_KEY } from "@/common/constants/storage";

type LogLevel = "error" | "warn" | "info" | "debug";

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  location: string;
}

type LogStreamEvent =
  | { type: "snapshot"; epoch: number; entries: LogEntry[] }
  | { type: "append"; epoch: number; entries: LogEntry[] }
  | { type: "reset"; epoch: number };

interface LogState {
  epoch: number;
  entries: LogEntry[];
}

function reduceLogState(state: LogState, event: LogStreamEvent): LogState {
  switch (event.type) {
    case "snapshot":
      return {
        epoch: event.epoch,
        entries: event.entries,
      };
    case "append": {
      if (event.epoch !== state.epoch) {
        return state;
      }
      const merged = [...state.entries, ...event.entries];
      return {
        epoch: state.epoch,
        entries: merged.length > MAX_LOG_ENTRIES ? merged.slice(-MAX_LOG_ENTRIES) : merged,
      };
    }
    case "reset":
      return {
        epoch: event.epoch,
        entries: [],
      };
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

interface OutputTabProps {
  // Required by the RightSidebar tab system, even though the log stream itself is global.
  workspaceId: string;
}

export function OutputTab(_props: OutputTabProps) {
  const { api } = useAPI();

  const [logState, dispatch] = useReducer(reduceLogState, {
    epoch: 0,
    entries: [],
  });
  const [levelFilter, setLevelFilter] = usePersistedState<LogLevel>(OUTPUT_TAB_LEVEL_KEY, "info");
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!api) return;

    const controller = new AbortController();
    const { signal } = controller;

    let iterator: AsyncIterator<LogStreamEvent> | null = null;

    void (async () => {
      try {
        const subscribedIterator = await api.general.subscribeLogs(
          { level: levelFilter },
          { signal }
        );

        // oRPC iterators don’t eagerly close. If we’re already aborted, explicitly close.
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const event of subscribedIterator) {
          if (signal.aborted) break;
          dispatch(event);
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        console.warn("Log subscription error:", error);
      }
    })();

    return () => {
      controller.abort();
      void iterator?.return?.();
    };
  }, [api, levelFilter]);

  // Auto-scroll on new entries when the user is at the bottom.
  useEffect(() => {
    if (!autoScroll) return;
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logState.entries, autoScroll]);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setAutoScroll(isAtBottom);
  };

  const handleDelete = () => {
    if (!api) {
      dispatch({ type: "reset", epoch: 0 });
      return;
    }

    api.general
      .clearLogs()
      .then((result) => {
        if (!result.success) {
          console.warn("Log files could not be fully deleted:", result.error);
        }
      })
      .catch((error) => {
        console.warn("Failed to delete logs:", error);
      });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex items-center gap-2 border-b px-3 py-1.5">
        <LevelFilterDropdown value={levelFilter} onChange={setLevelFilter} />
        <button
          type="button"
          className="text-muted hover:text-foreground hover:bg-hover flex h-6 w-6 items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
          onClick={handleDelete}
          title="Delete"
          aria-label="Delete output logs"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs"
      >
        {logState.entries.map((entry, i) => (
          <LogLine key={i} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function LevelFilterDropdown(props: { value: LogLevel; onChange: (level: LogLevel) => void }) {
  return (
    <label className="text-muted flex items-center gap-2 text-xs">
      <span>Level</span>
      <select
        className="border-border bg-background-secondary hover:bg-hover h-7 rounded border px-2 py-1 text-xs"
        value={props.value}
        onChange={(e) => {
          const next = e.currentTarget.value;
          if ((LOG_LEVELS as readonly string[]).includes(next)) {
            props.onChange(next as LogLevel);
          }
        }}
      >
        {LOG_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </label>
  );
}

function LogLine(props: { entry: LogEntry }) {
  const { entry } = props;

  const levelColor: string =
    entry.level === "error"
      ? "var(--color-error)"
      : entry.level === "warn"
        ? "var(--color-warning)"
        : entry.level === "debug"
          ? "var(--color-muted-foreground)"
          : "var(--color-foreground)";

  // Inline flow layout — wraps naturally at any panel width instead of
  // forcing fixed-width columns that crush the message content.
  return (
    <div className="hover:bg-hover px-3 py-0.5 break-words">
      <span className="text-muted-foreground">{formatTime(entry.timestamp)}</span>{" "}
      <span style={{ color: levelColor }}>{entry.level.toUpperCase()}</span>{" "}
      <span className="text-muted-foreground">[{shortenLocation(entry.location)}]</span>{" "}
      <span>{entry.message}</span>
    </div>
  );
}

/** Strip common path prefixes to show just the meaningful part. e.g.
 *  "src/node/services/log.ts:486" → "log.ts:486"
 *  "/home/user/.mux/src/cmux/.../log.ts:486" → "log.ts:486"  */
function shortenLocation(location: string): string {
  // Grab the last path segment (filename:line)
  const lastSlash = location.lastIndexOf("/");
  if (lastSlash >= 0) {
    return location.slice(lastSlash + 1);
  }
  return location;
}

function formatTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
