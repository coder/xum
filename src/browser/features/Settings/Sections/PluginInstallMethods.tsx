import React from "react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";
import { AGENT_PLUGIN_INSTALL_METHOD_LABELS } from "@/common/constants/agentPluginInstallMethods";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
} from "@/common/orpc/schemas/agentPlugins";

/** The "Install as" choice of the Add panel. The methods come from the preview (`methods`). */

export function installMethodLabel(method: AgentPluginInstallMethod): string {
  return AGENT_PLUGIN_INSTALL_METHOD_LABELS[method.kind];
}

/** A stable choice value per method. A method with fields (a marketplace entry) adds them here. */
function methodKey(method: AgentPluginInstallMethod): string {
  return method.kind;
}

/** Runs the callback that a pick of toggle `value` means for the "Install as" choice. */
function pickInstallChoice(
  value: string,
  handlers: {
    preview: Pick<AgentPluginInstallPreview, "method">;
    onPickMethod: (method: AgentPluginInstallMethod) => void;
  },
  choices: ReadonlyArray<{ value: string; method: AgentPluginInstallMethod }>
): void {
  // Radix reports "" when the active item is pressed again: the choice stays.
  if (value === methodKey(handlers.preview.method)) return;
  const choice = choices.find((entry) => entry.value === value);
  if (choice !== undefined) handlers.onPickMethod(choice.method);
}

/** Segmented "Install as" choice; renders nothing when only one choice fits. */
export const InstallMethodPicker: React.FC<{
  preview: Pick<AgentPluginInstallPreview, "method" | "methods">;
  disabled: boolean;
  /** Another method: the panel previews again with it. */
  onPickMethod: (method: AgentPluginInstallMethod) => void;
}> = (props) => {
  const choices = props.preview.methods.map((method) => ({
    value: methodKey(method),
    label: installMethodLabel(method),
    method,
  }));
  if (choices.length < 2) return null;
  const pick = (value: string) => {
    // Busy (a preview or install runs): ignore the pick. The group is not disabled for this,
    // because a disabled button drops focus to the dialog, and a keyboard user then loses the
    // arrow keys of the choice after every pick.
    if (!props.disabled) pickInstallChoice(value, props, choices);
  };
  return (
    <div className="space-y-1">
      <span id="plugin-install-as" className="text-muted block text-xs">
        Install as
      </span>
      {/* Radix toggle group: Tab reaches it, arrow keys move between choices, Space or Enter
          picks one. Labels wrap onto a second row on phone widths. */}
      <ToggleGroup
        type="single"
        aria-labelledby="plugin-install-as"
        value={methodKey(props.preview.method)}
        onValueChange={pick}
        aria-busy={props.disabled}
        size="sm"
        className="h-auto min-h-9 max-w-full flex-wrap justify-start"
      >
        {choices.map((choice) => (
          <ToggleGroupItem
            key={choice.value}
            value={choice.value}
            size="sm"
            className="h-7 px-3 text-[13px]"
          >
            {choice.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-muted hidden text-[11px] md:block">Arrow keys to move · Space to pick</p>
    </div>
  );
};
