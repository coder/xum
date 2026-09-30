import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { CoderWorkspaceForm } from "@/browser/features/Runtime/CoderControls";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";
import type { CoderPreset, CoderTemplate, CoderWorkspace } from "@/common/orpc/schemas/coder";

// Mirrors the story's primary "NewWorkspace" variant: the Coder workspace form
// in new-workspace mode with templates + presets loaded. Inline mock data (data,
// not identity-sensitive) so the heavy stories/mocks graph isn't pulled in. The
// form is self-contained (Select + Tooltip resolve via the shell).
const TEMPLATES: CoderTemplate[] = [
  { name: "coder-on-coder", displayName: "Coder on Coder", organizationName: "default" },
  { name: "kubernetes-dev", displayName: "Kubernetes Development", organizationName: "default" },
  { name: "aws-windows", displayName: "AWS Windows Instance", organizationName: "default" },
];

const PRESETS: CoderPreset[] = [
  { id: "preset-sydney", name: "Sydney", description: "Australia region", isDefault: false },
  { id: "preset-helsinki", name: "Helsinki", description: "Europe region", isDefault: false },
  { id: "preset-pittsburgh", name: "Pittsburgh", description: "US East region", isDefault: true },
];

const WORKSPACES: CoderWorkspace[] = [
  {
    name: "mux-dev",
    templateName: "coder-on-coder",
    templateDisplayName: "Coder on Coder",
    status: "running",
  },
  {
    name: "api-testing",
    templateName: "kubernetes-dev",
    templateDisplayName: "Kubernetes Dev",
    status: "running",
  },
];

const NEW_WORKSPACE_CONFIG: CoderWorkspaceConfig = {
  existingWorkspace: false,
  template: "coder-on-coder",
  templateOrg: "default",
};

export const NewWorkspace = () => {
  const [coderConfig, setCoderConfig] = React.useState<CoderWorkspaceConfig | null>(
    () => NEW_WORKSPACE_CONFIG
  );

  return (
    <MuxPreviewShell>
      <div className="bg-background flex min-h-screen items-start justify-center p-6">
        <CoderWorkspaceForm
          coderConfig={coderConfig}
          onCoderConfigChange={setCoderConfig}
          templates={TEMPLATES}
          templatesError={null}
          presets={PRESETS}
          presetsError={null}
          existingWorkspaces={WORKSPACES}
          workspacesError={null}
          loadingTemplates={false}
          loadingPresets={false}
          loadingWorkspaces={false}
          disabled={false}
          hasError={false}
        />
      </div>
    </MuxPreviewShell>
  );
};
