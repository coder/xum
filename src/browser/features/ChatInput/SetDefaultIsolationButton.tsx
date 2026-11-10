import { useState } from "react";
import { Check, Loader2, Pin } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useAppConfig } from "@/browser/stores/AppConfigStore";
import type { IsolationChoice } from "@/common/types/isolation";
import { normalizeRuntimeEnablement } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { isProjectDefaultIsolation, projectDefaultIsolationUpdate } from "./creationDraftProject";

/**
 * One click from the creation page to make what it shows the project's default for new
 * workspaces, instead of a trip to Settings → Runtimes. It saves the isolation pair as the
 * project's default; the host, directory and image it shows are the project's remembered values,
 * which new workspaces start from with that pair. Once saved it reads "Default".
 */
export function SetDefaultIsolationButton(props: {
  /** Owning (top-level) project path: Settings defaults are per top-level project. */
  projectPath: string;
  isolation: IsolationChoice;
  disabled: boolean;
  /** Writes the fields the form shows into the project's remembered values. */
  rememberShownFields: () => void;
}) {
  const { api } = useAPI();
  const { userProjects, refreshProjects } = useProjectContext();
  const globalDefault = useAppConfig((config) => config.defaultIsolation);
  const rawGlobalEnablement = useAppConfig((config) => config.runtimeEnablement);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = userProjects.get(props.projectPath);
  const globalEnablement = normalizeRuntimeEnablement(rawGlobalEnablement);

  if (isProjectDefaultIsolation(project, globalDefault, globalEnablement, props.isolation)) {
    return (
      <span
        className="text-muted inline-flex shrink-0 items-center gap-1 text-xs"
        data-component="IsolationDefaultState"
      >
        <Check aria-hidden className="size-3.5" />
        Default
      </span>
    );
  }

  const save = async () => {
    if (!api || saving) return;
    setSaving(true);
    setError(null);
    try {
      props.rememberShownFields();
      await api.config.updateRuntimeEnablement(
        projectDefaultIsolationUpdate(props.projectPath, project, props.isolation, globalEnablement)
      );
      await refreshProjects();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <Button
        variant="ghost"
        size="xs"
        className="text-muted hover:text-foreground h-6 px-1.5"
        disabled={props.disabled || saving}
        aria-busy={saving}
        onClick={() => void save()}
      >
        {saving ? <Loader2 aria-hidden className="animate-spin" /> : <Pin aria-hidden />}
        Set as default
      </Button>
      {error !== null && (
        <span role="alert" className="text-error text-xs">
          {error}
        </span>
      )}
    </span>
  );
}
