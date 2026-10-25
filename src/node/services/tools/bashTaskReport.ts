import assert from "@/common/utils/assert";

function getMarkdownCodeFenceDelimiter(args: { output: string }): string {
  assert(typeof args.output === "string", "output must be a string");

  // Pick a fence longer than any run of backticks in the output so literal ``` lines
  // can't terminate the block early (and lose the remaining output when re-parsing).
  let longestBacktickRun = 0;
  let currentRun = 0;
  for (const char of args.output) {
    if (char === "`") {
      currentRun += 1;
      continue;
    }

    if (currentRun > longestBacktickRun) {
      longestBacktickRun = currentRun;
    }
    currentRun = 0;
  }
  if (currentRun > longestBacktickRun) {
    longestBacktickRun = currentRun;
  }

  const fenceLength = Math.max(3, longestBacktickRun + 1);
  return "`".repeat(fenceLength);
}
export function formatBashOutputReport(args: {
  processId: string;
  status: string;
  exitCode?: number;
  output: string;
}): string {
  assert(typeof args.processId === "string" && args.processId.length > 0, "processId required");
  assert(typeof args.status === "string" && args.status.length > 0, "status required");
  assert(typeof args.output === "string", "output must be a string");

  const lines: string[] = [];

  lines.push(`### Bash task: ${args.processId}`);
  lines.push("");

  lines.push(`status: ${args.status}`);
  if (args.exitCode !== undefined) {
    lines.push(`exitCode: ${args.exitCode}`);
  }

  if (args.output.trim().length > 0) {
    const trimmedOutput = args.output.trimEnd();
    const fence = getMarkdownCodeFenceDelimiter({ output: trimmedOutput });

    lines.push("");
    lines.push(`${fence}text`);
    lines.push(trimmedOutput);
    lines.push(fence);
  }

  return lines.join("\n");
}
