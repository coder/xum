/**
 * Integration test: when the backend emits a context_exceeded stream error,
 * the frontend should:
 * 1. Auto-compact if a compaction model suggestion is available
 * 2. Show manual "Compact & retry" UI if no suggestion is available
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";
import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { setupProviders } from "../../ipc/setup";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Context exceeded compaction suggestion (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("shows manual compaction when no higher-context model is available", async () => {
    await withSharedWorkspace("openai", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Ensure the workspace view (and chat subscription) is live before sending.
        await waitFor(
          () => {
            const el = view.container.querySelector('textarea[aria-label="Message Claude"]');
            if (!el) throw new Error("Chat textarea not found");
          },
          { timeout: 10_000 }
        );

        await env.orpc.workspace.sendMessage({
          workspaceId,
          message: "Trigger context error",
          options: {
            model: KNOWN_MODELS.GPT.id,
            agentId: "exec",
            providerOptions: {
              openai: {
                forceContextLimitError: true,
              },
            },
          },
        });

        // GPT-5.6 already has the largest curated context window, so removing
        // legacy Grok models should leave the explicit manual recovery action.
        await waitFor(
          () => {
            if (!view.container.textContent?.includes("Insert /compact")) {
              throw new Error("Expected manual compaction action");
            }
          },
          { timeout: 30_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("auto-compacts with the configured compaction model when context is exceeded", async () => {
    await withSharedWorkspace("openai", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      await setupProviders(env, { anthropic: { apiKey: "dummy" }, xai: { apiKey: "dummy" } });
      await env.orpc.config.updateAgentAiDefaults({
        agentAiDefaults: { compact: { modelString: KNOWN_MODELS.HAIKU.id } },
      });

      const expectedCompactionCommand = `/compact -m ${KNOWN_MODELS.HAIKU.id}`;

      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Ensure the workspace view (and chat subscription) is live before sending.
        await waitFor(
          () => {
            const el = view.container.querySelector('textarea[aria-label="Message Claude"]');
            if (!el) throw new Error("Chat textarea not found");
          },
          { timeout: 10_000 }
        );

        await env.orpc.workspace.sendMessage({
          workspaceId,
          message: "Trigger context error",
          options: {
            model: KNOWN_MODELS.GPT.id,
            agentId: "exec",
            providerOptions: {
              openai: {
                forceContextLimitError: true,
              },
            },
          },
        });

        // Auto-compaction should use the configured compaction model preference.
        // We assert on the rendered /compact command (from muxMetadata.rawCommand).
        await waitFor(
          () => {
            if (!view.container.textContent?.includes(expectedCompactionCommand)) {
              throw new Error(
                `Expected auto-compaction with configured model: ${expectedCompactionCommand}`
              );
            }
          },
          { timeout: 30_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);
});
