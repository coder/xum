import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ForceDeleteModal } from "@/browser/components/ForceDeleteModal/ForceDeleteModal";

// Mirrors the ForceDeleteModal stories, rendered open. The modal is presentational:
// onForceDelete/onClose are injected (the stories use fn() mocks).
const descendants = [
  { workspaceId: "child-review", title: "Review child", active: false },
  { workspaceId: "child-build", title: "Build child", active: false },
];

const baseProps = {
  isOpen: true,
  workspaceId: "parent",
  error: "Descendant confirmation required",
  onClose: () => undefined,
  onForceDelete: () => Promise.resolve({ success: true as const }),
};

/** Two idle descendants: the delete button names the full scope. */
export const ExplicitScope = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground min-h-screen">
      <ForceDeleteModal {...baseProps} descendants={descendants} />
    </div>
  </MuxPreviewShell>
);

/** An active descendant: only Close is offered. */
export const ActiveDescendantBlocksShortcut = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground min-h-screen">
      <ForceDeleteModal {...baseProps} descendants={[{ ...descendants[0], active: true }]} />
    </div>
  </MuxPreviewShell>
);

/** A long descendant id and title wrap inside the dialog. */
export const Phone = () => (
  <MuxPreviewShell>
    <div className="bg-background text-foreground min-h-screen">
      <ForceDeleteModal
        {...baseProps}
        descendants={[
          {
            workspaceId: "child-" + "long-id-".repeat(16),
            title: "A long descendant title that must wrap inside the deletion dialog",
            active: false,
          },
        ]}
      />
    </div>
  </MuxPreviewShell>
);
