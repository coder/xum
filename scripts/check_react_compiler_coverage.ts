#!/usr/bin/env bun
/**
 * Fails when a hot renderer component or hook stops compiling under React Compiler.
 *
 * Why: the compiler silently skips a whole function when it meets something it
 * can't handle (an `eslint-disable react-hooks/*`, a ref read during render,
 * try/finally, `??=`, ...), even inside a nested closure. AGENTS.md tells
 * contributors not to hand-memoize, so a skipped component ends up with no
 * memoization at all and nothing warns about it. This guard keeps the hot path
 * compiled.
 *
 * Usage: bun scripts/check_react_compiler_coverage.ts   (or `make check-react-compiler`)
 */
import assert from "node:assert/strict";
import path from "node:path";
import { transformFileSync, type NodePath, type PluginObj, type types as t } from "@babel/core";
import { reactCompilerConfig } from "../src/vite/reactCompilerConfig";

/**
 * Components and hooks that render on hot paths: per keystroke in the composer,
 * per stream delta in the transcript, per row in the sidebar, or per review hunk.
 * Names are the function name, or the variable a function (optionally wrapped
 * in memo/forwardRef calls) is assigned to.
 */
const HOT_COMPONENTS: Record<string, readonly string[]> = {
  "src/browser/features/ChatInput/index.tsx": ["ChatInputInner"],
  "src/browser/features/ChatInput/CreationControls.tsx": ["CreationControls"],
  "src/browser/components/ChatPane/ChatPane.tsx": ["ChatPaneContent"],
  "src/browser/features/Messages/MessageRenderer.tsx": ["MessageRenderer"],
  "src/browser/features/Messages/MessageWindow.tsx": ["MessageWindow"],
  "src/browser/features/Messages/AssistantMessage.tsx": ["AssistantMessage"],
  "src/browser/features/Messages/UserMessage.tsx": ["UserMessage"],
  "src/browser/features/Messages/ToolMessage.tsx": ["ToolMessage"],
  "src/browser/features/Messages/ReasoningMessage.tsx": ["ReasoningMessage"],
  "src/browser/features/Messages/MarkdownCore.tsx": ["MarkdownCore"],
  "src/browser/components/ProjectSidebar/ProjectSidebar.tsx": ["ProjectSidebarInner"],
  "src/browser/components/AgentListItem/AgentListItem.tsx": ["AgentListItemInner"],
  "src/browser/components/AppLoader/AppLoader.tsx": [
    "AppLoader",
    "AppLoaderInner",
    "UserPreferencesStartupGate",
  ],
  "src/browser/features/RightSidebar/RightSidebar.tsx": ["RightSidebarComponent"],
  "src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx": ["ReviewPanel"],
  "src/browser/features/RightSidebar/CodeReview/ImmersiveReviewView.tsx": ["ImmersiveReviewView"],
};

/**
 * Baseline of hot components the compiler skips today, keyed `file#name`.
 * This list may only shrink: the guard fails when a listed component compiles,
 * so fixing a component forces its removal here.
 */
const KNOWN_SKIPPED: ReadonlySet<string> = new Set([
  "src/browser/features/Messages/MessageRenderer.tsx#MessageRenderer",
  "src/browser/features/Messages/AssistantMessage.tsx#AssistantMessage",
  "src/browser/components/ProjectSidebar/ProjectSidebar.tsx#ProjectSidebarInner",
  "src/browser/components/AppLoader/AppLoader.tsx#UserPreferencesStartupGate",
  "src/browser/features/RightSidebar/RightSidebar.tsx#RightSidebarComponent",
  "src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx#ReviewPanel",
  "src/browser/features/RightSidebar/CodeReview/ImmersiveReviewView.tsx#ImmersiveReviewView",
]);

// Subset of babel-plugin-react-compiler's logger events that this guard reads.
interface SourcePosition {
  line: number;
  column: number;
}
interface SourceLocation {
  start: SourcePosition;
}
interface CompilerEvent {
  kind: string;
  fnLoc?: SourceLocation | null;
  detail?: {
    reason?: string;
    loc?: SourceLocation | null;
    primaryLocation?: () => SourceLocation | null;
  };
}

function positionKey(pos: SourcePosition): string {
  return `${pos.line}:${pos.column}`;
}

