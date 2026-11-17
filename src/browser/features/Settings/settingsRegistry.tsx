import type { ReactNode } from "react";
import {
  ArchiveRestore,
  Blocks,
  Bot,
  Brain,
  Container,
  Cpu,
  FlaskConical,
  HeartPulse,
  Key,
  Keyboard,
  Lock,
  Monitor,
  Palette,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  ShieldHalf,
  SquareTerminal,
} from "lucide-react";

/**
 * Settings navigation and search metadata.
 *
 * Users asked for settings that are easier to find: sections are grouped in the nav, and every
 * setting a row renders is described here once, so the row's label/description and the search
 * index cannot drift apart (a row reads its copy from SETTING_DEFINITIONS by id).
 *
 * This module holds no section components, so section files can import it without a cycle.
 */

export const SETTINGS_GROUPS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "models", label: "Models & tools" },
  { id: "workspaces", label: "Workspaces & security" },
  { id: "advanced", label: "Advanced" },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

export interface SettingsSectionMeta {
  /** Route id (`/settings/<id>`). Existing ids are deep-link contracts: do not rename them. */
  id: string;
  label: string;
  group: SettingsGroupId;
  icon: ReactNode;
  /** One line shown in search results for the section itself. */
  description: string;
  /** Extra search terms for things inside the section that rows do not describe. */
  keywords?: readonly string[];
  experimental?: boolean;
}

const icon = (Icon: typeof Palette) => <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />;

/** Every section in nav order. Gated sections are filtered by getSettingsSections(). */
export const SETTINGS_SECTION_META: readonly SettingsSectionMeta[] = [
  {
    id: "general",
    label: "Appearance",
    group: "general",
    icon: icon(Palette),
    description: "Theme, startup, sidebar and transcript display.",
    keywords: ["general", "ui", "look"],
  },
  {
    id: "terminal",
    label: "Terminal & editor",
    group: "general",
    icon: icon(SquareTerminal),
    description: "Terminal font and badge, external editor and debug logs.",
    keywords: ["shell", "font", "ide", "vscode", "cursor", "zed"],
  },
  {
    id: "keybinds",
    label: "Keybinds",
    group: "general",
    icon: icon(Keyboard),
    description: "Keyboard shortcuts for every action.",
    keywords: ["keyboard", "shortcuts", "hotkeys"],
  },
  {
    id: "tasks",
    label: "Agents",
    group: "agents",
    icon: icon(Bot),
    description: "Task limits, context compaction and per-agent model defaults.",
    keywords: [
      "tasks",
      "sub-agents",
      "agent defaults",
      "model",
      "reasoning",
      "thinking",
      "prompt cache",
      "exec",
      "plan",
    ],
  },
  {
    id: "heartbeat",
    label: "Heartbeats",
    group: "agents",
    icon: icon(HeartPulse),
    description: "Let agents schedule recurring follow-ups.",
    keywords: ["heartbeat tool", "interval", "default prompt", "recurring", "schedule"],
  },
  {
    id: "instructions",
    label: "Instructions",
    group: "agents",
    icon: icon(ScrollText),
    description: "Custom instructions appended to every workspace of a project.",
    keywords: ["system prompt", "custom instructions", "AGENTS.md", "rules"],
  },
  {
    id: "memory",
    label: "Memory",
    group: "agents",
    icon: icon(Brain),
    description: "Memory files the agent shares across projects and workspaces.",
    keywords: ["global memories", "memory files"],
  },
  {
    id: "providers",
    label: "Providers",
    group: "models",
    icon: icon(Key),
    description: "API keys and endpoints for AI providers.",
    keywords: [
      "api key",
      "base url",
      "anthropic",
      "openai",
      "chatgpt",
      "codex",
      "google",
      "gemini",
      "vertex",
      "bedrock",
      "aws",
      "xai",
      "openrouter",
      "ollama",
      "github copilot",
      "coder",
      "gateway",
      "route priority",
      "custom provider",
      "login",
      "oauth",
      "service tier",
      "count ai calls from bash commands",
    ],
  },
  {
    id: "models",
    label: "Models",
    group: "models",
    icon: icon(Cpu),
    description: "Custom models, default model, context windows and fallbacks.",
    keywords: [
      "custom models",
      "built-in models",
      "default model",
      "hide model",
      "context window",
      "1m context",
      "min thinking",
      "model fallbacks",
      "refuses",
      "aliases",
    ],
  },
  {
    id: "mcp",
    label: "MCP",
    group: "models",
    icon: icon(Server),
    description: "Global MCP servers and tool search.",
    keywords: [
      "model context protocol",
      "mcp servers",
      "add server",
      "tool search",
      "oauth",
      "stdio",
      "claude design",
      "tools",
    ],
  },
  {
    id: "plugins",
    label: "Plugins",
    group: "models",
    icon: icon(Blocks),
    description: "Install agent plugins from git repositories.",
    keywords: ["install plugin", "skills", "hooks", "update all", "marketplace", "uninstall"],
  },
  {
    id: "runtimes",
    label: "Runtimes",
    group: "workspaces",
    icon: icon(Container),
    description: "Where workspaces run, isolation, archiving and project folders.",
    keywords: [
      "isolation",
      "local",
      "ssh",
      "docker",
      "dev container",
      "devcontainer",
      "worktree",
      "coder workspace",
      "vs code workspace file",
      "override project settings",
    ],
  },
  {
    id: "sandbox",
    label: "Sandbox & limits",
    group: "workspaces",
    icon: icon(ShieldHalf),
    description: "Agent command sandbox, network access and resource limits.",
    keywords: [
      "agent sandbox",
      "network",
      "allowed hosts",
      "loopback",
      "resource limits",
      "cpu limit",
      "memory limit",
      "cgroup",
      "cores",
      "gib",
    ],
  },
  {
    id: "security",
    label: "Project trust",
    group: "workspaces",
    icon: icon(ShieldCheck),
    description: "Which projects may run hooks and scripts from their repository.",
    keywords: ["security", "trust", "revoke trust", "hooks", "scripts"],
  },
  {
    id: "secrets",
    label: "Secrets",
    group: "workspaces",
    icon: icon(Lock),
    description: "Secrets injected into workspaces, globally or per project.",
    keywords: ["environment variables", "env", "inject", "tokens", "credentials"],
  },
  {
    id: "server-access",
    label: "Server access",
    group: "workspaces",
    icon: icon(Shield),
    description: "Browser sessions signed in to this server.",
    keywords: ["sessions", "devices", "revoke", "log out"],
  },
  {
    id: "remote-connection",
    label: "Remote connection",
    group: "workspaces",
    icon: icon(Monitor),
    description: "Open a remote Xum server in a separate window.",
    keywords: ["server url", "connect", "remote server"],
  },
  {
    id: "experiments",
    label: "Experiments",
    group: "advanced",
    icon: icon(FlaskConical),
    description: "Features still in development.",
    keywords: ["experimental", "beta", "feature flags"],
  },
  {
    id: "backup",
    label: "Backup",
    group: "advanced",
    icon: icon(ArchiveRestore),
    description: "Back up portable settings to a git repository.",
    keywords: ["restore", "dotfiles", "git repository", "sync"],
    experimental: true,
  },
];

