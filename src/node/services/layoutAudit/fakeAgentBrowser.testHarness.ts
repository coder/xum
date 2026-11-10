import * as fs from "fs/promises";
import * as path from "path";
import type { LayoutAuditViewportWidth } from "@/common/constants/artifactLayoutAudit";
import { LAYOUT_AUDIT_VIEWPORTS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";

/**
 * A POSIX-sh stand-in for the `agent-browser` CLI, reached the way production reaches the real
 * one: a trusted project's `.xum/tool_env` puts its folder first on PATH. It answers the five
 * calls the layout audit makes (`set viewport`, `open`, `--json eval --stdin`, `close`) and logs
 * every call, so a test sees the exact argv, the opened URLs and the stdin of each eval.
 */

/** What `eval` prints and returns for one width. The default is a clean, complete pass. */
export type FakeEvalReply =
  | {
      kind: "pass";
      complete?: boolean;
      viewportWidth?: number;
      findings?: LayoutAuditPageFinding[];
    }
  /** A value that succeeds in the CLI but is not a page result (the audit must reject it). */
  | { kind: "result"; result: unknown }
  /** The page script threw: exit 1 and a failed JSON envelope. */
  | { kind: "throw"; message: string }
  /** Never answers, and writes `hang-started` first so a test can wait for the call. */
  | { kind: "hang" }
  /** Exit 0 and not JSON. */
  | { kind: "garbage" };

export interface FakeAgentBrowserScript {
  /** tool_env leaves PATH without agent-browser. */
  missing?: boolean;
  /** tool_env fails to source. */
  toolEnvFails?: boolean;
  /** `open` exits 1. */
  openFails?: boolean;
  eval?: Partial<Record<LayoutAuditViewportWidth, FakeEvalReply>>;
}

export interface FakeAgentBrowser {
  /** The argv of every call, in order. */
  calls(): Promise<string[][]>;
  /** The URL of every `open`. */
  openedUrls(): Promise<string[]>;
  /** What the eval for this width received on stdin, or undefined when it never ran. */
  evalStdin(width: LayoutAuditViewportWidth): Promise<string | undefined>;
  /** True once an eval in `hang` mode has started. */
  hangStarted(): Promise<boolean>;
}

// The fake ends every argv field with this byte (octal 037 in its printf).
const ARG_SEPARATOR = "\u001f";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envelopeFor(reply: FakeEvalReply, width: number): { out: string; exit: number } {
  switch (reply.kind) {
    case "pass":
      return {
        exit: 0,
        out: JSON.stringify({
          success: true,
          data: {
            lifecycle: {},
            origin: "file:///fake.html",
            result: {
              complete: reply.complete ?? true,
              viewportWidth: reply.viewportWidth ?? width,
              findings: reply.findings ?? [],
            },
          },
          error: null,
        }),
      };
    case "result":
      return {
        exit: 0,
        out: JSON.stringify({ success: true, data: { result: reply.result }, error: null }),
      };
    case "throw":
      return {
        exit: 1,
        out: JSON.stringify({
          success: false,
          data: null,
          error: `Evaluation error: Error: ${reply.message}\n    at <anonymous>:1:1`,
        }),
      };
    case "garbage":
      return { exit: 0, out: "Segmentation fault (not JSON)" };
    case "hang":
      return { exit: 0, out: "" };
  }
}

function fakeScript(stateDir: string): string {
  return `#!/bin/sh
STATE=${shellQuote(stateDir)}
printf '%s\\037' "$@" >> "$STATE/calls.log"
printf '\\n' >> "$STATE/calls.log"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --namespace|--session|--headed|--idle-timeout) shift 2 ;;
    --json) shift ;;
    *) break ;;
  esac
done
command="$1"
shift
case "$command" in
  set)
    printf '%s' "$2" > "$STATE/viewport"
    ;;
  open)
    [ -f "$STATE/open-fails" ] && exit 1
    printf '%s\\n' "$1" >> "$STATE/opened.log"
    ;;
  eval)
    width=$(cat "$STATE/viewport")
    cat > "$STATE/eval-stdin-$width"
    if [ -f "$STATE/eval-$width.hang" ]; then
      : > "$STATE/hang-started"
      sleep 60 </dev/null
    fi
    cat "$STATE/eval-$width.out"
    exit "$(cat "$STATE/eval-$width.exit")"
    ;;
esac
exit 0
`;
}

/**
 * Installs the fake under `projectDir` and returns handles to its logs. Safe to call again for
 * the same dir: it starts from empty state. Refuses when the project-automation kill switch is
 * on, because tool_env would then not run and a test would reach the machine's real
 * agent-browser.
 */
export async function installFakeAgentBrowser(
  projectDir: string,
  script: FakeAgentBrowserScript = {}
): Promise<FakeAgentBrowser> {
  if (projectAutomationDisabled()) {
    throw new Error(
      "project automation is disabled: tool_env would not run, so the fake is unreachable"
    );
  }
  const binDir = path.join(projectDir, "fake-bin");
  const emptyDir = path.join(projectDir, "fake-empty-bin");
  const stateDir = path.join(projectDir, "fake-state");
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(path.join(projectDir, ".xum"), { recursive: true });
  await Promise.all([binDir, emptyDir, stateDir].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(binDir, "agent-browser"), fakeScript(stateDir), { mode: 0o755 });
  const toolEnv = script.toolEnvFails
    ? "return 1\n"
    : `export PATH=${shellQuote(script.missing ? emptyDir : `${binDir}:${process.env.PATH ?? ""}`)}\n`;
  await fs.writeFile(path.join(projectDir, ".xum", "tool_env"), toolEnv);
  if (script.openFails) await fs.writeFile(path.join(stateDir, "open-fails"), "");
  for (const { width } of LAYOUT_AUDIT_VIEWPORTS) {
    const reply = script.eval?.[width] ?? { kind: "pass" };
    const { out, exit } = envelopeFor(reply, width);
    await fs.writeFile(path.join(stateDir, `eval-${width}.out`), out);
    await fs.writeFile(path.join(stateDir, `eval-${width}.exit`), String(exit));
    if (reply.kind === "hang") await fs.writeFile(path.join(stateDir, `eval-${width}.hang`), "");
  }
  const read = (name: string) =>
    fs.readFile(path.join(stateDir, name), "utf8").catch(() => undefined);
  return {
    calls: async () =>
      ((await read("calls.log")) ?? "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split(ARG_SEPARATOR).slice(0, -1)),
    openedUrls: async () => ((await read("opened.log")) ?? "").split("\n").filter(Boolean),
    evalStdin: (width) => read(`eval-stdin-${width}`),
    hangStarted: async () => (await read("hang-started")) !== undefined,
  };
}
