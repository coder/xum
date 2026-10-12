/**
 * The composer accepts typing once the backend runs the turn, even while the send that started
 * it still waits for its reply (#5810). WorkspaceStore reports one turn in two phases: "starting"
 * until stream-start, then interruptible. A composer that stayed usable only in the first phase
 * locked again at stream-start until the send settled, so what the user typed in that moment was
 * dropped (and its focus taken away). The backend is real; WorkspaceService.sendMessage is wrapped
 * only to hold its reply, and the mock turn holds its tool calls so the stream stays open.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { waitFor } from "@testing-library/react";

import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import type { StreamStartEvent } from "@/common/types/stream";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const WAIT = { timeout: 30_000 };

type SendMessage = AppHarness["env"]["services"]["workspaceService"]["sendMessage"];

function composer(app: AppHarness): HTMLTextAreaElement {
  const textareas = app.view.container.querySelectorAll<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]'
  );
  const textarea = textareas.item(textareas.length - 1);
  if (!textarea) throw new Error("Composer textarea not found");
  return textarea;
}

describe("Composer during a turn", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("stays enabled after stream-start while the send's reply is outstanding", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-enabled-during-turn" });
    let releaseReply: () => void = () => undefined;
    try {
      const workspaceService = app.env.services.workspaceService;
      const realSend: SendMessage = workspaceService.sendMessage.bind(workspaceService);
      const replyGate = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      jest
        .spyOn(workspaceService, "sendMessage")
        .mockImplementation(async (...args: Parameters<SendMessage>) => {
          const result = await realSend(...args);
          await replyGate;
          return result;
        });
      const streamStarted = new Promise<void>((resolve) => {
        const onStart = (event: StreamStartEvent) => {
          if (event.workspaceId !== app.workspaceId) return;
          app.env.services.aiService.off("stream-start", onStart);
          resolve();
        };
        app.env.services.aiService.on("stream-start", onStart);
      });

      await app.chat.send("[mock:tool:parallel-step] keep the turn streaming");
      await streamStarted;
      await waitFor(() => {
        if (!workspaceStore.getWorkspaceSidebarState(app.workspaceId).canInterrupt) {
          throw new Error("Expected the turn to be streaming");
        }
      }, WAIT);

      // The reply is still held, so the send has not settled: only the running turn makes the
      // composer usable here.
      await waitFor(() => {
        if (composer(app).disabled) throw new Error("Composer is disabled during the turn");
      }, WAIT);
      await app.chat.typeWithoutSending("next message");

      releaseReply();
      app.env.services.aiService.releaseMockToolCalls(app.workspaceId);
      await app.chat.expectStreamComplete();
      await app.chat.expectInputValue("next message", WAIT.timeout);
    } finally {
      releaseReply();
      await app.dispose();
    }
  }, 120_000);
});
