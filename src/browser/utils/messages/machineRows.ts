import type { DisplayedMessage } from "@/common/types/message";
import {
  classifyStatusPageTurnEndNudgePrompt,
  classifyTodoTurnEndNudgePrompt,
} from "@/common/utils/machineTurnPrompts";
import { parseSubagentFailureEnvelope } from "@/common/utils/subagentFailureEnvelope";
import { parseSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { getBackgroundWorkWakeSummary } from "@/browser/features/Messages/BackgroundWorkWakeMessage";

type UserRow = DisplayedMessage & { type: "user" };

/** Rows are immutable per message version, so the answer for a row object never changes. */
const machineRowCache = new WeakMap<DisplayedMessage, boolean>();

/** The checks MessageRenderer and UserMessage use to pick a machine presentation for a prompt. */
function isMachineAuthoredPrompt(content: string): boolean {
  return (
    getBackgroundWorkWakeSummary(content) !== null ||
    classifyTodoTurnEndNudgePrompt(content) !== null ||
    classifyStatusPageTurnEndNudgePrompt(content) !== null ||
    parseSubagentReportEnvelope(content) !== null ||
    parseSubagentFailureEnvelope(content) !== null
  );
}

function classifyUserRow(message: UserRow): boolean {
  if (
    message.contextBudgetWarning != null ||
    message.bashMonitorWake != null ||
    message.agentPeerMessageTrigger != null
  ) {
    return true;
  }
  // Only backend-authored rows qualify: a user who types a lookalike keeps a user bubble.
  return message.isSynthetic === true && isMachineAuthoredPrompt(message.content);
}

/**
 * Whether a user-role row was written by the machine in the middle of the agent's work: a
 * wake-up for finished background work, a turn-end nudge, a context warning, a sub-agent's
 * report. The model receives these as prompts, but the user did not say them, so the transcript
 * treats them as steps of the work: they render as tool-like rows and fold behind the work line.
 *
 * A goal continuation or a budget wrap-up is not one: it starts a turn the way a prompt does.
 */
export function isMachineRow(message: DisplayedMessage | undefined): message is UserRow {
  if (message?.type !== "user") {
    return false;
  }
  let cached = machineRowCache.get(message);
  if (cached === undefined) {
    cached = classifyUserRow(message);
    machineRowCache.set(message, cached);
  }
  return cached;
}
