import React, { useEffect, useState } from "react";
import { ArrowLeft, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";
import { publishAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { AGENT_PLUGIN_INSTALL_METHOD_LABELS } from "@/common/constants/agentPluginInstallMethods";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type {
  AgentPluginInstallMethod,
  AgentPluginInstallPreview,
} from "@/common/orpc/schemas/agentPlugins";
import type { SkillsCliRun, SkillsCliStatus } from "@/common/orpc/schemas/skillsCli";
import { getErrorMessage } from "@/common/utils/errors";
import { skillsCliSourceProblem } from "@/common/utils/skillsCliSource";

/**
 * The "Install as" choice of the Add panel and its Skills CLI method. Managed methods come from
 * the preview (`methods`); the Skills CLI choice is last and needs the skill names, so it is
 * offered only when the repository has SKILL.md files.
 */

/** The choice that is not a managed install: Xum runs the skills CLI. */
const SKILLS_CLI_CHOICE = "skills-cli";

export function installMethodLabel(method: AgentPluginInstallMethod): string {
  return AGENT_PLUGIN_INSTALL_METHOD_LABELS[method.kind];
}

/** A stable choice value per method. A method with fields (a marketplace entry) adds them here. */
function methodKey(method: AgentPluginInstallMethod): string {
  return method.kind;
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

function describeStatus(status: SkillsCliStatus | null): string {
  if (status === null) return "Checking for Node.js…";
  if (status.available) return `Xum runs ${status.package} with Node.js ${status.nodeVersion}.`;
  return `${status.reason} Run shows the command to run in a terminal instead.`;
}

/**
 * Show the end of the run output (the result and errors are last). A module-level ref callback
 * keeps one identity, so React calls it only when the block mounts: the result block mounts
 * once per run (a new run clears the old result), and a re-render does not move the scroll.
 */
function scrollToEnd(node: HTMLPreElement | null) {
  if (node !== null) node.scrollTop = node.scrollHeight;
}

/** The result of one CLI run: its output, or the command to copy when Xum could not run it. */
const SkillsCliResult: React.FC<{ run: SkillsCliRun }> = (props) => {
  const run = props.run;
  if (run.status === "unavailable") {
    return (
      <div className="space-y-1">
        <p className="text-warning text-xs">{run.reason} Run this command in a terminal:</p>
        <div className="bg-modal-bg border-border-medium flex items-start gap-2 rounded border px-2 py-1.5">
          <code className="text-foreground min-w-0 flex-1 font-mono text-[11px] break-all">
            {run.command}
          </code>
          <CopyButton text={run.command} />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className={run.ok ? "text-success-text text-xs" : "text-destructive text-xs"}>
        {run.ok ? "The skills CLI installed the skills." : run.failure}
      </p>
      {/* SECURITY AUDIT: CLI output is untrusted text; React escapes it (no HTML rendering). */}
      <pre
        ref={scrollToEnd}
        className="bg-modal-bg border-border-medium max-h-64 overflow-auto rounded border px-2 py-1.5 font-mono text-[11px] break-all whitespace-pre-wrap"
      >
        {run.output.length > 0 ? run.output : "(no output)"}
      </pre>
    </div>
  );
};

/** Whether Node.js can run the CLI here, fetched on mount (an external system). */
function useSkillsCliStatus(): { status: SkillsCliStatus | null; error: string | null } {
  const { api } = useAPI();
  const [status, setStatus] = useState<SkillsCliStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let ignore = false;
    api.agentPlugins.skillsCliStatus().then(
      (next) => {
        if (!ignore) setStatus(next);
      },
      (err: unknown) => {
        if (!ignore) setError(getErrorMessage(err));
      }
    );
    return () => {
      ignore = true;
    };
  }, [api]);
  return { status, error };
}

/** One CLI run at a time; a successful run refreshes the skill lists. */
function useSkillsCliRun(source: string) {
  const { api } = useAPI();
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<SkillsCliRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (skills: string[]) => {
    if (!api || running || skills.length === 0) return;
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const result = await api.agentPlugins.installWithSkillsCli({ source, skills });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setRun(result.data);
      if (result.data.status === "ran" && result.data.ok) {
        // No backend cache: the skill lists re-read ~/.agents/skills, and mounted composers
        // refresh their cached skill descriptors.
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SKILLS_REFRESH_REQUESTED));
        publishAgentPluginsMutated();
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };
  return { running, run, error, start };
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

/** The Skills CLI method: pick skills, run the pinned CLI, show what it printed. */
export const SkillsCliInstall: React.FC<{
  /** The source as typed in the Add panel (the CLI takes it as is). */
  source: string;
  skills: string[];
  onBack: () => void;
}> = (props) => {
  const cliStatus = useSkillsCliStatus();
  const cliRun = useSkillsCliRun(props.source);
  const [selected, setSelected] = useState<string[]>(props.skills);

  return (
    <div className="space-y-3">
      <div className="bg-warning/10 text-warning flex items-start gap-2 rounded-md px-3 py-2 text-xs">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The skills CLI copies the skills into ~/.agents/skills, where they load like skills you
          copied there by hand. Xum does not review, update or remove them.
        </span>
      </div>
      <p className="text-muted text-xs">{describeStatus(cliStatus.status)}</p>
      <SkillNameChooser
        skills={props.skills}
        selected={selected}
        disabled={cliRun.running}
        onChange={setSelected}
      />
      {cliRun.run !== null && <SkillsCliResult run={cliRun.run} />}
      <ErrorAlert message={cliRun.error ?? cliStatus.error} />
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={props.onBack} disabled={cliRun.running}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <Button
          size="sm"
          onClick={() => void cliRun.start(selected)}
          disabled={cliRun.running || selected.length === 0}
        >
          {cliRun.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {cliRun.running ? "Running…" : `Run skills CLI (${selected.length})`}
        </Button>
      </div>
    </div>
  );
};
