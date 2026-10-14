import type { MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import {
  auditCacheBusts,
  collapseEnvelopesToFinalPerSequence,
} from "@/node/services/replay/cacheAudit";
import {
  auditRecordedStepPrefixes,
  collectAssistantTurns,
  collectFullHistory,
  type AssistantTurn,
  type TurnEnvelopeEvent,
} from "@/node/services/replay/replayVerify";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { printStepPrefixAudit, resolveReplaySessionDir } from "./replay-verify";

/**
 * Debug command: diff consecutive turn-envelope rows and attribute
 * prompt-prefix cache invalidations (system prompt change, toolset delta,
 * model/thinking/provider-options change), with approximate busted-token
 * attribution from the recorded per-turn usage where available.
 *
 * Usage: bun debug cache-audit <workspace-id>
 * (use the workspace ID "replay-fixture" to run against the committed fixture)
 */
export async function cacheAuditCommand(
  workspaceId: string,
  // Tests pass the real instance they inject a failure into (AGENTS.md: real HistoryService).
  session: ReturnType<typeof resolveReplaySessionDir> = resolveReplaySessionDir(workspaceId)
): Promise<void> {
  const { sessionDir, historyService } = session;
  const journal = new DurableEventJournal(sessionDir);
  const events = await journal.read();
  // Final envelope per sequence only: fallback turns emit a superseding row.
  const envelopes = collapseEnvelopesToFinalPerSequence(
    events.filter((event): event is TurnEnvelopeEvent => event.kind === "turn-envelope")
  );

  console.log(`\n=== Cache-bust audit for workspace: ${workspaceId} ===\n`);
  // Usage pairing: assistant turns come from the FULL history (all compaction
  // epochs, like the envelopes). Envelopes carrying requestHistorySequence
  // join on that key; legacy envelopes fall back to tail alignment (both
  // sequences end at the most recent turn).
  const historyResult = await collectFullHistory(historyService, workspaceId);
  if (envelopes.length === 0) {
    console.log("No turn-envelope rows found in durable-events.jsonl — nothing to audit.");
    // The step audit needs only devtools.jsonl, so older logs without envelopes still get it.
    await printStepAudit(sessionDir, historyResult);
    return;
  }

  const turns = historyResult.success ? collectAssistantTurns(historyResult.data) : [];
  const turnsBySeq = new Map<number, AssistantTurn>(
    turns.map((turn) => [turn.requestHistorySequence, turn])
  );
  const offset = envelopes.length - turns.length;
  const usageByTurn: Array<ChatUsageDisplay | undefined> = envelopes.map((envelope, index) => {
    const turn =
      envelope.data.requestHistorySequence != null
        ? turnsBySeq.get(envelope.data.requestHistorySequence)
        : turns[index - offset];
    const metadata = turn?.message.metadata;
    if (metadata?.usage == null || metadata.model == null) {
      return undefined;
    }
    return createDisplayUsage(
      metadata.usage,
      metadata.model,
      metadata.providerMetadata,
      metadata.metadataModel
    );
  });

  const audit = auditCacheBusts(envelopes, usageByTurn);
  let bustedTurns = 0;
  let bustedTokens = 0;
  for (const turn of audit) {
    const time = new Date(turn.ts).toISOString();
    if (turn.turnIndex === 0) {
      console.log(`turn ${turn.turnIndex}  ${time}  ${turn.modelString}  baseline (first turn)`);
      continue;
    }
    if (turn.causes.length === 0) {
      console.log(`turn ${turn.turnIndex}  ${time}  ${turn.modelString}  prefix stable`);
      continue;
    }
    bustedTurns++;
    const tokens =
      turn.approxBustedTokens !== undefined
        ? `~${turn.approxBustedTokens.toLocaleString()} tokens re-processed`
        : "usage unavailable";
    console.log(`turn ${turn.turnIndex}  ${time}  ${turn.modelString}  CACHE BUST (${tokens})`);
    for (const cause of turn.causes) {
      console.log(`      ${cause.kind}: ${cause.detail}`);
    }
    bustedTokens += turn.approxBustedTokens ?? 0;
  }

  console.log(
    `\n${bustedTurns}/${audit.length - 1} follow-up turns busted the prompt prefix` +
      (bustedTokens > 0 ? ` (~${bustedTokens.toLocaleString()} tokens re-processed)` : "")
  );
  // Envelopes only see prefix inputs (system prompt, tools, model); the step
  // audit also catches history bytes that changed between requests.
  await printStepAudit(sessionDir, historyResult);
}

/**
 * The step audit needs the history: it names the compaction runs to skip. Against an empty
 * history it would audit their prompts as chat turns and report false prefix breaks, so a
 * failed read skips it and reports the error instead.
 */
async function printStepAudit(
  sessionDir: string,
  historyResult: Result<MuxMessage[]>
): Promise<void> {
  if (!historyResult.success) {
    console.error(`\nStep audit skipped: failed to read chat history: ${historyResult.error}`);
    process.exitCode = 1;
    return;
  }
  printStepPrefixAudit(await auditRecordedStepPrefixes(sessionDir, historyResult.data));
}