export interface SettingDefinition {
  /** Section that renders the row; search opens it and scrolls to the row. */
  section: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  /**
   * Setting that reveals this row (a sub-option shown only while its parent is on). When search
   * opens a hidden row, the parent is highlighted instead.
   */
  parent?: string;
  /** Platform where the row exists at all; search hides it elsewhere. */
  platform?: "desktop" | "browser";
}

/**
 * Settings rendered by SettingRow, keyed by id. Labels keep their existing wording so muscle
 * memory and tests that find rows by label keep working.
 */
export const SETTING_DEFINITIONS = {
  // Appearance
  theme: {
    section: "general",
    label: "Theme",
    description: "Choose your preferred theme",
    keywords: ["dark", "light", "color", "mode"],
  },
  "launch-behavior": {
    section: "general",
    label: "Launch behavior",
    description: "What to show when Xum starts",
    keywords: ["startup", "start", "open", "restore"],
  },
  "sidebar-flat": {
    section: "general",
    label: "Flat chat list",
    description: "Show all chats in a single list with project avatars instead of project folders.",
    keywords: ["sidebar", "folders"],
  },
  "sidebar-age-grouping": {
    section: "general",
    label: "Group sidebar workspaces by age",
    description:
      'Collect older workspaces under collapsible "Older than X days" sections. When off, all workspaces are listed together.',
    keywords: ["older"],
  },
  "sidebar-hide-sub-agents": {
    section: "general",
    label: "Hide sub-agents in the sidebar",
    description:
      "Show only top-level workspaces. Parents summarize hidden sub-agent and workflow activity in their status line.",
  },
  "transcript-full-width": {
    section: "general",
    label: "Full-width chat transcript",
    description: "Let messages use the full chat pane instead of the default readable column.",
    keywords: ["wide", "chat width"],
  },
  "transcript-density": {
    section: "general",
    label: "Transcript density",
    description:
      "Control how much detail the transcript shows. Hyper collapses completed work into expandable summaries.",
    keywords: ["hyper", "compact", "collapse"],
  },
  "bash-collapsed-summaries": {
    section: "general",
    label: "Collapsed bash summaries",
    description:
      "Choose whether collapsed bash tools show the raw command, the model's intent, or both.",
    keywords: ["shell", "intent", "command"],
  },

  // Terminal & editor
  "terminal-font": {
    section: "terminal",
    label: "Terminal Font",
    description: "Set this to a monospace font you like.",
    keywords: ["font family", "nerd font", "monospace"],
  },
  "terminal-font-size": {
    section: "terminal",
    label: "Terminal Font Size",
    description: "Font size for the integrated terminal",
  },
  "terminal-badge": {
    section: "terminal",
    label: "Terminal Badge",
    description: "Show a scroll-fixed workspace/tab watermark over the terminal",
    keywords: ["watermark"],
  },
  "terminal-badge-template": {
    section: "terminal",
    parent: "terminal-badge",
    label: "Terminal Badge Template",
    description: "Tokens: {workspace}, {tab}, {project}, {index}",
  },
  "terminal-badge-position": {
    section: "terminal",
    parent: "terminal-badge",
    label: "Terminal Badge Position",
    description: "Corner of the terminal to pin the badge to",
  },
  "terminal-badge-opacity": {
    section: "terminal",
    parent: "terminal-badge",
    label: "Terminal Badge Opacity",
    description: "Percent (1-100)",
  },
  "terminal-badge-font-size": {
    section: "terminal",
    parent: "terminal-badge",
    label: "Terminal Badge Font Size",
    description: "Font size for the badge text",
  },
  editor: {
    section: "terminal",
    label: "Editor",
    description: "Editor to open files in",
    keywords: ["open in editor", "vs code", "vscode", "cursor", "zed", "ide"],
  },
  "editor-custom-command": {
    section: "terminal",
    parent: "editor",
    label: "Custom Command",
    description: "Command to run (path will be appended)",
    keywords: ["editor", "nvim", "vim"],
  },
  "ssh-host": {
    section: "terminal",
    platform: "browser",
    label: "SSH Host",
    description: "SSH hostname for 'Open in Editor' deep links",
    keywords: ["hostname", "remote"],
  },
  "api-debug-logs": {
    section: "terminal",
    label: "API Debug Logs",
    description: "Record the full input and output of every AI API call",
    keywords: ["debug", "logging", "devtools", "requests"],
  },

  // Agents
  "default-agent": {
    section: "tasks",
    label: "Default new-workspace agent",
    description: "New chats start with this agent.",
    keywords: ["exec", "plan", "new chat"],
  },
  "max-parallel-tasks": {
    section: "tasks",
    label: "Max Parallel Agent Tasks",
    description: "How many agent tasks can run at once.",
    keywords: ["concurrency", "sub-agents", "parallel"],
  },
  "max-nesting-depth": {
    section: "tasks",
    label: "Max Task Nesting Depth",
    description: "How deep agent tasks can spawn their own tasks.",
    keywords: ["sub-agents", "depth", "nested"],
  },
  "plan-implement-replaces": {
    section: "tasks",
    label: "Plan: Implement replaces conversation with plan",
    description:
      "When enabled, clicking Implement on a plan proposal clears previous messages and shows the plan before switching to Exec.",
    keywords: ["propose plan", "clear history"],
  },
  "compaction-strategy": {
    section: "tasks",
    label: "Compaction strategy",
    description: "How to manage context as conversations grow.",
    keywords: ["context", "summarize", "continuous", "token budget", "compact"],
  },
  "keep-screen-awake": {
    section: "tasks",
    platform: "desktop",
    label: "Keep screen awake while agents are working",
    description:
      "Prevents display and system sleep while any chat is streaming or waiting on background bash or workflow activity. Released as soon as all agents are idle.",
    keywords: ["sleep", "power", "display", "caffeinate"],
  },

  // Runtimes
  "coder-archive": {
    section: "runtimes",
    label: "Coder workspace on archive",
    description:
      "Action to take on dedicated Coder workspaces when archiving a chat. Delete is permanent.",
    keywords: ["archiving", "stop", "delete"],
  },
  "worktree-archive": {
    section: "runtimes",
    label: "Worktree archive behavior",
    description:
      "Control whether archived xum-managed worktrees stay on disk, are deleted, or are snapshotted so they can be restored on unarchive.",
    keywords: ["archiving", "snapshot", "checkout"],
  },
  "default-project-dir": {
    section: "runtimes",
    label: "Default project directory",
    description: "Parent folder for new projects and cloned repositories",
    keywords: ["clone", "folder", "path", "projects"],
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingId = keyof typeof SETTING_DEFINITIONS;

/** `data-setting-id` of rows that are not SettingRows, so search can scroll to them. */
export const experimentAnchorId = (experimentId: string) => `experiment:${experimentId}`;
export const keybindAnchorId = (keybindId: string) => `keybind:${keybindId}`;
export const providerAnchorId = (provider: string) => `provider:${provider}`;

export function getSettingDefinition(id: SettingId): SettingDefinition {
  return SETTING_DEFINITIONS[id];
}
