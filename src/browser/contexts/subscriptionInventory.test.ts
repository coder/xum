import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Every renderer file that opens a server stream (an `eventIterator` procedure) must say how the
 * stream starts again after Xum reconnects. A stream dies with its socket. A holder that keeps a
 * client outside React deps (a store, a router, a ref) and has no restart rule leaves a dead
 * subscription with no error on screen.
 *
 * A new holder fails this test until its file is listed here with its rule.
 */
type RestartRule =
  /** The stream is opened in an effect with `api` in its deps: a new client re-runs it. */
  | "effect-deps"
  /** A store fed through setClient(): it drops the client while offline and resubscribes. */
  | "store-live-feed"
  /** The terminal router: setClient() restarts its streams on each new client. */
  | "router-setClient"
  /** A long-lived holder with its own capped backoff. */
  | "holder-backoff"
  /** One operation's progress stream (a clone): it is not restarted, the operation fails. */
  | "operation-stream"
  /** Reads the procedure only to check that the server supports it. */
  | "capability-check";

const RESTART_RULES: Record<string, RestartRule> = {
  "src/browser/App.tsx": "effect-deps",
  "src/browser/components/OutputTab/OutputTab.tsx": "effect-deps",
  "src/browser/components/PerfFlightRecorder/PerfFlightRecorder.tsx": "effect-deps",
  "src/browser/components/ProjectCreateModal/ProjectCreateModal.tsx": "operation-stream",
  "src/browser/components/ProjectPage/ProjectPage.tsx": "effect-deps",
  "src/browser/components/SshPromptDialog/SshPromptDialog.tsx": "effect-deps",
  "src/browser/components/TerminalView/TerminalView.tsx": "effect-deps",
  "src/browser/components/TitleBar/TitleBar.tsx": "effect-deps",
  "src/browser/components/UpdateRestartOverlay/UpdateRestartOverlay.tsx": "effect-deps",
  "src/browser/contexts/ProjectContext.tsx": "effect-deps",
  "src/browser/contexts/WorkspaceContext.tsx": "effect-deps",
  "src/browser/features/About/AboutDialog.tsx": "effect-deps",
  "src/browser/features/ChatInput/index.tsx": "effect-deps",
  "src/browser/features/Memory/MemoryBrowser.tsx": "effect-deps",
  "src/browser/features/RightSidebar/DevToolsTab/useDevToolsSubscription.ts": "effect-deps",
  "src/browser/features/RightSidebar/Workflows/useWorkflowRuns.ts": "effect-deps",
  "src/browser/features/Settings/Sections/BackupSection.tsx": "effect-deps",
  "src/browser/features/Settings/Sections/GeneralSection.tsx": "effect-deps",
  "src/browser/features/Tools/WorkflowRunToolCall.tsx": "capability-check",
  "src/browser/features/desktop/useDesktopConnection.ts": "holder-backoff",
  "src/browser/hooks/useAutoModelRouting.ts": "effect-deps",
  "src/browser/hooks/useClaudeDesign.ts": "effect-deps",
  "src/browser/hooks/useComputerUse.ts": "effect-deps",
  "src/browser/hooks/useModelFallbacks.ts": "effect-deps",
  "src/browser/stores/AppConfigStore.ts": "store-live-feed",
  "src/browser/stores/BackgroundBashStore.ts": "store-live-feed",
  "src/browser/stores/DraftStore.ts": "store-live-feed",
  "src/browser/stores/ProvidersConfigStore.ts": "store-live-feed",
  "src/browser/stores/ReviewStateStore.ts": "store-live-feed",
  "src/browser/stores/WorkspaceStore.ts": "store-live-feed",
  "src/browser/terminal/TerminalSessionRouter.ts": "router-setClient",
};

/**
 * The code shape each rule needs, so a listed file cannot claim a rule its code does not follow.
 * These are structural checks; the reconnect tests of each holder prove the behavior.
 */