/** Name of a function: its own id, or the variable it (or its memo/forwardRef wrapper) is assigned to. */
function inferFunctionName(fnPath: NodePath<t.Function>): string | null {
  const node = fnPath.node;
  if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id) {
    return node.id.name;
  }
  let parent = fnPath.parentPath;
  while (
    parent &&
    (parent.isCallExpression() || parent.isTSAsExpression() || parent.isTSSatisfiesExpression())
  ) {
    parent = parent.parentPath;
  }
  if (parent?.isVariableDeclarator() && parent.node.id.type === "Identifier") {
    return parent.node.id.name;
  }
  return null;
}

interface FileCoverage {
  compiled: Set<string>;
  /** Reasons the compiler skipped each named function, with the offending line. */
  skipped: Map<string, string[]>;
}

function auditFile(relativePath: string): FileCoverage {
  const namesByPosition = new Map<string, string>();
  // Runs before the compiler's Program visitor (plugins run in order), so every
  // function position is named before the compiler reports on it.
  const collectFunctionNames = (): PluginObj => ({
    visitor: {
      Program(programPath) {
        programPath.traverse({
          Function(fnPath) {
            const start = fnPath.node.loc?.start;
            const name = inferFunctionName(fnPath);
            if (start && name) namesByPosition.set(positionKey(start), name);
          },
        });
      },
    },
  });

  const events: CompilerEvent[] = [];
  transformFileSync(path.resolve(relativePath), {
    babelrc: false,
    configFile: false,
    code: false,
    presets: [
      ["@babel/preset-typescript", { isTSX: relativePath.endsWith(".tsx"), allExtensions: true }],
    ],
    plugins: [
      collectFunctionNames,
      [
        "babel-plugin-react-compiler",
        {
          ...reactCompilerConfig,
          logger: { logEvent: (_file: string, event: CompilerEvent) => events.push(event) },
        },
      ],
    ],
  });

  const coverage: FileCoverage = { compiled: new Set(), skipped: new Map() };
  for (const event of events) {
    if (!event.fnLoc) continue;
    const name = namesByPosition.get(positionKey(event.fnLoc.start));
    if (!name) continue;
    if (event.kind === "CompileSuccess") {
      coverage.compiled.add(name);
    } else if (event.kind === "CompileError") {
      const loc = event.detail?.primaryLocation?.() ?? event.detail?.loc;
      const reason = `line ${loc?.start.line ?? "?"}: ${event.detail?.reason ?? "unknown reason"}`;
      coverage.skipped.set(name, [...(coverage.skipped.get(name) ?? []), reason]);
    }
  }
  return coverage;
}

function main(): void {
  for (const key of KNOWN_SKIPPED) {
    const [file, name] = key.split("#");
    assert(
      HOT_COMPONENTS[file]?.includes(name),
      `KNOWN_SKIPPED entry ${key} is not in HOT_COMPONENTS`
    );
  }

  const failures: string[] = [];
  let checked = 0;
  for (const [file, names] of Object.entries(HOT_COMPONENTS)) {
    const coverage = auditFile(file);
    for (const name of names) {
      checked++;
      const key = `${file}#${name}`;
      const known = KNOWN_SKIPPED.has(key);
      if (coverage.compiled.has(name)) {
        if (known) {
          failures.push(`${key} now compiles. Remove it from KNOWN_SKIPPED.`);
        }
        continue;
      }
      const reasons = coverage.skipped.get(name);
      if (known && reasons) continue;
      failures.push(
        reasons
          ? `${key} is skipped by React Compiler:\n    ${[...new Set(reasons)].join("\n    ")}`
          : `${key} was not compiled and reported no error. If it was renamed or moved, ` +
            `update HOT_COMPONENTS; a hook that calls no other hooks needs a "use memo" directive.`
      );
    }
  }

  if (failures.length > 0) {
    console.error(`React Compiler coverage check failed:\n  ${failures.join("\n  ")}`);
    console.error(
      "\nMove unsupported constructs into plain helpers or hooks outside the component, " +
        "remove react-hooks lint suppressions, and don't read refs during render."
    );
    process.exit(1);
  }
  console.log(
    `React Compiler coverage OK: ${checked - KNOWN_SKIPPED.size}/${checked} hot components compile ` +
      `(${KNOWN_SKIPPED.size} known skipped).`
  );
}

main();
