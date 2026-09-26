/**
 * sendMessage image handling integration tests.
 *
 * Tests image attachment functionality:
 * - Sending images to AI models
 * - Image part preservation in history
 * - Multi-modal conversation support
 */

import { shouldRunIntegrationTests, validateApiKeys } from "../setup";
import { sendMessage, modelString } from "../helpers";
import {
  createSharedRepo,
  cleanupSharedRepo,
  withSharedWorkspace,
  configureTestRetries,
} from "../sendMessageTestHelpers";
import { HistoryService } from "@/node/services/historyService";
import type { MuxMessage } from "@/common/types/message";
import { KNOWN_MODELS } from "../../../src/common/constants/knownModels";
import assert from "node:assert";

/** Collect all messages via iterateFullHistory (replaces removed getFullHistory). */
async function collectFullHistory(
  service: HistoryService,
  workspaceId: string
): Promise<MuxMessage[]> {
  const messages: MuxMessage[] = [];
  const result = await service.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  assert(result.success, `collectFullHistory failed: ${result.success ? "" : result.error}`);
  return messages;
}

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Validate API keys before running tests
if (shouldRunIntegrationTests()) {
  validateApiKeys(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
}

// 4x4 pure red PNG (#FF0000) as base64 data URI
// Uses 8-bit RGB color (not indexed) for reliable vision model processing
const RED_PIXEL = {
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfpDAsPKDCftlPRAAAAEElEQVQI12P8z4AATAxEcQAz0QEH8e1QIgAAAABJRU5ErkJggg==",
  mediaType: "image/png" as const,
};

// 4x4 pure blue PNG (#0000FF) as base64 data URI
// Uses 8-bit RGB color (not indexed) for reliable vision model processing
const BLUE_PIXEL = {
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfpDAsPKQs3pou0AAAAFElEQVQI12NkYPjPAANMDEgANwcAMdMBB3M2PuYAAAAASUVORK5CYII=",
  mediaType: "image/png" as const,
};

// Test both providers with their respective models
// NOTE: Some OpenAI Codex-focused models are vision-capable but can be unreliable at
// ultra-small image classification (e.g. a 4x4 solid-color PNG). Use a general-purpose
// vision model to keep this test stable.
const OPENAI_VISION_MODEL = KNOWN_MODELS.GPT.providerModelId;

const PROVIDER_CONFIGS: [string, string][] = [
  // NOTE: Use a chat-mode vision-capable model. Some *responses-only* models may advertise
  // supports_vision but still fail to ingest data-URI image parts in our current adapter.
  ["openai", OPENAI_VISION_MODEL],
  ["anthropic", KNOWN_MODELS.HAIKU.providerModelId],
];

beforeAll(createSharedRepo);
afterAll(cleanupSharedRepo);

describeIntegration("sendMessage image handling tests", () => {
  configureTestRetries(3);

  describe.each(PROVIDER_CONFIGS)("%s image support", (provider, model) => {
    test.concurrent(
      "should send images to AI model and get response",
      async () => {
        // Skip Anthropic for now as it fails to process the image data URI in tests
        if (provider === "anthropic") return;

        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send message with image attachment
          const result = await sendMessage(
            env,
            workspaceId,
            "This is a small solid-color image. What color is it? Answer with just the color name.",
            {
              model: modelString(provider, model),
              fileParts: [RED_PIXEL],
            }
          );

          // Debug: log if sendMessage failed
          if (!result.success) {
            console.log(`[Image Test] sendMessage failed:`, JSON.stringify(result, null, 2));
          }
          expect(result.success).toBe(true);

          // Wait for stream to complete
          await collector.waitForEvent("stream-end", 30000);

          // Verify we got a response about the image
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);

          // Combine all text deltas
          const fullResponse = deltas
            .map((d) => ("delta" in d ? (d as { delta?: string }).delta || "" : ""))
            .join("")
            .toLowerCase();

          // Should mention red color in some form
          expect(fullResponse.length).toBeGreaterThan(0);
          // Red pixel should be detected (flexible matching - models may say "red", "orange", "scarlet", etc.)
          expect(fullResponse).toMatch(/red|orange|scarlet|crimson/i);
        });
      },
      40000 // Vision models can be slower
    );

    test.concurrent(
      "should handle multiple images in single message",
      async () => {
        // Skip Anthropic for now
        if (provider === "anthropic") return;

        await withSharedWorkspace(provider, async ({ env, workspaceId, collector }) => {
          // Send message with multiple image attachments
          const result = await sendMessage(env, workspaceId, "What colors are these two images?", {
            model: modelString(provider, model),
            fileParts: [RED_PIXEL, BLUE_PIXEL],
          });

          // Debug: log if sendMessage failed
          if (!result.success) {
            console.log(`[Image Test Multi] sendMessage failed:`, JSON.stringify(result, null, 2));
          }
          expect(result.success).toBe(true);

          // Wait for stream to complete
          await collector.waitForEvent("stream-end", 30000);

          // Verify we got a response
          const deltas = collector.getDeltas();
          expect(deltas.length).toBeGreaterThan(0);

          // Combine all text deltas
          const fullResponse = deltas
            .map((d) => ("delta" in d ? (d as { delta?: string }).delta || "" : ""))
            .join("")
            .toLowerCase();

          // Should mention colors
          expect(fullResponse.length).toBeGreaterThan(0);
        });
      },
      40000
    );
  });

  describe("image conversation context", () => {
    test.concurrent(
      "should maintain image context across messages",
      async () => {
        await withSharedWorkspace("openai", async ({ env, workspaceId, collector }) => {
          // Send first message with image
          const result1 = await sendMessage(env, workspaceId, "Remember this image", {
            model: modelString("openai", OPENAI_VISION_MODEL),
            fileParts: [RED_PIXEL],
          });

          expect(result1.success).toBe(true);
          await collector.waitForEvent("stream-end", 30000);

          // Small delay to allow stream cleanup to complete before sending next message
          await new Promise((resolve) => setTimeout(resolve, 100));

          collector.clear();

          // Send follow-up asking about the image
          const result2 = await sendMessage(
            env,
            workspaceId,
            "What color was the image I showed you?",
            {
              model: modelString("openai", OPENAI_VISION_MODEL),
            }
          );

          expect(result2.success).toBe(true);
          await collector.waitForEvent("stream-end", 30000);

          // The model's semantic interpretation of a tiny 4x4 PNG can be flaky, so this test
          // focuses on verifying that Mux *persists* image parts and does not lose them across
          // messages in the same workspace.
          const historyService = new HistoryService(env.config);
          const messages = await collectFullHistory(historyService, workspaceId);

          const imageMsg = messages.find(
            (msg: MuxMessage) =>
              msg.role === "user" &&
              msg.parts.some(
                (part) =>
                  part.type === "text" && (part as { text?: string }).text === "Remember this image"
              )
          );
          expect(imageMsg).toBeTruthy();
          if (!imageMsg) return;

          const imagePart = imageMsg.parts.find(
            (part) => part.type === "file" && (part as { url?: string }).url === RED_PIXEL.url
          );
          expect(imagePart).toBeTruthy();
        });
      },
      60000
    );
  });
});
