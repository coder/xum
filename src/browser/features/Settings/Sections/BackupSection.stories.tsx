import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PIXEL_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { BackupSection } from "./BackupSection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";
import type { BackupPluginRow } from "@/common/orpc/schemas/backup";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/BackupSection",
  component: BackupSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

function renderBackupSection(rows: BackupPluginRow[]) {
  return (
    <SettingsSectionStory
      setup={() =>
        createMockORPCClient({
          backupSettings: {
            repoUrl: "git@github.com:example/dotfiles.git",
            branch: "main",
            path: "xum/",
          },
          backupValidation: {
            reachable: true,
            empty: false,
            credential: "gh",
          },
          backupPreview: {
            pushChanges: [
              { status: "M", path: "mux/preferences.json" },
              { status: "A", path: "mux/memory/global/preferences.md" },
            ],
            restoreChanges: [
              { status: "M", path: "preferences.json" },
              { status: "A", path: "skills/release/SKILL.md" },
            ],
            localOnlyFiles: ["agents/local-only.md"],
            redactions: ["mcp.jsonc: github.headers.Authorization"],
            commandApprovals: [
              {
                path: "servers.notes.command",
                command: "npx -y @modelcontextprotocol/server-filesystem /home/dev/notes",
                token: "8d2e4787fcc88a36cbd9067997213f1a791ec3999af6e9bf2259f6f3a1a0337e",
              },
            ],
            projectImports: [
              {
                sourcePath: "/home/dev/src/rocket",
                name: "rocket",
                gitRemote: "git@github.com:dev/rocket.git",
                memoryFileCount: 3,
                token: "1f4c9a2b8d6e0f31a5c7e9b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b",
              },
            ],
            projectBundleSkipped: false,
            plugins: { rows, skipped: false, warnings: [] },
            pushError: null,
          },
        })
      }
    >
      <div className="bg-background min-h-screen p-4 sm:p-6">
        <BackupSection />
      </div>
    </SettingsSectionStory>
  );
}

export const Configured: Story = {
  render: () => renderBackupSection([]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Settings backup");
    await userEvent.click(canvas.getByRole("button", { name: "Validate" }));
    await canvas.findByText(/Credential used: GitHub CLI/i);
    await userEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Backup to repository");
    await canvas.findByText("Restore to this device");
    await canvas.findByText(/github\.headers\.Authorization/i);
    await canvas.findByText("agents/local-only.md");
    await canvas.findByRole("checkbox", { name: "Approve MCP command changes" });
    await canvas.findByText("Projects to reimport");
  },
};

export const Phone: Story = {
  globals: {
    viewport: { value: "mobile2", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  render: () => renderBackupSection([]),
  // The import cards only exist after a preview, so the pinned phone snapshot must open
  // one or it never exercises the narrow card layout and its long repository-controlled
  // strings.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Settings backup");
    await userEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Projects to reimport");
    await canvas.findByRole("checkbox", { name: /Import project/ });
  },
};

const PLUGINS_IN_BACKUP: BackupPluginRow[] = [
  {
    name: "pstack",
    source: {
      type: "git",
      url: "https://github.com/cursor/plugins.git",
      ref: "main",
      refType: "branch",
      subpath: "pstack",
    },
    lockedSha: "4dd1d05a1b2c3d4e5f60718293a4b5c6d7e8f901",
    importedComponents: { skills: ["tdd"], mcpServers: [] },
    status: "missing",
  },
  {
    name: "egm",
    source: {
      type: "git",
      url: "https://github.com/google/elephant-goldfish-model.git",
      ref: "v0.3.1",
      refType: "tag",
    },
    lockedSha: "113a3af0123456789abcdef0123456789abcdef0",
    status: "installed",
  },
  {
    // Repository-controlled values with no break point (a hyphen or a space would let the
    // browser wrap them by itself), which must wrap inside the card instead of widening it.
    name: "longname".repeat(8),
    source: {
      type: "git",
      url: `https://git.example.com/${"organization".repeat(8)}/repo.git`,
      ref: `feature/${"branch".repeat(14)}`,
      refType: "branch",
    },
    lockedSha: "0123456789abcdef0123456789abcdef01234567",
    status: "conflict",
  },
  {
    name: "docs-helper",
    source: {
      type: "git",
      url: "https://github.com/example/docs-helper.git",
      ref: "main",
      refType: "branch",
    },
    lockedSha: "89abcdef0123456789abcdef0123456789abcdef",
    status: "folderMissing",
  },
];

/**
 * The plugin card after a preview: a pinned story would add Pixel snapshots (the Storybook budget
 * sits at its cap), so this one has a play test and no snapshot. The phone width is checked by
 * `PluginsInBackupPhone`.
 */
export const PluginsInBackup: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => renderBackupSection(PLUGINS_IN_BACKUP),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Settings backup");
    await userEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Plugins in this backup");
    await canvas.findByText("Not installed");
    await canvas.findByText("Installed");
    await canvas.findByText("Name in use");
    await canvas.findByText("Folder missing");
    await canvas.findByRole("button", { name: /Review and install \(1\)/ });
  },
};

const PHONE_WIDTH_PX = 390;

/**
 * The plugin card at phone width, with no Pixel snapshot. The test runner plays at desktop size
 * and ignores `globals.viewport`, so a fixed-width frame forces the narrow width. The rows carry
 * long repository-controlled strings (a name, a URL and a branch with no break points), which
 * must wrap inside the card: nothing may reach past the frame's right edge. The frame sets no
 * `overflow`, so anything that spills over widens its scroll width.
 */
export const PluginsInBackupPhone: Story = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <div data-testid="phone-frame" style={{ width: PHONE_WIDTH_PX }}>
      {renderBackupSection(PLUGINS_IN_BACKUP)}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Settings backup");
    await userEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    const heading = await canvas.findByText("Plugins in this backup");
    await canvas.findByText("Name in use");

    const frame = canvas.getByTestId("phone-frame");
    const frameRight = frame.getBoundingClientRect().right;
    await expect(frame.getBoundingClientRect().width).toBe(PHONE_WIDTH_PX);
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
    // The scroll width of the frame misses a child clipped by a wrapper, so each element of the
    // card is held to the frame's edge too.
    const card = heading.closest("div.rounded-md");
    await expect(card).not.toBeNull();
    for (const element of card?.querySelectorAll("*") ?? []) {
      await expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(frameRight + 0.5);
    }
  },
};
