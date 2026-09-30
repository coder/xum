// Generate the DS bundle barrel for Mux from the authoritative storybook index.
// For each component (unique title last-segment), find the real component export
// by scoring candidates [storyFileBase, `component:` meta, titleSeg] against the
// story's own imports, resolving each import to a source file and verifying it
// exports the candidate. App-screen stories (AppWithMocks-only, no component
// import) resolve to nothing and are reported for exclusion.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const root = process.cwd(); // run from repo root
// sb-reference/ is gitignored, so it's absent on a fresh checkout — fail with an
// explicit prerequisite instead of an opaque ENOENT. Build it first:
//   npx storybook build -c .storybook -o .design-sync/sb-reference
const idxPath = `${root}/.design-sync/sb-reference/index.json`;
if (!existsSync(idxPath)) {
  console.error(
    `[gen-barrel] missing ${idxPath}\n` +
      "Build the reference Storybook first (it is gitignored, so absent on a fresh checkout):\n" +
      "  npx storybook build -c .storybook -o .design-sync/sb-reference\n" +
      "Then re-run: node .design-sync/gen-barrel.mjs"
  );
  process.exit(1);
}
const idx = JSON.parse(readFileSync(idxPath, "utf8"));
const stripWs = (s) => s.replace(/\s+/g, "");
const lastSeg = (t) => stripWs(String(t).split("/").pop());
// Curated exclusions so the design bundle AND every preview stay under the
// 5 MB upload cap (see .design-sync/NOTES.md "Curation"). Re-measure with the
// scratch sizing scripts if the component set or deps change materially.
// (a) Full-app / composite screens with no single reusable component.
// NOTE: the chat composer is excluded by path (EXCLUDE_IMPORT) rather than by
// its "Input" segment, so the reusable Input primitive (Components/Input) can
// keep the canonical name without colliding.
const EXCLUDE_APP_SCREEN = [
  "WorkspaceSwitcher",
  "PhoneViewports",
  "READMEScreenshots",
  "TranscriptDensity",
];
// (b) Heavy-viz: transitively pull shiki/mermaid/recharts/d3/ghostty/lottie
//     (rich-content rendering) — 9-17 MB closures each, far over the cap.
const EXCLUDE_HEAVY = [
  "AIView",
  "RightSidebar",
  "CodeExecution",
  "Messages",
  "Task",
  "WorkflowRun",
  // WorkflowRunToolCall's timeout stories title to ".../WorkflowRun/Timeouts" (segment
  // "Timeouts"); exclude that segment too so the heavy component stays out — and so the
  // generated titleMap nulls "Timeouts" (a path exclusion would not, drifting from config).
  "Timeouts",
  "ProposePlan",
  "Media",
  "AttachFile",
  "PlanFileDialog",
  "AgentSkillRead",
  "AgentReport",
  "MarkdownRenderer",
  "ProjectPage",
  "SettingsPage",
  "ImmersiveReviewView",
  "HunkViewer",
  "FileEdit",
  "Generic",
  "GovernorSection",
  "GoogleSearch",
  "AnalyticsDashboard",
  "ProjectSidebar",
];
// (c) Oversized app-chrome: light deps but large source closures → previews
//     >5 MB and/or push the union bundle over cap. Not reusable primitives.
const EXCLUDE_OVERSIZED = [
  "LeftSidebar",
  "WorkspaceMenuBar",
  "AgentListItem",
  "AskUserQuestion",
  "Bash",
  "ModelsSection",
  "ProvidersSection",
  "TasksSection",
  "CreationControls",
  "ArchivedWorkspaces",
  "LayoutsSection",
  "AgentModePicker",
  "WorkspaceHeartbeatModal",
  "ExperimentsSection",
  "ConcurrentLocalWarning",
];
// (d) Empty in isolated previews: driven by live store/async API data (model
//     list, git status, memory, background processes, workspace MCP) that a
//     static isolated render can't populate — they render blank. Deferred until
//     the harness can drive their stores/async loads (see NOTES.md).
const EXCLUDE_EMPTY = [
  "BackgroundProcesses",
  "MemoryTab",
  "ModelSelector",
  "MultiProjectGitStatusIndicator",
  "WorkspaceMCPModal",
];
const EXCLUDE_SEGS = new Set([
  ...EXCLUDE_APP_SCREEN,
  ...EXCLUDE_HEAVY,
  ...EXCLUDE_OVERSIZED,
  ...EXCLUDE_EMPTY,
]);
// Path-based exclusions: seg-based EXCLUDE can't disambiguate two stories that
// share a title last-segment. The chat composer (App/Chat/Input → ChatInput)
// and the Input primitive (Components/Input) both segment to "Input"; exclude
// the composer by its source path so the primitive keeps the "Input" name.
const EXCLUDE_IMPORT = ["/features/ChatInput/"];
// Stories with no single same-named component export → pin the representative one.
const MANUAL = {
  CoderControls: { at: "@/browser/features/Runtime/CoderControls", real: "CoderWorkspaceForm" },
};

