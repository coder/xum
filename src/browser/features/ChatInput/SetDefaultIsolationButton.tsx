import { useState } from "react";
import { Check, Loader2, Pin } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useAppConfig } from "@/browser/stores/AppConfigStore";
import { formatKeybind, formatKeybindForAria, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { IsolationChoice } from "@/common/types/isolation";
import { normalizeRuntimeEnablement } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { useCreationShortcut } from "./useCreationShortcut";
import { isProjectDefaultIsolation, projectDefaultIsolationUpdate } from "./creationDraftProject";

interface SetDefaultIsolationProps {
  /** Owning (top-level) project path: Settings defaults are per top-level project. */
  projectPath: string;
  isolation: IsolationChoice;
  disabled: boolean;
  /** Writes the fields the form shows into the project's remembered values. */
  rememberShownFields: () => void;
}

/**
 * One click from the creation page to make what it shows the project's default for new
 * workspaces, instead of a trip to Settings → Runtimes. It saves the isolation pair as the
 * project's default; the host, directory and image it shows are the project's remembered values,
 * which new workspaces start from with that pair. Once saved it reads "Default".
 */
export function SetDefaultIsolationButton(props: SetDefaultIsolationProps) {
  const saver = useSetDefaultIsolation(props);
  // Every operation has a shortcut (AGENTS.md); it works only while the button would.
  useCreationShortcut(
    !saver.isDefault && !props.disabled,
    KEYBINDS.SET_DEFAULT_ISOLATION,
    saver.save
  );

  if (saver.isDefault) {
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

  const Icon = saver.saving ? Loader2 : Pin;
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <Button
        variant="ghost"
        size="xs"
        // h-7 and text-xs match the branch select beside it, so the two share a centre line.
        className="text-muted hover:text-foreground h-7 px-1.5 text-xs"
        disabled={props.disabled || saver.saving}
        aria-busy={saver.saving}
        aria-keyshortcuts={formatKeybindForAria(KEYBINDS.SET_DEFAULT_ISOLATION)}
        // The shared tooltip shows the shortcut on hover; touch devices never hover, so phones
        // do not show it.
        title={`Make this the project's default (${formatKeybind(KEYBINDS.SET_DEFAULT_ISOLATION)})`}
        onClick={() => void saver.save()}
      >
        <Icon aria-hidden className={saver.saving ? "animate-spin" : undefined} />
        Set as default
      </Button>
      {saver.error !== null && (
        <span role="alert" className="text-error text-xs">
          {saver.error}
        </span>
      )}
    </span>
  );
}

/** Whether the shown isolation already is the project's default, and how to make it so. */
function useSetDefaultIsolation(props: SetDefaultIsolationProps) {
  const { api } = useAPI();
  const { userProjects, refreshProjects } = useProjectContext();
  const globalDefault = useAppConfig((config) => config.defaultIsolation);
  const rawGlobalEnablement = useAppConfig((config) => config.runtimeEnablement);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = userProjects.get(props.projectPath);
  const globalEnablement = normalizeRuntimeEnablement(rawGlobalEnablement);

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

  return {
    isDefault: isProjectDefaultIsolation(project, globalDefault, globalEnablement, props.isolation),
    saving,
    error,
    save,
  };
}
