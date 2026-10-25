/**
 * First-load guards for the renderer (T3 #5971, the bundle cut that reopens #6896).
 *
 * A phone on `/workspace/<id>` downloads the entry's static-import closure and the workspace
 * page chunk's closure before the composer works, at Lighthouse's 1.47 Mbps. Each module listed
 * here was cut from one of those closures, and these tests keep it out: one static import from
 * an eager file pulls the whole module back (often tens of KB of brotli).
 *
 * The closure is the static `import` graph esbuild resolves (tsconfig aliases included, type-only
 * imports elided like Vite's transform). Dynamic `import()` is lazy and not followed. Packages
 * stay external: no rule here is about a package.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as esbuild from "esbuild";

const ROOT = path.resolve(import.meta.dir, "../..");

/** Project-relative paths of every module the entry reaches through static imports. */
async function staticImportClosure(entry: string): Promise<Set<string>> {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    outdir: path.join(ROOT, ".renderer-first-load-unused-outdir"),
    logLevel: "silent",
    packages: "external",
    plugins: [
      {
        // Vite asset suffixes (`?react`, `?inline`, ...) and non-code files are leaves.
        name: "assets-are-leaves",
        setup(build) {
          build.onResolve(
            { filter: /\?|\.(css|svg|png|jpe?g|gif|webp|woff2?|ttf|wasm)$/ },
            (args) => ({
              path: args.path,
              external: true,
            })
          );
        },
      },
    ],
  });
  const inputs = result.metafile.inputs;
  const closure = new Set<string>();
  const queue = [entry];
  for (let file = queue.shift(); file != null; file = queue.shift()) {
    if (closure.has(file)) continue;
    closure.add(file);
    const input = inputs[file];
    expect(input, `esbuild did not resolve ${file}`).toBeDefined();
    for (const edge of input.imports) {
      if (edge.kind === "import-statement" && edge.external !== true) queue.push(edge.path);
    }
  }
  return closure;
}

describe("renderer first load", () => {
  test("the entry's static imports do not reach the tool definitions module", async () => {
    // StreamingMessageAggregator needs one result schema. Through toolDefinitions.ts it pulled
    // every tool schema (~24 KB brotli) into main-*.js, which every page loads first.
    const closure = await staticImportClosure("src/browser/main.tsx");
    expect(closure.has("src/browser/utils/messages/StreamingMessageAggregator.ts")).toBe(true);
    expect(closure.has("src/common/utils/tools/toolDefinitions.ts")).toBe(false);
  }, 60_000);

  // #6997: the palette (and cmdk, which only it imports) loads on its first open.
  test("the entry's static imports do not reach the command palette", async () => {
    const closure = await staticImportClosure("src/browser/main.tsx");
    expect(closure.has("src/browser/components/CommandPalette/LazyCommandPalette.tsx")).toBe(true);
    expect(closure.has("src/browser/components/CommandPalette/CommandPalette.tsx")).toBe(false);
  }, 60_000);

  // #7471: App.tsx and the palette's command sources read the Agent interface view's flags and
  // status-page entry. Through agentInterfaceView.ts they pulled the artifact document parser and
  // its helpers (~4 KB brotli) into main-*.js; only the main pane's status view needs those.
  test("the entry's static imports do not reach the artifact document parser", async () => {
    const closure = await staticImportClosure("src/browser/main.tsx");
    expect(closure.has("src/browser/App.tsx")).toBe(true);
    expect(closure.has("src/browser/features/RightSidebar/ArtifactsTab/artifactDocument.ts")).toBe(
      false
    );
  }, 60_000);

  test("the workspace page's static imports do not reach the workspace-menu modals", async () => {
    // App.tsx starts the workspace page chunk (loadAIView() -> AIView) while the entry boots, so a
    // phone downloads both closures before the composer works. WorkspaceMenuBar mounted these
    // modals closed, which put them and the MCP app frame (~39 KB brotli) in that download.
    const closure = new Set([
      ...(await staticImportClosure("src/browser/main.tsx")),
      ...(await staticImportClosure("src/browser/components/AIView/AIView.tsx")),
    ]);
    expect(closure.has("src/browser/components/WorkspaceMenuBar/WorkspaceMenuBar.tsx")).toBe(true);
    const forbidden = [
      "src/browser/components/WorkspaceHeartbeatModal/",
      // Not the whole folder: WorkspaceContext needs settingsToolRuns.ts on every page.
      "src/browser/components/WorkspaceMCPModal/WorkspaceMCPModal.tsx",
      "src/browser/components/WorkspaceMCPModal/MCPSettingsToolActionRow.tsx",
      "src/browser/components/WorkspaceUnrelatedMessagingModal/",
      "src/browser/features/RightSidebar/ArtifactsTab/McpAppFrame",
    ];
    expect([...closure].filter((file) => forbidden.some((dir) => file.startsWith(dir)))).toEqual(
      []
    );
  }, 60_000);
});
