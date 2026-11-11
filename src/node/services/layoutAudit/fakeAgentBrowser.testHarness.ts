import * as fs from "fs/promises";
import * as path from "path";
import type { LayoutAuditViewportWidth } from "@/common/constants/artifactLayoutAudit";
import { LAYOUT_AUDIT_VIEWPORTS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";

/**
 * A POSIX-sh stand-in for the `agent-browser` CLI, reached the way production reaches the real
 * one: a trusted project's `.xum/tool_env` puts its folder first on PATH. It answers the calls
 * the layout audit makes (`set offline on`, `set viewport`, `open`, `--json eval --stdin`,
 * `close`) and logs every call, so a test sees the exact argv, the opened URLs and the stdin of
 * each eval. For every call it also logs the NAMES of the AGENT_BROWSER_* variables it inherited,
 * and of SHELLOPTS and BASHOPTS (never a value), and the content of the file `--config` names.
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
  /** Shell lines appended to a tool_env that sources, after the PATH line. */
  toolEnvLines?: string[];
  /** `set offline on` exits 1. */
  offlineFails?: boolean;
  /** `open` exits 1. */
  openFails?: boolean;
  /** `close` never answers, like a daemon that is still executing a command. */
  closeHangs?: boolean;
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
  /**
   * Per call, in order: the AGENT_BROWSER_SOCKET_DIR the call saw, and whether that folder
   * existed at the time.
   */
  socketDirs(): Promise<Array<{ dir: string; existed: boolean }>>;
  /**
   * Per call, in order: the names of the AGENT_BROWSER_* variables set in the call's env, and
   * of SHELLOPTS and BASHOPTS (they carry shell options into a new bash).
   */
  agentBrowserEnvNames(): Promise<string[][]>;
  /**
   * Per call, in order: the `--config` path, and its content when the file existed then (the
   * run's folder is gone afterwards).
   */
  configs(): Promise<Array<{ path: string; content: string | undefined }>>;
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
if [ -d "\${AGENT_BROWSER_SOCKET_DIR-}" ]; then existed=yes; else existed=no; fi
printf '%s %s\\n' "$existed" "\${AGENT_BROWSER_SOCKET_DIR-}" >> "$STATE/socket-dirs.log"
env | sed -n -e 's/^\\(AGENT_BROWSER_[A-Za-z0-9_]*\\)=.*/\\1/p' -e 's/^\\(SHELLOPTS\\)=.*/\\1/p' -e 's/^\\(BASHOPTS\\)=.*/\\1/p' | sort | tr '\\n' ' ' >> "$STATE/env-names.log"
printf '\\n' >> "$STATE/env-names.log"
config=
previous=
for arg in "$@"; do
  [ "$previous" = --config ] && config=$arg
  previous=$arg
done
if [ -f "$config" ]; then content=$(cat "$config"); else content=MISSING; fi
printf '%s\\t%s\\n' "$config" "$content" >> "$STATE/configs.log"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session|--config|--idle-timeout) shift 2 ;;
    --json) shift ;;
    *) break ;;
  esac
done
command="$1"
shift
case "$command" in
  set)
    case "$1" in
      offline) [ -f "$STATE/offline-fails" ] && exit 1 ;;
      viewport) printf '%s' "$2" > "$STATE/viewport" ;;
    esac
    ;;
  open)
    [ -f "$STATE/open-fails" ] && exit 1
    printf '%s\\n' "$1" >> "$STATE/opened.log"
    ;;
  close)
    [ -f "$STATE/close-hangs" ] && sleep 60 </dev/null
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
    : [
        `export PATH=${shellQuote(script.missing ? emptyDir : `${binDir}:${process.env.PATH ?? ""}`)}`,
        ...(script.toolEnvLines ?? []),
        "",
      ].join("\n");
  await fs.writeFile(path.join(projectDir, ".xum", "tool_env"), toolEnv);
  if (script.offlineFails) await fs.writeFile(path.join(stateDir, "offline-fails"), "");
  if (script.openFails) await fs.writeFile(path.join(stateDir, "open-fails"), "");
  if (script.closeHangs) await fs.writeFile(path.join(stateDir, "close-hangs"), "");
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
    socketDirs: async () =>
      ((await read("socket-dirs.log")) ?? "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => ({
          existed: line.startsWith("yes "),
          dir: line.slice(line.indexOf(" ") + 1),
        })),
    agentBrowserEnvNames: async () =>
      ((await read("env-names.log")) ?? "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split(" ").filter(Boolean)),
    configs: async () =>
      ((await read("configs.log")) ?? "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [filePath = "", content = ""] = line.split("\t");
          return { path: filePath, content: content === "MISSING" ? undefined : content };
        }),
  };
}
