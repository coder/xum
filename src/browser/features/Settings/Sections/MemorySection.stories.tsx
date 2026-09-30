import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { MemoryFileInfo } from "@/common/orpc/schemas/memory";
import { MemorySection } from "./MemorySection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";

// Settings → Memory only manages the global scope (no workspace context),
// so the fixture is global files only — incl. a nested path, a pinned file,
// and used/never-used usage-stat permutations.
const GLOBAL_MEMORY_FILES: MemoryFileInfo[] = [
  {
    path: "/memories/global/preferences.md",
    scope: "global",
    description: "Coding style and tooling preferences",
    pinned: true,
    accessCount: 12,
    lastAccessedAt: Date.now() - 3_600_000,
  },
  {
    path: "/memories/global/people/reviewers.md",
    scope: "global",
    description: "Preferred reviewers per code area",
    pinned: false,
    accessCount: 3,
    lastAccessedAt: Date.now() - 86_400_000,
  },
  {
    path: "/memories/global/glossary.md",
    scope: "global",
    description: "",
    pinned: false,
    accessCount: 0,
    lastAccessedAt: null,
  },
];

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/MemorySection",
  component: MemorySection,
};

export default meta;

type Story = StoryObj<typeof meta>;

function renderMemorySection(memoryFiles: MemoryFileInfo[]) {
  return (
    <SettingsSectionStory setup={() => createMockORPCClient({ memoryFiles })}>
      <div className="bg-background p-6">
        <MemorySection />
      </div>
    </SettingsSectionStory>
  );
}

export const WithFiles: Story = {
  render: () => renderMemorySection(GLOBAL_MEMORY_FILES),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("preferences.md");
    await canvas.findByText("glossary.md");
  },
};

export const Empty: Story = {
  render: () => renderMemorySection([]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/No memory files yet/);
  },
};
