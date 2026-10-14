import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import * as path from "path";

// Rollup groups modules by the lazy entries that need them. #6334 made Settings import the
// Markdown stack statically (MemoryFileEditor -> MarkdownFilePreview), so the stack left the
// workspace page's chunk for a shared one, and the two files cost that page ~20 KB more brotli.
// Other pages must load it through the AIView entry with `import()` (see MemoryFileEditor), so the
// walk follows static imports only. Same walk as sources.importGraph.test.ts.
const toPosix = (file: string): string => file.replaceAll("\\", "/");
const SRC = path.join(import.meta.dir, "../../..");
const OUTSIDE_WORKSPACE_PAGE = [
  "browser/App.tsx", // the first load
  "browser/features/Settings/SettingsPage.tsx",
  "browser/components/ProjectPage/ProjectPage.tsx",
  "browser/components/ScratchPage/ScratchPage.tsx",
  "browser/features/Analytics/AnalyticsDashboard.tsx",
];
const STACK = /\/src\/browser\/features\/Messages\/Markdown(Renderer|FilePreview)\.tsx$/;

async function staticImportGraph(entry: string): Promise<Map<string, string | null>> {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  for (let file = queue.shift(); file != null; file = queue.shift()) {
    if (!/\.[jt]sx?$/.test(file) || file.includes("/node_modules/")) continue;
    for (const imp of transpiler.scanImports(await readFile(file, "utf-8"))) {
      if (imp.kind !== "import-statement") continue;
      let resolved: string;
      try {
        resolved = toPosix(Bun.resolveSync(imp.path, path.dirname(file)));
      } catch {
        continue; // generated files such as @/version; the stack modules always resolve
      }
      if (parents.has(resolved)) continue;
      parents.set(resolved, file);
      queue.push(resolved);
    }
  }
  return parents;
}

function stackChains(parents: Map<string, string | null>): string[] {
  return [...parents.keys()]
    .filter((file) => STACK.test(file))
    .map((file) => {
      const chain: string[] = [];
      for (let at: string | null | undefined = file; at != null; at = parents.get(at)) {
        chain.push(path.relative(SRC, at));
      }
      return chain.join(" <- ");
    });
}

test("only the workspace page imports the Markdown stack statically", async () => {
  // The walk must find the stack from the page that owns it, or a passing result proves nothing.
  const page = await staticImportGraph(
    toPosix(path.join(SRC, "browser/components/AIView/AIView.tsx"))
  );
  expect(stackChains(page).length).toBeGreaterThan(0);
  for (const entry of OUTSIDE_WORKSPACE_PAGE) {
    expect(stackChains(await staticImportGraph(toPosix(path.join(SRC, entry))))).toEqual([]);
  }
});
