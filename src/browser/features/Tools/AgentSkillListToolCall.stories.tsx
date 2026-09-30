import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentSkillListToolCall } from "@/browser/features/Tools/AgentSkillListToolCall";
import { PIXEL_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/AgentSkillList",
  component: AgentSkillListToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    // Excluded because the repo-wide Pixel snapshot budget is at its ceiling.
    pixel: PIXEL_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-background p-6">
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof AgentSkillListToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const BROWSER_DESC =
  "Browser automation CLI for AI agents. Use when the user needs to interact with websites — " +
  "navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, " +
  "testing web apps, or automating any browser task. Triggers include requests to “open a " +
  "website”, “fill out a form”, “click a button”, or “take a screenshot”.";

const ADVERTISED: AgentSkillDescriptor[] = [
  { name: "agent-browser", scope: "project", description: BROWSER_DESC },
  {
    name: "db-console",
    scope: "project",
    description:
      "Run read-only SQL against the project’s dev database, inspect schema, and summarize " +
      "results. Use when the user asks to look up a record, check a table, or debug a query. " +
      "Never issues writes or migrations.",
  },
  {
    name: "linear",
    scope: "global",
    description:
      "Search, create, and update Linear issues and projects. Use when the user references a " +
      "ticket, asks to file a bug, or wants to move an issue between states.",
  },
  {
    name: "pdf",
    scope: "built-in",
    description:
      "Read, search, split, and fill PDF documents and extract text, tables, and form fields. " +
      "Use whenever the user attaches a PDF or asks to read, summarize, or edit one.",
  },
  {
    name: "docx",
    scope: "built-in",
    description:
      "Author and revise Microsoft Word documents with styles, headings, and structure. Use " +
      "when the user wants a .docx report or to edit a Word file they shared.",
  },
];

const UNADVERTISED: AgentSkillDescriptor[] = [
  {
    name: "orchestrator",
    scope: "project",
    advertise: false,
    description:
      "Internal planning skill that decomposes a task into sub-agent steps and sequences their " +
      "workspaces. Invoked by the task runner — not intended for direct use.",
  },
  {
    name: "release-notes",
    scope: "global",
    advertise: false,
    description:
      "Generate changelog entries and release notes from merged PRs over a commit range. A " +
      "power-user workflow kept out of the default skill index.",
  },
];

/** Listed · advertised skills only (the default), grouped by scope. */
export const Listed: Story = {
  args: {
    args: { includeUnadvertised: false },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, skills: ADVERTISED },
  },
};

/** Listed · including unadvertised skills (the eye-off chip marks them). */
export const IncludingUnadvertised: Story = {
  args: {
    args: { includeUnadvertised: true },
    status: "completed",
    defaultExpanded: true,
    result: {
      success: true,
      skills: [ADVERTISED[0], UNADVERTISED[0], ADVERTISED[2], UNADVERTISED[1], ADVERTISED[3]],
    },
  },
};

/** The glanceable resting state — collapsed to a count. */
export const Collapsed: Story = {
  args: {
    args: { includeUnadvertised: false },
    status: "completed",
    result: { success: true, skills: ADVERTISED },
  },
};

/** Listed · nothing configured in this workspace. */
export const NothingConfigured: Story = {
  args: {
    args: { includeUnadvertised: false },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, skills: [] },
  },
};

/** Mid-flight, before the result arrives. */
export const Executing: Story = {
  args: {
    args: { includeUnadvertised: false },
    status: "executing",
    defaultExpanded: true,
  },
};

/** Error · the skills directory could not be read. */
export const ErrorResult: Story = {
  args: {
    args: { includeUnadvertised: false },
    status: "failed",
    defaultExpanded: true,
    result: { success: false, error: "Skills directory is unreadable: EACCES .mux/skills" },
  },
};

/**
 * Narrow (~375px) viewport. Pinned to a fixed-width container because the Storybook
 * test-runner renders at desktop width and ignores viewport / Pixel matrix variants, so the
 * mobile case must be forced with a wrapper. The play fails if the long browser-skill
 * description or scope rows overflow horizontally instead of wrapping/clamping.
 */
export const NarrowViewport: Story = {
  args: {
    args: { includeUnadvertised: true },
    status: "completed",
    defaultExpanded: true,
    result: { success: true, skills: [ADVERTISED[0], UNADVERTISED[0], ADVERTISED[3]] },
  },
  decorators: [
    (Story) => (
      <div data-testid="skill-list-card-container" className="w-[375px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    if (!canvasElement.textContent?.includes("agent-browser")) {
      throw new Error("AgentSkillList card did not render its skills");
    }
    const container = canvasElement.querySelector('[data-testid="skill-list-card-container"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("AgentSkillList story container not found");
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `AgentSkillList tool card overflowed its ${container.clientWidth}px container by ` +
          `${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
};
