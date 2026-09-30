import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { SecuritySection } from "@/browser/features/Settings/Sections/SecuritySection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { ProjectConfig } from "@/common/types/project";

// Project Trust: the section reads userProjects from ProjectContext (in the shell,
// fed by the mock client). Seed a mixed-trust project map (mirrors the story's
// SecurityMixedTrust) so both "Trust" and "Revoke trust" actions render.
const PROJECTS = new Map<string, ProjectConfig>([
  ["/Users/dev/my-app", { workspaces: [], trusted: true }],
  ["/Users/dev/untrusted-repo", { workspaces: [], trusted: false }],
  ["/Users/dev/another-project", { workspaces: [], trusted: true }],
]);

export const SecurityMixedTrust = () => (
  <MuxPreviewShell client={createMockORPCClient({ projects: PROJECTS })}>
    <div className="p-6 max-w-2xl">
      <SecuritySection />
    </div>
  </MuxPreviewShell>
);
