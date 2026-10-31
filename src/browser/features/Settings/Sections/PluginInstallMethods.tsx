import React, { useState } from "react";
import { ArrowLeft, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";
import { AGENT_PLUGIN_INSTALL_METHOD_LABELS } from "@/common/constants/agentPluginInstallMethods";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
} from "@/common/orpc/schemas/agentPlugins";
import { getErrorMessage } from "@/common/utils/errors";
import { skillsCliSourceProblem } from "@/common/utils/skillsCliSource";

/**
 * The "Install as" choice of the Add panel and its Skills CLI method. Managed methods come from
 * the preview (`methods`); the Skills CLI choice is last and needs the skill names, so it is
 * offered only when the repository has SKILL.md files.
 */

/** The choice that is not a managed install: the user runs the skills CLI. */
const SKILLS_CLI_CHOICE = "skills-cli";

export function installMethodLabel(method: AgentPluginInstallMethod): string {
  return AGENT_PLUGIN_INSTALL_METHOD_LABELS[method.kind];
}

/** A stable choice value per method. A method with fields (a marketplace entry) adds them here. */
function methodKey(method: AgentPluginInstallMethod): string {
  return "entry" in method ? `${method.kind}:${method.entry}` : method.kind;
}

/**
 * Whether the Add panel offers the Skills CLI: the repository has SKILL.md files, and the source
 * is one the backend takes (skillsCliSourceProblem). The CLI gets only the source text, so a
 * branch or folder in the other fields would install other skills than the preview showed.
 */
export function offersSkillsCli(fields: {
  input: string;
  ref: string;
  subpath: string;
  skills: string[];
}): boolean {
  return (
    fields.skills.length > 0 &&
    fields.ref.trim().length === 0 &&
    fields.subpath.trim().length === 0 &&
    skillsCliSourceProblem(fields.input) === undefined
  );
}

/** Runs the callback that a pick of toggle `value` means for the "Install as" choice. */
function pickInstallChoice(
  value: string,
  handlers: {
    preview: Pick<AgentPluginInstallPreview, "method">;
    onPickCurrent: () => void;
    onPickMethod: (method: AgentPluginInstallMethod) => void;
    onPickCli: () => void;
  },
  choices: ReadonlyArray<{ value: string; method: AgentPluginInstallMethod }>
): void {
  // Radix reports "" when the active item is pressed again: the choice stays.
  if (value === SKILLS_CLI_CHOICE) handlers.onPickCli();
  else if (value === methodKey(handlers.preview.method)) handlers.onPickCurrent();
  else {
    const choice = choices.find((entry) => entry.value === value);
    if (choice !== undefined) handlers.onPickMethod(choice.method);
  }
}

/** Segmented "Install as" choice; renders nothing when only one choice fits. */
export const InstallMethodPicker: React.FC<{
  preview: Pick<AgentPluginInstallPreview, "method" | "methods">;
  /** offersSkillsCli: the last choice is the Skills CLI. */
  cliOffered: boolean;
  cliChosen: boolean;
  disabled: boolean;
  /** The current method again (back from the Skills CLI choice). */
  onPickCurrent: () => void;
  /** Another method: the panel previews again with it. */
  onPickMethod: (method: AgentPluginInstallMethod) => void;
  onPickCli: () => void;
}> = (props) => {
  const choices = props.preview.methods.map((method) => ({
    value: methodKey(method),
    label: installMethodLabel(method),
    method,
  }));
  const cliOffered = props.cliOffered;
  if (choices.length + (cliOffered ? 1 : 0) < 2) return null;
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
        value={props.cliChosen ? SKILLS_CLI_CHOICE : methodKey(props.preview.method)}
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
        {cliOffered && (
          <ToggleGroupItem value={SKILLS_CLI_CHOICE} size="sm" className="h-7 px-3 text-[13px]">
            Skills CLI
          </ToggleGroupItem>
        )}
      </ToggleGroup>
      <p className="text-muted hidden text-[11px] md:block">Arrow keys to move · Space to pick</p>
    </div>
  );
};

