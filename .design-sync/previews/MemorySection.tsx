import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { MemorySection } from "@/browser/features/Settings/Sections/MemorySection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { MemoryFileInfo } from "@/common/orpc/schemas/memory";

// Settings → Memory manages global-scope files only (workspaceId null). The
// MemoryBrowser loads api.memory.list(), so seed a global file fixture (mirrors
// the story's GLOBAL_MEMORY_FILES) covering a nested path, a pinned file, and
// used/never-used usage-stat permutations. Plain-text descriptions only — the
// markdown editor is never mounted in the list view.
const GLOBAL_MEMORY_FILES: MemoryFileInfo[] = [
  {
    path: "/memories/global/preferences.md",
    scope: "global",
    description: "Coding style and tooling preferences",
    pinned: true,
    accessCount: 12,
    lastAccessedAt: Date.now() - 3_600_000,
  },
  {
    path: "/memories/global/people/reviewers.md",
    scope: "global",
    description: "Preferred reviewers per code area",
    pinned: false,
    accessCount: 3,
    lastAccessedAt: Date.now() - 86_400_000,
  },
  {
    path: "/memories/global/glossary.md",
    scope: "global",
    description: "",
    pinned: false,
    accessCount: 0,
    lastAccessedAt: null,
  },
];

export const WithFiles = () => (
  <MuxPreviewShell client={createMockORPCClient({ memoryFiles: GLOBAL_MEMORY_FILES })}>
    <div className="bg-background p-6 max-w-2xl">
      <MemorySection />
    </div>
  </MuxPreviewShell>
);
