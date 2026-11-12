import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { KeyHint } from "@/browser/components/KeyHint/KeyHint";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useAppConfig } from "@/browser/stores/AppConfigStore";
import {
  formatKeybind,
  formatKeybindForAria,
  KEYBINDS,
  type Keybind,
} from "@/browser/utils/ui/keybinds";
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

export type DefaultIsolationSaver = ReturnType<typeof useSetDefaultIsolation>;

/**
 * The saver's shortcut for the environment panel to run while it is open, or null while the
 * action would not run (already the default, saving, or locked).
 */
export function setDefaultShortcut(
  saver: DefaultIsolationSaver
): { keybind: Keybind; run: () => void } | null {
  if (!saver.canSave) return null;
  return { keybind: KEYBINDS.SET_DEFAULT_ISOLATION, run: () => void saver.save() };
}

/** A failed save, on the page: a save from the shortcut has no open panel to report in. */
export function DefaultSaveError(props: { saver: DefaultIsolationSaver }) {
  if (props.saver.error === null) return null;
  return (
    <span role="alert" className="text-error text-xs">
      {props.saver.error}
    </span>
  );
}

/**
 * One click from the creation page to make what it shows the project's default for new
 * workspaces, instead of a trip to Settings → Runtimes. It saves the isolation pair as the
 * project's default; the host, directory and image it shows are the project's remembered values,
 * which new workspaces start from with that pair. Once saved it reads "Default".
 *
 * It sits in the environment panel's footer, next to the sentence that says what would become
 * the default. The saver is owned by the page (see {@link useSetDefaultIsolation}), so the
 * shortcut also works while the panel is closed.
 */
export function SetDefaultIsolationButton(props: { saver: DefaultIsolationSaver }) {
  const { saver } = props;
  if (saver.isDefault) {
    return (
      <span
        className="text-foreground inline-flex shrink-0 items-center gap-1.5 text-xs"
        data-component="IsolationDefaultState"
      >
        <Check aria-hidden className="size-3.5" />
        Default
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-2">
      {/* An alert here too: the panel is modal, so the page's copy of this error is hidden from
          assistive technology while the panel is open. */}
      {saver.error !== null && (
        <span role="alert" className="text-error min-w-0 text-xs">
          {saver.error}
        </span>
      )}
      <Button
        variant="outline"
        size="xs"
        className="text-foreground h-7 gap-2 px-2.5 text-xs font-normal"
        disabled={!saver.canSave}
        aria-busy={saver.saving}
        aria-keyshortcuts={formatKeybindForAria(KEYBINDS.SET_DEFAULT_ISOLATION)}
        onClick={() => void saver.save()}
      >
        {saver.saving && <Loader2 aria-hidden className="animate-spin" />}
        Set as default
        <KeyHint>{formatKeybind(KEYBINDS.SET_DEFAULT_ISOLATION)}</KeyHint>
      </Button>
    </span>
  );
}

/**
 * Whether the shown isolation already is the project's default, and how to make it so. Also owns
 * the shortcut: every operation has one (AGENTS.md), and it works only while the button would.
 */
export function useSetDefaultIsolation(props: SetDefaultIsolationProps) {
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

  const isDefault = isProjectDefaultIsolation(
    project,
    globalDefault,
    globalEnablement,
    props.isolation
  );
  const canSave = !isDefault && !props.disabled && !saving;
  useCreationShortcut(canSave, KEYBINDS.SET_DEFAULT_ISOLATION, save);

  return {
    isDefault,
    canSave,
    saving,
    error,
    save,
  };
}