const RULE_SHAPES: Record<RestartRule, { describe: string; matches: (text: string) => boolean }> = {
  "effect-deps": {
    describe: "a useEffect with `api` in its dependency list",
    matches: (text) => text.includes("useEffect(") && /\[[^\]]*\bapi\b[^\]]*\]\s*\)/.test(text),
  },
  "store-live-feed": {
    describe: "a setClient(client) method that the app feeds with the live client",
    matches: (text) => /\bsetClient\s*\(\s*\w+\s*:/.test(text),
  },
  "router-setClient": {
    describe: "a setClient(api) method that restarts the streams",
    matches: (text) => /\bsetClient\s*\(\s*api\s*:/.test(text),
  },

  "holder-backoff": {
    describe: "a retry with a delay",
    matches: (text) => text.includes("setTimeout(") && /backoff|retry/i.test(text),
  },
  "operation-stream": {
    describe: "one operation's stream (no restart by design)",
    matches: () => true,
  },
  "capability-check": {
    describe: "a typeof check of the procedure",
    matches: (text) => /typeof [^\n]*=== "function"/.test(text),
  },
};

const SCHEMA_PATH = "src/common/orpc/schemas/api.ts";

/** Paths of every procedure whose output is `eventIterator(...)`, e.g. ["terminal", "onExit"]. */
function streamProcedures(): string[][] {
  const source = ts.createSourceFile(
    SCHEMA_PATH,
    readFileSync(SCHEMA_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const paths: string[][] = [];
  const isStreamOutput = (property: ts.ObjectLiteralElementLike) =>
    ts.isPropertyAssignment(property) &&
    property.name.getText(source) === "output" &&
    ts.isCallExpression(property.initializer) &&
    property.initializer.expression.getText(source) === "eventIterator";
  const walk = (object: ts.ObjectLiteralExpression, prefix: string[]) => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (!ts.isObjectLiteralExpression(property.initializer)) continue;
      const path = [...prefix, property.name.getText(source)];
      if (property.initializer.properties.some(isStreamOutput)) paths.push(path);
      else walk(property.initializer, path);
    }
  };
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
        walk(declaration.initializer, [declaration.name.getText(source)]);
      }
    }
  }
  return paths;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches a read of the procedure: `api.terminal.onExit`, `api?.config?.onConfigChanged`, across
 * line breaks. A procedure whose name is not generic also matches alone, because callers read it
 * through a local first (`configApi?.onConfigChanged`).
 */
function accessPattern(path: string[]): RegExp {
  const separator = "\\s*\\??\\.\\s*";
  const full = "\\??\\." + "\\s*" + path.map(escape).join(separator) + "\\b";
  const leaf = path[path.length - 1];
  // Names that are also common props or methods (`onChange`, `onExit`) match only as a full path.
  const generic = [
    "subscribe",
    "attach",
    "clone",
    "onChange",
    "onExit",
    "onStatus",
    "onOutput",
    "onOpenSettings",
  ];
  return generic.includes(leaf)
    ? new RegExp(full)
    : new RegExp(`${full}|\\??\\.\\s*${escape(leaf)}\\b`);
}

function rendererSources(): string[] {
  return execFileSync("git", ["ls-files", "src/browser", "vscode/src/webview"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !/\.(test|stories|testHarness)\.tsx?$/.test(file))
    .filter((file) => !file.includes("/stories/") && file !== "src/browser/testUtils.ts");
}

describe("server stream holders", () => {
  const procedures = streamProcedures();
  const patterns = procedures.map(accessPattern);
  const holders = rendererSources().filter((file) => {
    const text = readFileSync(file, "utf8");
    return patterns.some((pattern) => pattern.test(text));
  });

  test("the schema scan finds the stream procedures", () => {
    // A guard for the scan itself: if it finds nothing, every other check passes vacuously.
    expect(procedures.length).toBeGreaterThan(20);
    expect(procedures).toContainEqual(["terminal", "onExit"]);
  });

  test("every file that opens a server stream has a restart rule", () => {
    const unlisted = holders.filter((file) => !(file in RESTART_RULES));
    expect(unlisted).toEqual([]);
  });

  test("every listed file has the code shape of its rule", () => {
    const mismatched = Object.entries(RESTART_RULES)
      .filter(([file, rule]) => !RULE_SHAPES[rule].matches(readFileSync(file, "utf8")))
      .map(([file, rule]) => `${file}: "${rule}" needs ${RULE_SHAPES[rule].describe}`);
    expect(mismatched).toEqual([]);
  });

  test("every listed file still opens a server stream", () => {
    const stale = Object.keys(RESTART_RULES).filter((file) => !holders.includes(file));
    expect(stale).toEqual([]);
  });
});
