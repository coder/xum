import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { ArtifactKind } from "@/common/utils/artifactKind";
import { ArtifactToolCall } from "./ArtifactToolCall";
import { AttachFileToolCall } from "./AttachFileToolCall";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Artifact",
  component: ArtifactToolCall,
} satisfies Meta<typeof ArtifactToolCall>;

export default meta;
type Story = StoryObj<typeof meta>;

const WORKSPACE_ID = "ws-story-artifact-cards";

function published(path: string, kind: ArtifactKind, version: number, title: string) {
  return {
    success: true,
    id: `id-${path}`,
    version,
    path,
    bytes: 2048,
    kind,
    title,
    pin: null,
  } as const;
}

// Titles equal to the file name are omitted on the card ("findings.md · v1").
const CARDS = [
  published("cache-explorer.html", "html", 3, "interactive chart"),
  published("findings.md", "markdown", 1, "findings.md"),
  published("bench-results.json", "json", 2, "p95 by strategy"),
  published("architecture.svg", "svg", 1, "architecture.svg"),
  published("revenue.csv", "csv", 4, "Q1 revenue"),
  published("flows/checkout.mmd", "mermaid", 2, "checkout flow"),
  published(
    "reports/2026/q3/very-long-folder-name/service-latency-breakdown.md",
    "markdown",
    12,
    "latency breakdown with a long title"
  ),
] as const;

function Section(props: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {props.label}
      </div>
      {props.children}
    </section>
  );
}

/** Every card state in one chat-width column: published kinds, a failed publish, attach_file. */
function renderGallery() {
  getAppConfigStore().setClient(
    createMockORPCClient({ experiments: { [EXPERIMENT_IDS.ARTIFACTS]: true } })
  );
  return (
    <div className="bg-background p-4">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <Section label="Published artifacts">
          {CARDS.map((result) => (
            <ArtifactToolCall
              key={result.path}
              toolName="artifact"
              args={{ path: result.path }}
              result={result}
              status="completed"
              workspaceId={WORKSPACE_ID}
            />
          ))}
        </Section>
        <Section label="Failed publish">
          <ArtifactToolCall
            toolName="artifact"
            args={{ path: "missing.md" }}
            result={{ success: false, error: "File not found in the artifacts folder: missing.md" }}
            status="failed"
            workspaceId={WORKSPACE_ID}
          />
        </Section>
        <Section label="attach_file registered a version">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "findings.md" }}
            result={{
              type: "content",
              value: [{ type: "text", text: "[File shown to user: findings.md]" }],
              ui_only: { artifact: { id: "id-findings.md", version: 2, path: "findings.md" } },
            }}
            status="completed"
            workspaceId={WORKSPACE_ID}
          />
        </Section>
      </div>
    </div>
  );
}

async function waitForGallery(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole("button", { name: /Open in Artifacts/ });
  const cards = await canvas.findAllByRole("button", { name: /in Artifacts$/ });
  await expect(cards).toHaveLength(CARDS.length);
}

export const GalleryLaptop: Story = {
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
  render: renderGallery,
  play: ({ canvasElement }) => waitForGallery(canvasElement),
};

export const GalleryPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  render: renderGallery,
  play: ({ canvasElement }) => waitForGallery(canvasElement),
};
