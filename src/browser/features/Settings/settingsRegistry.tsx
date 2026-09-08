import type { ReactNode } from "react";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { TYPESAFE_PROVIDER_KEY } from "@/constants/autoModelRouting";
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
  SlidersHorizontal,
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
    id: "behavior",
    label: "Behavior",
    group: "agents",
    icon: icon(SlidersHorizontal),
    description:
      "Default agent, task limits, plan handoff, context compaction, screen sleep and usage telemetry.",
    keywords: ["tasks", "parallel", "nesting", "compaction", "context", "sleep"],
  },
  {
    id: "tasks",
    label: "Agents",
    group: "agents",
    icon: icon(Bot),
    description: "Model, reasoning and prompt cache defaults per agent.",
    keywords: [
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
  /**
   * Only the built-in provider card renders this control: a custom provider that shadows the
   * built-in id (a legacy `coder`, `bedrock`, `typesafe`) renders its own card without it, so
   * search drops the row then. The Anthropic, OpenAI, xAI and Copilot blocks render on either.
   */
  builtInCardOnly?: true;
  /** Platform where the row exists at all; search hides it elsewhere. */
  platform?: "desktop" | "browser";
  /** Experiment that must be on for the row to exist; search hides it otherwise. */
  experiment?: ExperimentId;
  /** Provider whose card holds the field: search opens Providers with that card expanded. */
  expandProvider?: string;
  /** `data-setting-id` to scroll to when it is not the definition's own id (a provider card). */
  anchor?: string;
}

const providerField = (
  provider: string,
  label: string,
  description: string,
  keywords: readonly string[] = []
): SettingDefinition => ({
  section: "providers",
  label,
  description,
  keywords: [provider, ...keywords],
  // The field's own mark is the target: it mounts once the card expands and scrolls itself into
  // view. A field the card hides right now (WebSocket under Chat Completions) falls back to the
  // card (see settingsSearch).
  expandProvider: provider,
});

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
    section: "behavior",
    label: "Default new-workspace agent",
    description: "New chats start with this agent.",
    keywords: ["exec", "plan", "new chat"],
  },
  "max-parallel-tasks": {
    section: "behavior",
    label: "Max Parallel Agent Tasks",
    description: "How many agent tasks can run at once.",
    keywords: ["concurrency", "sub-agents", "parallel"],
  },
  "max-nesting-depth": {
    section: "behavior",
    label: "Max Task Nesting Depth",
    description: "How deep agent tasks can spawn their own tasks.",
    keywords: ["sub-agents", "depth", "nested"],
  },
  "plan-implement-replaces": {
    section: "behavior",
    label: "Plan: Implement replaces conversation with plan",
    description:
      "When enabled, clicking Implement on a plan proposal clears previous messages and shows the plan before switching to Exec.",
    keywords: ["propose plan", "clear history"],
  },
  "compaction-strategy": {
    section: "behavior",
    label: "Compaction strategy",
    description: "How to manage context as conversations grow.",
    keywords: ["context", "summarize", "continuous", "token budget", "compact"],
  },
  "keep-screen-awake": {
    section: "behavior",
    platform: "desktop",
    label: "Keep screen awake while agents are working",
    description:
      "Prevents display and system sleep while any chat is streaming or waiting on background bash or workflow activity. Released as soon as all agents are idle.",
    keywords: ["sleep", "power", "display", "caffeinate"],
  },
  "usage-telemetry": {
    section: "behavior",
    label: "Usage Telemetry",
    description: "Send anonymous usage events to help improve Xum — no code, paths, or prompts.",
    keywords: ["privacy", "analytics", "tracking", "opt out", "posthog"],
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

  // Fields inside sections that keep their own layout: each block carries a SettingsMark with
  // the same id, so search scrolls to it and highlights it.
  "runtime-scope": {
    section: "runtimes",
    label: "Runtime scope",
    description: "Manage runtimes globally or per project.",
    keywords: ["project override", "override project settings"],
  },
  "default-isolation": {
    section: "runtimes",
    label: "Default isolation",
    description: "Where new workspaces run, and how they are isolated.",
    keywords: ["local", "ssh", "coder", "worktree", "docker", "dev container", "new workspace"],
  },
  "project-isolation": {
    section: "runtimes",
    label: "Project isolation",
    description: "Where workspaces run: SSH hosts and Coder workspaces.",
    keywords: ["ssh", "remote host", "coder workspace", "template"],
  },
  "workspace-isolation": {
    section: "runtimes",
    label: "Workspace isolation",
    description: "How each workspace is separated: none, worktree, Docker or dev container.",
    keywords: ["worktree", "docker", "container", "devcontainer", "dev container", "image"],
  },
  "agent-sandbox": {
    section: "sandbox",
    label: "Run agent commands in a sandbox",
    description: "macOS only. Writes stay in the workspace; credentials stay hidden.",
    keywords: ["sandbox", "network", "allowed hosts", "loopback", "any host", "seatbelt"],
  },
  "resource-limits": {
    section: "sandbox",
    label: "Resource limits",
    description: "CPU and memory that all local agent commands share (Linux, cgroup v2).",
    keywords: ["cpu limit", "memory limit", "cores", "gib", "cgroup"],
  },
  "artifacts-cdn": {
    section: "sandbox",
    label: "Allow CDN assets in artifacts",
    description:
      "HTML and SVG artifacts run in a sandbox whose content policy blocks network requests, except scripts, styles and fonts from a few public CDNs (cdnjs, unpkg, jsDelivr, jQuery, Tailwind) and Google Fonts. This is not a full network block: a hostile artifact could still leak data, for example through WebRTC or the paths of those CDN requests. Turn this off to block every CDN.",
    keywords: ["artifacts", "content security policy", "csp", "scripts", "fonts"],
    experiment: EXPERIMENT_IDS.ARTIFACTS,
  },
  "agent-defaults": {
    section: "tasks",
    label: "Agent defaults",
    description: "Model, reasoning and prompt cache per agent.",
    keywords: ["model", "reasoning", "thinking", "prompt cache", "exec", "plan", "sub-agents"],
  },
  "heartbeat-enable": {
    section: "heartbeat",
    label: "Let agents set up their own heartbeats",
    description: "Give agents a heartbeat tool to schedule recurring follow-ups.",
    keywords: ["heartbeat tool", "recurring", "follow-up"],
  },
  "heartbeat-interval": {
    section: "heartbeat",
    label: "Default heartbeat interval",
    description: "Minutes between heartbeats for workspaces without their own interval.",
    keywords: ["minutes", "threshold"],
  },
  "heartbeat-prompt": {
    section: "heartbeat",
    label: "Default heartbeat prompt",
    description: "Used when a workspace does not set its own heartbeat message.",
    keywords: ["message"],
  },
  "custom-instructions": {
    section: "instructions",
    label: "Custom instructions",
    description: "Appended to the system prompt of every workspace in the selected project.",
    keywords: ["system prompt", "rules", "AGENTS.md", "project"],
  },
  "provider-route-priority": {
    section: "providers",
    label: "Gateway route priority",
    description: "Drag to choose gateway order for auto routing.",
    keywords: ["gateway", "order", "routing"],
  },
  "custom-provider-add": {
    section: "providers",
    label: "Add a custom provider",
    description:
      "Providers that use OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages.",
    keywords: ["openai compatible", "base url", "api format", "self-hosted"],
  },
  "bash-ai-calls": {
    section: "providers",
    label: "Count AI calls from bash commands",
    description: "Include model calls made by agent shell commands in usage and costs.",
    keywords: ["costs", "usage", "proxy", "billing"],
  },
  "evaluation-credential": {
    section: "providers",
    label: "Evaluation API key",
    description: "Credential for the Auto model and thinking routing evaluation.",
    keywords: ["typesafe", "auto routing"],
    experiment: EXPERIMENT_IDS.AUTO_MODEL_ROUTING,
    builtInCardOnly: true,
    // The API-key editor mounts only while the TypeSafe card is expanded.
    expandProvider: TYPESAFE_PROVIDER_KEY,
  },
  "anthropic-cache-ttl": providerField(
    "anthropic",
    "Prompt cache TTL",
    "How long Anthropic keeps cached prompts.",
    ["1 hour", "5 minutes"]
  ),
  "anthropic-beta": providerField(
    "anthropic",
    "Anthropic beta features",
    "Opt in to beta features."
  ),
  "openai-oauth": providerField(
    "openai",
    "ChatGPT (Codex) OAuth",
    "Sign in with ChatGPT to use your plan.",
    ["login", "codex", "chatgpt"]
  ),
  "openai-default-auth": providerField(
    "openai",
    "Default auth",
    "Use ChatGPT OAuth or the OpenAI API key when both are set."
  ),
  "openai-service-tier": providerField("openai", "Service tier", "OpenAI service tier.", [
    "flex",
    "priority",
  ]),
  "openai-wire-format": providerField("openai", "Wire format", "Responses or Chat Completions.", [
    "responses",
    "chat completions",
  ]),
  "openai-websocket": providerField(
    "openai",
    "WebSocket transport",
    "Use OpenAI's Responses WebSocket transport (experimental)."
  ),
  "openai-cyber": providerField("openai", "Enable cyber model", "Show a Cyber thinking option."),
  "openai-response-storage": providerField(
    "openai",
    "Response storage",
    "Whether OpenAI stores responses.",
    ["store"]
  ),
  "xai-processing-mode": providerField("xai", "Processing mode", "Standard or fast (priority).", [
    "grok",
  ]),
  "copilot-login": providerField(
    "github-copilot",
    "GitHub Copilot login",
    "Sign in to GitHub Copilot.",
    ["copilot", "oauth"]
  ),
  "coder-login": {
    ...providerField("coder", "Coder login", "Connect Xum to your Coder deployment.", [
      "deployment url",
      "oauth",
    ]),
    builtInCardOnly: true,
  },
  "coder-model-routing": {
    ...providerField(
      "coder",
      "Coder model routing",
      "Which Coder provider native models use when route priority picks Coder."
    ),
    builtInCardOnly: true,
  },
  "bedrock-credentials": {
    ...providerField(
      "bedrock",
      "Bedrock credentials",
      "Region, AWS profile, bearer token or access keys.",
      ["aws", "region", "profile", "access key"]
    ),
    builtInCardOnly: true,
  },
  "vertex-credentials": {
    ...providerField(
      "google-vertex",
      "Vertex AI credentials",
      "Project, location and service account key file.",
      ["gcp", "service account", "location"]
    ),
    builtInCardOnly: true,
  },
  "models-filter": {
    section: "models",
    label: "Filter models",
    description: "Find a model in the custom and built-in lists.",
    keywords: ["search"],
  },
  "custom-models": {
    section: "models",
    label: "Custom models",
    description: "Add a model by id, set its context window, route and minimum thinking.",
    keywords: ["add model", "model id", "context window", "1m context", "default model", "hide"],
  },
  "built-in-models": {
    section: "models",
    label: "Built-in models",
    description: "Show, hide or set the default among the built-in models.",
    keywords: ["default model", "hide model", "context window", "min thinking"],
  },
  "model-fallbacks": {
    section: "models",
    label: "Model fallbacks",
    description: "When a model refuses to respond, retry the turn with other models in order.",
    keywords: ["refuses", "retry", "fallback chain"],
  },
  "auto-routing": {
    section: "models",
    label: "Auto routing tiers",
    description: "Evaluation model and the difficulty tiers Auto picks between.",
    keywords: ["evaluation model", "difficulty", "tiers", "classify", "auto"],
    experiment: EXPERIMENT_IDS.AUTO_MODEL_ROUTING,
  },
  "mcp-tool-search": {
    section: "mcp",
    label: "Tool search",
    description: "Defer MCP tool definitions until the model discovers them.",
    keywords: ["tool_catalog_search", "deferred loading"],
  },
  "mcp-servers": {
    section: "mcp",
    label: "MCP servers",
    description: "Enable, test, edit or remove configured servers; OAuth and tool allowlists.",
    keywords: ["oauth", "allowlist", "tools", "view domains"],
  },
  "mcp-add-server": {
    section: "mcp",
    label: "Add MCP server",
    description: "Name, transport (stdio, HTTP, SSE), command or URL, headers.",
    keywords: ["stdio", "http", "sse", "transport", "headers", "command", "url"],
  },
  "claude-design": {
    section: "mcp",
    label: "Claude Design",
    description: "Reuse Claude Code credentials read-only for Claude Design.",
    keywords: ["keychain", "credentials"],
    experiment: EXPERIMENT_IDS.CLAUDE_DESIGN_MCP,
  },
  "plugins-installed": {
    section: "plugins",
    label: "Installed plugins",
    description: "Add, update, review components and hooks, or uninstall plugins.",
    keywords: ["add plugin", "install", "update all", "check for updates", "uninstall", "hooks"],
  },
  "secrets-editor": {
    section: "secrets",
    label: "Secrets",
    description: "Add secrets globally or per project, and choose which are injected.",
    keywords: ["add secret", "inject", "environment variables", "env", "global", "project"],
  },
  "project-trust": {
    section: "security",
    label: "Trusted projects",
    description: "Trusted projects can run hooks and scripts from the repository.",
    keywords: ["trust", "revoke trust", "hooks", "scripts"],
  },
  "server-sessions": {
    section: "server-access",
    label: "Server access sessions",
    description: "Browser sessions signed in to this server; revoke the ones you no longer trust.",
    keywords: ["revoke", "log out", "devices", "revoke other sessions"],
  },
  "lan-bind": {
    section: "server-access",
    label: "LAN / VPN access",
    description: "Bind host, port and web UI for the API server.",
    keywords: ["bind host", "port", "tailscale", "0.0.0.0", "web ui", "auth token", "network"],
    experiment: EXPERIMENT_IDS.CONFIGURABLE_BIND_URL,
  },
  "remote-server-url": {
    section: "remote-connection",
    label: "Remote server URL",
    description: "Open a remote Xum server in a separate window.",
    keywords: ["connect", "disconnect"],
  },
  "global-memories": {
    section: "memory",
    label: "Global memories",
    description: "Memory files the agent shares across every project and workspace.",
    keywords: ["memory files"],
  },
  "dream-cost-ceiling": {
    section: "memory",
    label: "Dream cost ceiling",
    description: "Spending limit for a memory consolidation run.",
    keywords: ["consolidation", "usd", "cost"],
    experiment: EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
  },
  "dream-edit-limit": {
    section: "memory",
    label: "Dream edit limit",
    description: "Most memory edits one consolidation run may make.",
    keywords: ["consolidation", "edits"],
    experiment: EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
  },
  "dream-run-timeout": {
    section: "memory",
    label: "Dream run timeout",
    description: "Minutes a consolidation run may take.",
    keywords: ["consolidation", "minutes"],
    experiment: EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
  },
  "backup-repository": {
    section: "backup",
    label: "Backup repository",
    description: "Repository URL, branch and subdirectory the backup writes to.",
    keywords: ["repository url", "branch", "subdirectory", "git", "dotfiles"],
  },
  "backup-contents": {
    section: "backup",
    label: "What to back up and restore",
    description: "Instructions, agents, skills, memory, preferences, plugins, MCP and projects.",
    keywords: ["instructions", "skills", "plugins", "mcp", "projects", "preferences"],
  },
  "backup-access": {
    section: "backup",
    label: "Backup repository access",
    description: "Check that this machine can reach the backup repository.",
    keywords: ["validate", "ssh", "credentials"],
  },
  "backup-preview": {
    section: "backup",
    label: "Preview backup changes",
    description: "Review what a backup would write and what a restore would change.",
    keywords: ["preview", "back up now", "restore"],
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingId = keyof typeof SETTING_DEFINITIONS;

/**
 * Sub-experiments and the parent row they render under (they are no-ops while it is off). Order
 * is the order they list in. Search falls back to the parent row when a child is hidden.
 */
export const SUB_EXPERIMENT_PARENTS: Partial<Record<ExperimentId, ExperimentId>> = {
  [EXPERIMENT_IDS.MEMORY_CONSOLIDATION]: EXPERIMENT_IDS.MEMORY,
  [EXPERIMENT_IDS.RLM]: EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
  [EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE]: EXPERIMENT_IDS.ARTIFACTS,
  // Lists under Agent interface view, which itself hides with Artifacts: fall back to Artifacts.
  [EXPERIMENT_IDS.ARTIFACTS_STATUS_PAGE_AGENT]: EXPERIMENT_IDS.ARTIFACTS,
};

export function subExperimentsOf(parent: ExperimentId): readonly ExperimentId[] {
  return (Object.keys(SUB_EXPERIMENT_PARENTS) as ExperimentId[]).filter(
    (child) => SUB_EXPERIMENT_PARENTS[child] === parent
  );
}

/** `data-setting-id` of rows that are not SettingRows, so search can scroll to them. */
export const experimentAnchorId = (experimentId: string) => `experiment:${experimentId}`;
export const keybindAnchorId = (keybindId: string) => `keybind:${keybindId}`;
export const providerAnchorId = (provider: string) => `provider:${provider}`;

export function getSettingDefinition(id: SettingId): SettingDefinition {
  return SETTING_DEFINITIONS[id];
}
