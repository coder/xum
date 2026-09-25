/**
 * Print the chat-switch median table (#4504) from perf.chatSwitch.spec.ts artifacts.
 *
 * Usage: bun scripts/perf/chatSwitchTable.ts <perf-summary.json | directory>...
 * Directories are searched recursively. Medians are taken over every switch of every run,
 * so pass all runs of one build (e.g. five `--repeat-each` runs) to get a before/after column.
 * Run those repeats with `--workers 1`: Playwright otherwise starts one Electron app per worker
 * in parallel, and the contention changes the numbers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  renderChatSwitchMarkdownTable,
  type ChatSwitchRecord,
} from "../../tests/e2e/utils/chatSwitchSummary";

function collectSummaryFiles(inputPath: string): string[] {
  if (!statSync(inputPath).isDirectory()) return [inputPath];
  return readdirSync(inputPath).flatMap((name) => {
    const childPath = join(inputPath, name);
    if (statSync(childPath).isDirectory()) return collectSummaryFiles(childPath);
    return name === "perf-summary.json" ? [childPath] : [];
  });
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("Usage: bun scripts/perf/chatSwitchTable.ts <perf-summary.json | directory>...");
  process.exit(2);
}

let runCount = 0;
const switches: ChatSwitchRecord[] = [];
for (const file of inputs.flatMap(collectSummaryFiles)) {
  const summary = JSON.parse(readFileSync(file, "utf-8")) as {
    chatSwitch?: { switches: ChatSwitchRecord[] };
  };
  if (!summary.chatSwitch) continue;
  runCount += 1;
  switches.push(...summary.chatSwitch.switches);
}
if (runCount === 0) {
  console.error("No perf-summary.json with a chatSwitch section found");
  process.exit(1);
}

console.log(`Runs: ${runCount}, switches: ${switches.length}\n`);
console.log(renderChatSwitchMarkdownTable(switches));