/** Checkboxes for skill names, with Select all and Clear (like the plugin component chooser). */
const SkillNameChooser: React.FC<{
  skills: string[];
  selected: string[];
  disabled: boolean;
  onChange: (selected: string[]) => void;
}> = (props) => (
  <fieldset aria-label="Skills" className="min-w-0 space-y-1" disabled={props.disabled}>
    <legend className="text-foreground text-xs font-medium">
      Skills{" "}
      <span className="counter-nums">
        ({props.selected.length} of {props.skills.length} selected)
      </span>
    </legend>
    <div className="flex flex-wrap gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={props.disabled || props.selected.length === props.skills.length}
        onClick={() => props.onChange(props.skills)}
      >
        Select all
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={props.disabled || props.selected.length === 0}
        onClick={() => props.onChange([])}
      >
        Clear
      </Button>
    </div>
    {props.skills.map((name) => (
      <label key={name} className="flex items-start gap-2 text-xs">
        <Checkbox
          aria-label={name}
          checked={props.selected.includes(name)}
          disabled={props.disabled}
          onCheckedChange={(checked) =>
            props.onChange(
              checked === true
                ? props.skills.filter((skill) => skill === name || props.selected.includes(skill))
                : props.selected.filter((skill) => skill !== name)
            )
          }
        />
        <span className="text-foreground min-w-0 font-mono break-all">{name}</span>
      </label>
    ))}
  </fieldset>
);

/** Fetch the command for the picked skills: the backend validates the source and the names. */
function useSkillsCliCommand(source: string) {
  const { api } = useAPI();
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const show = async (skills: string[]) => {
    if (!api || loading || skills.length === 0) return;
    setLoading(true);
    setError(null);
    setCommand(null);
    try {
      const result = await api.agentPlugins.skillsCliCommand({ source, skills });
      if (result.success) setCommand(result.data.command);
      else setError(result.error);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return { command, error, loading, show, clear: () => setCommand(null) };
}

const ErrorAlert: React.FC<{ message: string | null }> = (props) =>
  props.message === null ? null : (
    <div
      role="alert"
      className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm"
    >
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-words">{props.message}</span>
    </div>
  );

/**
 * The Skills CLI method: pick skills, then copy the pinned CLI's command and run it in a
 * terminal. Xum does not run the CLI (see skillsCli.ts: the CLI's copy follows symlinks).
 */
export const SkillsCliInstall: React.FC<{
  /** The source as typed in the Add panel (the backend validates it before it builds the command). */
  source: string;
  skills: string[];
  onBack: () => void;
}> = (props) => {
  const cli = useSkillsCliCommand(props.source);
  const [selected, setSelected] = useState<string[]>(props.skills);

  return (
    <div className="space-y-3">
      <div className="bg-warning/10 text-warning flex items-start gap-2 rounded-md px-3 py-2 text-xs">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The skills CLI copies the skills into ~/.agents/skills, where they load like skills you
          copied there by hand. Xum does not run the CLI, and it does not review, update or remove
          these skills.
        </span>
      </div>
      <SkillNameChooser
        skills={props.skills}
        selected={selected}
        disabled={cli.loading}
        onChange={(next) => {
          // The shown command names the old selection.
          cli.clear();
          setSelected(next);
        }}
      />
      {cli.command !== null && (
        <div className="space-y-1">
          <p className="text-muted text-xs">
            Run this command in a terminal, from your home folder. Inside a project, npx would
            prefer a skills package from that project&apos;s node_modules.
          </p>
          <div className="bg-modal-bg border-border-medium flex items-start gap-2 rounded border px-2 py-1.5">
            <code className="text-foreground min-w-0 flex-1 font-mono text-[11px] break-all">
              {cli.command}
            </code>
            <CopyButton text={cli.command} />
          </div>
        </div>
      )}
      <ErrorAlert message={cli.error} />
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={props.onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <Button
          size="sm"
          onClick={() => void cli.show(selected)}
          disabled={cli.loading || selected.length === 0}
        >
          {cli.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {`Show command (${selected.length})`}
        </Button>
      </div>
    </div>
  );
};
