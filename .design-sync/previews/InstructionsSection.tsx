import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { InstructionsSection } from "@/browser/features/Settings/Sections/InstructionsSection.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

// Mirrors the InstructionsSection stories: two projects; the section picks the first
// and edits its custom instructions (read from ProjectContext via the mock client).
const PROJECT_PATH_A = "/Users/test/my-app";
const PROJECT_PATH_B = "/Users/test/other-app";

function instructionsClient(customInstructions?: string) {
  const workspaces = [
    createWorkspace({
      id: "ws-instructions-a",
      name: "main",
      projectName: "my-app",
      projectPath: PROJECT_PATH_A,
    }),
    createWorkspace({
      id: "ws-instructions-b",
      name: "main",
      projectName: "other-app",
      projectPath: PROJECT_PATH_B,
    }),
  ];
  const projects = groupWorkspacesByProject(workspaces);
  const projectA = projects.get(PROJECT_PATH_A);
  if (projectA && customInstructions) projectA.customInstructions = customInstructions;
  return createMockORPCClient({ workspaces, projects });
}

export const Empty = () => (
  <MuxPreviewShell client={instructionsClient()}>
    <div className="bg-background text-foreground p-6">
      <InstructionsSection />
    </div>
  </MuxPreviewShell>
);

export const WithSavedInstructions = () => (
  <MuxPreviewShell
    client={instructionsClient(
      "Always run the full test suite before committing.\nPrefer small, reviewable changes."
    )}
  >
    <div className="bg-background text-foreground p-6">
      <InstructionsSection />
    </div>
  </MuxPreviewShell>
);
