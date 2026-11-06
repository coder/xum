import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { ArtifactToolCall } from "@/browser/features/Tools/ArtifactToolCall";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ArtifactKind } from "@/common/utils/artifactKind";

// Artifact tool-call cards — mirrors ArtifactToolCall.stories.tsx: every published kind plus a
// failed publish in one chat-width column. The story turns the Artifacts experiment on through
// the shared AppConfigStore (cards become clickable); the preview does the same.

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

function Section(props: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {props.label}
      </div>
      {props.children}
    </section>
  );
}

function Gallery() {
  return (
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
    </div>
  );
}

// One experiment-enabled client, shared by the store and the shell. The shell's APIProvider
// reconnects AppConfigStore to whatever client it gets, so handing it a different (empty)
// mock would turn the experiment back off and disable every card.
const ARTIFACTS_CLIENT = createMockORPCClient({
  experiments: { [EXPERIMENT_IDS.ARTIFACTS]: true },
});

function enableArtifacts() {
  getAppConfigStore().setClient(ARTIFACTS_CLIENT);
}

export const GalleryLaptop = () => {
  enableArtifacts();
  return (
    <MuxPreviewShell client={ARTIFACTS_CLIENT}>
      <div className="bg-background text-foreground p-4">
        <Gallery />
      </div>
    </MuxPreviewShell>
  );
};

// The story pins the phone390 viewport; reproduce it with a 390px wrapper.
export const GalleryPhone = () => {
  enableArtifacts();
  return (
    <MuxPreviewShell client={ARTIFACTS_CLIENT}>
      <div className="bg-background text-foreground p-4" style={{ width: 390 }}>
        <Gallery />
      </div>
    </MuxPreviewShell>
  );
};
