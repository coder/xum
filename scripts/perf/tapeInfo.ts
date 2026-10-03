/**
 * Describe a session tape (experiment `sessionTapes`) without printing any of its content.
 *
 * Usage: bun scripts/perf/tapeInfo.ts [--allow-truncated] <tape.jsonl>
 *
 * Prints the loader status, header fields, event counts by type, total event bytes, duration
 * and how the tape ended. Exits 1 when the loader rejects the tape (truncated tapes too, unless
 * `--allow-truncated`), 2 on usage errors. Tapes hold full chat content: event payloads are never
 * printed, only counts and the onChat event types.
 */
import { parseArgs } from "node:util";
import { summarizeSessionTape } from "@/common/utils/sessionTapes/sessionTapeLoader";
import type { SessionTapeHeader, SessionTapeTrailer } from "@/common/types/sessionTape";
import { readSessionTapeFile } from "@/node/services/sessionTapes/sessionTapeFile";

const USAGE = "Usage: bun scripts/perf/tapeInfo.ts [--allow-truncated] <tape.jsonl>";

function printHeader(header: SessionTapeHeader): void {
  const { batchReplay, replayWindow, validateOutput } = header.subscription;
  console.log(`version:          ${header.tape} (masking: ${header.masking})`);
  console.log(`tapeId:           ${header.tapeId}`);
  console.log(`workspaceIdHash:  ${header.workspaceIdHash}`);
  console.log(`startedAt:        ${header.startedAt}`);
  console.log(`xumVersion:       ${header.xumVersion}`);
  console.log(
    `subscription:     batchReplay=${String(batchReplay ?? false)} ` +
      `replayWindow=${String(replayWindow ?? false)} validateOutput=${String(validateOutput)}`
  );
}

function printEnd(trailer: SessionTapeTrailer): void {
  const { reason, truncated, droppedEvents } = trailer.end;
  console.log(
    `end:              ${reason} (truncated: ${String(truncated)}, dropped events: ${droppedEvents})`
  );
}

function parseCli(): { filePath: string; allowTruncated: boolean } | undefined {
  try {
    const { values, positionals } = parseArgs({
      options: { "allow-truncated": { type: "boolean" } },
      allowPositionals: true,
    });
    if (positionals.length !== 1) return undefined;
    return { filePath: positionals[0], allowTruncated: values["allow-truncated"] === true };
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const cli = parseCli();
  if (!cli) {
    console.error(USAGE);
    return 2;
  }
  const { filePath, allowTruncated } = cli;
  const result = await readSessionTapeFile(filePath, { allowTruncated });

  console.log(`file:             ${filePath}`);
  if (result.status === "rejected") {
    const where = result.line === undefined ? "" : ` (line ${result.line})`;
    console.log(`status:           rejected: ${result.reason}${where}`);
    if (result.header) printHeader(result.header);
    if (result.trailer) printEnd(result.trailer);
    return 1;
  }

  const summary = summarizeSessionTape(result);
  const flag =
    result.status === "stopped"
      ? " (ends at an explicit stop)"
      : result.status === "truncated"
        ? " (size cap hit: a gap-free prefix, not a complete session)"
        : "";
  console.log(`status:           ${result.status}${flag}`);
  printHeader(result.header);
  printEnd(result.trailer);
  console.log(`events:           ${summary.eventCount}`);
  console.log(`event bytes:      ${summary.totalBytes}`);
  console.log(`duration:         ${summary.durationMs.toFixed(1)} ms`);
  console.log("events by type:");
  for (const [type, count] of Object.entries(summary.countsByType).sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b)
  )) {
    console.log(`  ${type.padEnd(28)} ${count}`);
  }
  return 0;
}

process.exitCode = await main();