// Parse imports → Map(localName -> { path, real }) where `real` is the source-side name.
function parseImports(src) {
  const map = new Map();
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s*["']([^"']+)["'];?/g)) {
    const clause = m[1],
      path = m[2];
    const def = clause.match(/^\s*([A-Za-z0-9_$]+)\s*(?:,|$)/);
    if (def) map.set(def[1], { path, real: "default" });
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces)
      for (const p of braces[1].split(",")) {
        const t = p.trim();
        if (!t) continue;
        const as = t.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        if (as) map.set(as[2], { path, real: as[1] });
        else if (/^[A-Za-z0-9_$]+$/.test(t)) map.set(t, { path, real: t });
      }
  }
  return map;
}

// Does file `abs` export `name` (named) or a default? Returns the @/ spec.
function exportFrom(file, name) {
  if (!existsSync(file)) return null;
  const s = readFileSync(file, "utf8");
  const rel = file
    .replace(`${root}/src/`, "")
    .replace(/\.(tsx?|jsx?)$/, "")
    .replace(/\/index$/, "");
  const at = `@/${rel}`;
  if (name === "default") return /export\s+default\b/.test(s) ? { at, real: "default" } : null;
  const named =
    new RegExp(`export\\s+(?:async\\s+)?(?:const|let|var|function|class)\\s+${name}\\b`).test(s) ||
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b(?:\\s+as\\s+[A-Za-z0-9_$]+)?[^}]*\\}`).test(s);
  return named ? { at, real: name } : null;
}

// Resolve `name` to a source file: first via the story's own import of it, then
// by convention (sibling, flat parent for tool calls, or index) — AppWithMocks
// stories render the component without importing it directly.
function tryResolve(storyAbs, imports, name) {
  const imp = imports.get(name);
  if (imp) {
    let absNoExt;
    if (imp.path.startsWith("@/")) absNoExt = `${root}/src/${imp.path.slice(2)}`;
    else if (imp.path.startsWith(".")) absNoExt = resolve(dirname(storyAbs), imp.path);
    else absNoExt = null;
    if (absNoExt) {
      absNoExt = absNoExt.replace(/\.(jsx?|tsx?)$/, "");
      const file = [".tsx", ".ts", "/index.tsx", "/index.ts"]
        .map((e) => absNoExt + e)
        .find(existsSync);
      if (file) {
        const r = exportFrom(file, imp.real);
        if (r) return r;
      }
    }
  }
  // Convention fallback: <storyDir>/<name>.tsx, <storyParent>/<name>.tsx, <storyDir>/index.tsx.
  // Try the named export first, then a default export (e.g. ProjectSidebar).
  const dir = dirname(storyAbs);
  for (const cand of [`${dir}/${name}.tsx`, `${dirname(dir)}/${name}.tsx`, `${dir}/index.tsx`]) {
    const r = exportFrom(cand, name) ?? exportFrom(cand, "default");
    if (r) return r;
  }
  return null;
}

const bySeg = new Map();
const excluded = new Set();
const noComponent = new Set();
const tried = new Set();

for (const e of Object.values(idx.entries ?? {})) {
  if (e.type === "docs" || !e.importPath) continue;
  // Skip path-excluded stories WITHOUT claiming their segment, so a same-named
  // sibling elsewhere in the tree can still resolve.
  if (EXCLUDE_IMPORT.some((p) => e.importPath.includes(p))) continue;
  const seg = lastSeg(e.title);
  if (EXCLUDE_SEGS.has(seg)) {
    excluded.add(seg);
    continue;
  }
  if (bySeg.has(seg) || tried.has(seg)) continue;
  tried.add(seg);
  const storyRel = e.importPath.replace(/^\.\//, "");
  const storyAbs = `${root}/${storyRel}`;
  if (!existsSync(storyAbs)) continue;
  const src = readFileSync(storyAbs, "utf8");
  const imports = parseImports(src);
  const base = storyRel
    .split("/")
    .pop()
    .replace(/\.stories\.tsx$/, "");
  const metaM = src.match(/\bcomponent:\s*([A-Za-z0-9_$]+)/);
  const candidates = [...new Set([base, metaM?.[1], seg].filter(Boolean))];
  let hit = MANUAL[seg] ? { seg, ...MANUAL[seg] } : null;
  for (const cand of candidates) {
    if (hit) break;
    const r = tryResolve(storyAbs, imports, cand);
    if (r) {
      hit = { seg, at: r.at, real: r.real };
      break;
    }
  }
  if (!hit) {
    noComponent.add(`${seg} (${storyRel})`);
    continue;
  }
  bySeg.set(seg, hit);
}

// Export each component under its REAL export name (not aliased to the title
// segment) so isolated previews can `import { <Real> }` and have it resolve to
// window.<Global>.<Real> through the shim. The converter maps the title segment
// to the real name via `titleMap` (computed below), so the component's design-
// system name is its real export name. Default exports keep the segment name.
const sorted = [...bySeg.values()].sort((a, b) => a.seg.localeCompare(b.seg));
const lines = sorted.map((h) =>
  h.real === "default"
    ? `export { default as ${h.seg} } from "${h.at}";`
    : `export { ${h.real} } from "${h.at}";`
);
// titleMap: null out every excluded segment, and map kept segments whose title
// segment differs from the real export name → the real name.
const titleMap = {};
for (const s of EXCLUDE_SEGS) titleMap[s] = null;
for (const h of sorted) if (h.real !== "default" && h.real !== h.seg) titleMap[h.seg] = h.real;

// Providers exposed on window.Mux. ThemeProvider is the cfg.provider wrapper
// (sets data-theme on <html>); the rest let the isolated-preview harness
// (.design-sync/preview-harness.tsx) shim its provider imports to window.Mux so
// they share React-context identity with the bundled components. The design
// agent also needs these to wrap anything it builds.
const PROVIDER_LINES = [
  `export { ThemeProvider } from "@/browser/contexts/ThemeContext";`,
  `export { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";`,
  `export { APIProvider } from "@/browser/contexts/API";`,
  `export { PolicyProvider } from "@/browser/contexts/PolicyContext";`,
  `export { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";`,
  `export { SettingsProvider } from "@/browser/contexts/SettingsContext";`,
  `export { RouterProvider } from "@/browser/contexts/RouterContext";`,
  `export { ProjectProvider } from "@/browser/contexts/ProjectContext";`,
  `export { AboutDialogProvider } from "@/browser/contexts/AboutDialogContext";`,
];

