/**
 * Messages sent from an artifact (Artifacts M5b, design C "hybrid"): the model receives the
 * <artifact_interaction> tag, while the transcript renders the confirmed text and data from
 * metadata with a "from artifact" label. The last user message is a typed lookalike tag without
 * metadata: it must render as an ordinary message with no label.
 */
import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar } from "@/browser/stories/helpers/uiState";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import type { ArtifactInteractionMetadata } from "@/common/types/message";

const meta = { ...appMeta, title: "App/Artifact Interaction" };
export default meta;

const SUBMIT: ArtifactInteractionMetadata = {
  id: "interaction-1",
  artifactPath: "release-checklist.html",
  title: "Release checklist",
  version: 3,
  action: "send",
  text: "Approved for prod. Ship after the 14:00 freeze ends.",
  data: { env: "prod", approve: true },
};

const CHOICE: ArtifactInteractionMetadata = {
  id: "interaction-2",
  artifactPath: "rollout.canary.json",
  title: "Which rollout plan?",
  version: 1,
  action: "send",
  text: "Canary 10% for 1 hour",
};

function tagFor(data: ArtifactInteractionMetadata): string {
  const body = JSON.stringify(
    data.data === undefined ? { text: data.text } : { text: data.text, data: data.data }
  );
  return `<artifact_interaction artifact="${data.artifactPath}" title="${data.title}" version="${data.version}" action="send">${body}</artifact_interaction>`;
}

function setup(workspaceId: string) {
  collapseLeftSidebar();
  const t = STABLE_TIMESTAMP;
  const fromArtifact = (id: string, seq: number, data: ArtifactInteractionMetadata) =>
    createUserMessage(id, tagFor(data), {
      historySequence: seq,
      timestamp: t - 60_000,
      muxMetadata: { type: "normal", artifactInteraction: data },
    });
  return setupSimpleChatStory({
    workspaceId,
    messages: [
      createUserMessage("m1", "Prepare the release and let me sign off.", {
        historySequence: 1,
        timestamp: t - 300_000,
      }),
      createAssistantMessage(
        "m2",
        "I wrote **Release checklist** (v3) in the Artifacts tab. Fill it in when you are ready.",
        { historySequence: 2, timestamp: t - 290_000 }
      ),
      fromArtifact("m3", 3, SUBMIT),
      createAssistantMessage("m4", "Thanks. One more decision: **Which rollout plan?**", {
        historySequence: 4,
        timestamp: t - 50_000,
      }),
      fromArtifact("m5", 5, CHOICE),
      createUserMessage("m6", tagFor({ ...CHOICE, id: "typed", text: "typed by hand" }), {
        historySequence: 6,
        timestamp: t - 20_000,
      }),
    ],
  });
}

/** Laptop and phone, dark and light. */
export const Hybrid: AppStory = {
  parameters: {
    ...appMeta.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone", "laptop"] } },
  },
  render: () => <AppWithMocks setup={() => setup("ws-artifact-interaction")} />,
};
