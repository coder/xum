import { PROJECT_ISOLATION_UI, WORKSPACE_ISOLATION_UI } from "@/browser/utils/runtimeUi";
import type { IsolationChoice } from "@/common/types/isolation";
import { parsedRuntimeNeedsTrunk, type ParsedRuntime } from "@/common/types/runtime";
import type { BranchLoadStatus } from "./branchListLoad";

/** The creation input that failed validation: Docker image, SSH host, or SSH+None directory. */
export type RuntimeFieldError = "docker" | "ssh" | "sshProjectDir";

/** The base branch as the environment chip shows it. */
export type EnvironmentBranchSummary =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "selected"; name: string };

/**
 * What the creation page's environment chip shows while its panel is closed. The chip replaces
 * the "Run on … with … from …" row of selects, so it must name every choice that row showed.
 */
export interface EnvironmentSummary {
  /** Where commands run: "Local", the SSH host, or "Coder". */
  where: string;
  /** How workspaces are separated; the shared directory when there is no isolation. */
  isolation: string;
  branch: EnvironmentBranchSummary;
  /** The required field Send is waiting for, or null. */
  error: string | null;
}

export interface EnvironmentSummaryInput {
  selectedRuntime: ParsedRuntime;
  isolation: IsolationChoice;
  trunkBranch: string;
  branchLoad: BranchLoadStatus;
  isNonGitRepo: boolean;
  fieldError: RuntimeFieldError | null;
}

function sshHostOf(runtime: ParsedRuntime): string {
  return runtime.mode === "ssh" ? runtime.host.trim() : "";
}

function sshProjectDirOf(runtime: ParsedRuntime): string {
  return runtime.mode === "ssh" ? (runtime.projectDir ?? "").trim() : "";
}

function whereLabel(input: EnvironmentSummaryInput): string {
  // The host says more than "SSH" once it is known; Coder's host is a placeholder.
  if (input.isolation.project === "ssh") {
    return sshHostOf(input.selectedRuntime) || PROJECT_ISOLATION_UI.ssh.label;
  }
  return PROJECT_ISOLATION_UI[input.isolation.project].label;
}

function isolationLabel(input: EnvironmentSummaryInput): string {
  if (input.isolation.workspace !== "none") {
    return WORKSPACE_ISOLATION_UI[input.isolation.workspace].label;
  }
  // "None" alone reads as nothing chosen; name the directory the workspaces share instead.
  if (input.isolation.project === "ssh") {
    return sshProjectDirOf(input.selectedRuntime) || "Directory on host";
  }
  return "Project directory";
}

/**
 * Whether the base branch applies: runtimes that build no checkout need no trunk, and a project
 * without git has no branches to offer.
 */
export function environmentUsesBaseBranch(
  input: Pick<EnvironmentSummaryInput, "selectedRuntime" | "isNonGitRepo">
): boolean {
  return !input.isNonGitRepo && parsedRuntimeNeedsTrunk(input.selectedRuntime);
}

function branchSummary(input: EnvironmentSummaryInput): EnvironmentBranchSummary {
  if (!environmentUsesBaseBranch(input)) return { kind: "hidden" };
  if (input.branchLoad === "loading") return { kind: "loading" };
  if (input.branchLoad === "failed") return { kind: "failed" };
  // A loaded list with no trunk yet shows as loading until the selection settles.
  return input.trunkBranch === ""
    ? { kind: "loading" }
    : { kind: "selected", name: input.trunkBranch };
}

function fieldErrorLabel(input: EnvironmentSummaryInput): string | null {
  switch (input.fieldError) {
    case null:
      return null;
    case "docker":
      return "Docker image missing";
    case "sshProjectDir":
      return "Directory missing";
    case "ssh":
      // Coder reports its incomplete form through the SSH field.
      return input.isolation.project === "coder"
        ? "Coder workspace incomplete"
        : "SSH host missing";
  }
}

export function summarizeEnvironment(input: EnvironmentSummaryInput): EnvironmentSummary {
  return {
    where: whereLabel(input),
    isolation: isolationLabel(input),
    branch: branchSummary(input),
    error: fieldErrorLabel(input),
  };
}

const WHERE_PHRASE = {
  local: () => "on this machine",
  ssh: (host: string) => (host === "" ? "on a remote host over SSH" : `on ${host} over SSH`),
  coder: () => "in a Coder workspace",
} satisfies Record<IsolationChoice["project"], (host: string) => string>;

const ISOLATION_PHRASE = {
  none: (dir: string) => (dir === "" ? "directly in the project directory" : `directly in ${dir}`),
  worktree: () => "in a separate git worktree",
  docker: () => "in a separate container",
  devcontainer: () => "in a dev container",
} satisfies Record<IsolationChoice["workspace"], (dir: string) => string>;

/** The summary as one sentence, for the chip's tooltip and the panel's footer. */
export function describeEnvironment(input: EnvironmentSummaryInput): string {
  const where = WHERE_PHRASE[input.isolation.project](sshHostOf(input.selectedRuntime));
  const isolation = ISOLATION_PHRASE[input.isolation.workspace](
    sshProjectDirOf(input.selectedRuntime)
  );
  const branch = branchSummary(input);
  const from = branch.kind === "selected" ? `, branched from ${branch.name}` : "";
  return `New workspaces run ${where}, ${isolation}${from}.`;
}

const SHORT_FORMS: Array<[RegExp, string]> = [
  [/not logged in|coder login/i, "CLI not logged in"],
  [/is below minimum/i, "CLI out of date"],
  [/CLI not (?:installed|found)/i, "CLI not installed"],
  [/Docker daemon not running/i, "Docker not running"],
  [/^Docker .*not running or not installed/i, "Docker not available"],
  [/^No devcontainer\.json/i, "No devcontainer.json"],
];

/**
 * An unavailable option's reason, cut down to fit one line of its row. The reasons come from the
 * runtime checks and from CLIs, so they can run to three lines ("/opt/homebrew/bin/coder is not
 * logged in. Try logging in using ..."); the row shows the short form and keeps the whole reason
 * for the tooltip and for screen readers.
 *
 * `needsSetup` is false for a reason no setup can change (an unsupported pair, a project that is
 * not a git repository): those rows get no "Set up" link.
 */
export function summarizeUnavailableReason(reason: string): {
  summary: string;
  needsSetup: boolean;
} {
  if (/^Not yet supported|^Requires git repository/i.test(reason)) {
    return { summary: reason, needsSetup: false };
  }
  // The row's name already says which runtime ("Coder", "Dev container"), so the short forms
  // leave it out: next to "Set up", the longer forms were cut off.
  const shortForm = SHORT_FORMS.find(([pattern]) => pattern.test(reason));
  if (shortForm) {
    return { summary: shortForm[1], needsSetup: true };
  }
  // The first clause: up to a sentence end, a "Run: ..." hint or a semicolon.
  const firstClause = /^(.*?)(?:[.;:](?:\s|$)|$)/.exec(reason.trim())?.[1] ?? reason;
  return { summary: firstClause.length > 0 ? firstClause : reason, needsSetup: true };
}