// Compound primitives (Dialog/Tooltip/Popover) export only their Root above (the
// title segment resolves to it); their composition parts must also ride
// window.<Global> so isolated previews can shim to them. Source-only re-exports —
// harmless if a compound primitive is later excluded.
const PRIMITIVE_PART_LINES = [
  `export { DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, WarningBox, WarningTitle, WarningText } from "@/browser/components/Dialog/Dialog";`,
  `export { TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";`,
  `export { PopoverTrigger, PopoverContent } from "@/browser/components/Popover/Popover";`,
];

const barrel =
  `// AUTO-GENERATED by .design-sync barrel generator — do not edit by hand.\n` +
  `// DS bundle entry: the curated set of storied Mux components (real export\n` +
  `// names) + the providers the isolated-preview harness needs. Exposes them on\n` +
  `// window.Mux for the design agent and seeds the converter's \`exported\` set.\n` +
  `// Run \`node .design-sync/gen-barrel.mjs\` after stories change; it also prints\n` +
  `// the titleMap to merge into config.json.\n\n` +
  lines.join("\n") +
  "\n\n" +
  `// ── Providers ──\n` +
  PROVIDER_LINES.join("\n") +
  "\n\n" +
  `// ── Compound primitive parts ──\n` +
  PRIMITIVE_PART_LINES.join("\n") +
  "\n";
writeFileSync(`${root}/.design-sync/ds-barrel.ts`, barrel);
// .cache/ is gitignored, so it's absent on a fresh checkout — create it before
// writing, or the documented `node .design-sync/gen-barrel.mjs` re-sync flow
// throws ENOENT after emitting the barrel.
mkdirSync(`${root}/.design-sync/.cache`, { recursive: true });
writeFileSync(
  `${root}/.design-sync/.cache/titlemap.json`,
  JSON.stringify(titleMap, null, 2) + "\n"
);
console.log(
  `components: ${bySeg.size} | excluded: ${excluded.size} | remapped: ${Object.values(titleMap).filter(Boolean).length} | no-component: ${noComponent.size}`
);
console.log(`titleMap written to .design-sync/.cache/titlemap.json (merge into config.json)`);
for (const n of noComponent) console.log("  " + n);
