import type { ReactElement } from "react";
import { Radar } from "lucide-react";
import type { BashMonitorWakeDisplayRecord, DisplayedMessage } from "@/common/types/message";
import { CollapsibleMachineMessage } from "./CollapsibleMachineMessage";

interface BashMonitorWakeMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
}

function summarizeTerminal(record: BashMonitorWakeDisplayRecord): string {
  const terminal = record.terminal;
  if (terminal == null) return `${record.displayName} monitor matched`;
  switch (terminal.status) {
    case "exited":
      return terminal.exitCode != null
        ? `${record.displayName} exited (code ${terminal.exitCode})`
        : `${record.displayName} exited`;
    case "killed":
      return `${record.displayName} killed`;
    case "failed":
      return `${record.displayName} failed`;
  }
}

function summarizeRecords(records: BashMonitorWakeDisplayRecord[]): string {
  if (records.length === 1) {
    const record = records[0];
    return record.kind === "monitor-lost"
      ? `${record.displayName} monitor stopped after restart`
      : summarizeTerminal(record);
  }

  const matchRecords = records.filter((record) => record.kind === "match");
  if (matchRecords.length === records.length) {
    if (matchRecords.every((record) => record.terminal != null)) {
      return `${records.length} background processes finished`;
    }
    if (matchRecords.some((record) => record.terminal != null)) {
      return `${records.length} background monitor updates`;
    }
    return `${records.length} background monitors matched`;
  }
  if (matchRecords.length === 0) {
    return `${records.length} background monitors stopped after restart`;
  }
  return `${records.length} background monitor updates`;
}

/**
 * Monitor wakes are machine-authored events, not user prompts. Keep them visible
 * for transcript continuity without giving them a full user bubble, metadata row,
 * or duplicate status badge. Right-align the compact wake like the user-side event that
 * resumed the turn, while keeping the model-facing prompt available on demand.
 */
export function BashMonitorWakeMessage(props: BashMonitorWakeMessageProps): ReactElement {
  const records = props.message.bashMonitorWake?.records ?? [];

  return (
    <CollapsibleMachineMessage
      content={props.message.content}
      summary={summarizeRecords(records)}
      icon={<Radar aria-hidden="true" className="size-3.5 shrink-0" />}
      marker="bash-monitor-wake"
      className={props.className}
    />
  );
}
