import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

/**
 * A queued message refused at dispatch (its sub-agent completed its report first) is handed back
 * through `restore-to-input` with `mode: "append"`: the composer keeps what the user typed since
 * and the unsent text is appended after it, so it is visible and recoverable without overwriting
 * the draft. The default (replace) restore — a user Stop — is unchanged.
 */
describe("Unsent queued message restored to the composer", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("append mode preserves the current draft and adds the unsent text after it", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-append" });
    try {
      await app.chat.typeWithoutSending("draft typed after queueing");
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued follow-up that was not sent",
        mode: "append",
      });
      await app.chat.expectInputValue(
        "draft typed after queueing\n\nqueued follow-up that was not sent"
      );
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("the default restore (a Stop's queued input) still replaces the draft", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-replace" });
    try {
      await app.chat.typeWithoutSending("draft to be replaced");
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued input restored by stop",
      });
      await app.chat.expectInputValue("queued input restored by stop");
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
