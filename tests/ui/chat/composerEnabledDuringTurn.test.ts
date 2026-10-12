/**
 * The composer accepts typing once the backend runs the turn, even while the send that started
 * it still waits for its reply (#5810). WorkspaceStore reports one turn in two phases: "starting"
 * until stream-start, then interruptible. A composer that stayed usable only in the first phase
 * locked again at stream-start until the send settled, so what the user typed in that moment was
 * dropped (and its focus taken away). The backend is real; WorkspaceService.sendMessage is wrapped
 * only to hold its reply, and the mock turn holds its tool calls so the stream stays open.
 *
 * A follow-up send made during that turn still locks the composer until it has taken its draft:
 * before that, a second Send would submit the same text again.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { fireEvent, waitFor } from "@testing-library/react";

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

function sendButton(app: AppHarness): HTMLButtonElement {
  const buttons = app.view.container.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Send message"]'
  );
  const button = buttons.item(buttons.length - 1);
  if (!button) throw new Error("Send button not found");
  return button;
}

/** Start a turn that streams until the test releases its tool calls. */
async function startHeldTurn(app: AppHarness): Promise<void> {
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
}

/** How many times `text` appears in the persisted user rows. */
async function userTextCount(app: AppHarness, text: string): Promise<number> {
  const history = await app.env.services
    .toORPCContext()
    .historyService.getHistoryFromLatestBoundary(app.workspaceId);
  if (!history.success) throw new Error(String(history.error));
  return history.data
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts)
    .reduce(
      (count, part) => count + (part.type === "text" ? part.text.split(text).length - 1 : 0),
      0
    );
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

  test("a follow-up send locks the composer until it has taken its draft", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-follow-up-locks" });
    let releaseResolution: () => void = () => undefined;
    try {
      await startHeldTurn(app);
      // The turn's own send has settled: only the follow-up below is in flight.
      await waitFor(() => {
        if (composer(app).disabled) throw new Error("Composer is disabled during the turn");
      }, WAIT);

      // An inline `$skill` the composer does not list is looked up on the backend before the
      // send takes its draft (agentSkills.get waits for workspace init). Hold that lookup.
      const initStateManager = app.env.services.initStateManager;
      const realWaitForInit = initStateManager.waitForInit.bind(initStateManager);
      const resolutionGate = new Promise<void>((resolve) => {
        releaseResolution = resolve;
      });
      let resolutionHeld = false;
      jest
        .spyOn(initStateManager, "waitForInit")
        .mockImplementation(async (...args: Parameters<typeof realWaitForInit>) => {
          resolutionHeld = true;
          await resolutionGate;
          return realWaitForInit(...args);
        });

      const followUp = "follow up once $no-such-skill";
      await app.chat.typeWithoutSending(followUp);
      fireEvent.click(sendButton(app));
      await waitFor(() => {
        if (!resolutionHeld) throw new Error("The follow-up send did not reach its lookup");
      }, WAIT);

      // The draft still holds the follow-up: a second Send must not submit it again.
      expect(composer(app).value).toBe(followUp);
      await waitFor(() => {
        if (!sendButton(app).disabled) throw new Error("Send is enabled before the draft is taken");
      }, WAIT);
      fireEvent.click(sendButton(app));

      releaseResolution();
      await app.chat.expectInputValue("", WAIT.timeout);
      app.env.services.aiService.releaseMockToolCalls(app.workspaceId);
      await app.chat.expectTranscriptContains(`Mock response: ${followUp}`, WAIT.timeout);
      await app.chat.expectStreamComplete();
      expect(await userTextCount(app, followUp)).toBe(1);
    } finally {
      releaseResolution();
      await app.dispose();
    }
  }, 120_000);
});
