import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ProjectCreateModal } from "@/browser/components/ProjectCreateModal/ProjectCreateModal";

// Rendered OPEN, mirroring the story's primary "LocalFolder" variant (the
// default "Local folder" tab of the Add Project modal). The story opens it via
// the sidebar; here we render the modal directly with the empty mock client
// (its projects.* methods back the form). No-op onClose/onSuccess keep it open.
export const LocalFolder = () => (
  <MuxPreviewShell>
    <ProjectCreateModal isOpen={true} onClose={() => undefined} onSuccess={() => undefined} />
  </MuxPreviewShell>
);
