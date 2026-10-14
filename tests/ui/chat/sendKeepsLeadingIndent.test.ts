/**
 * #5695: a message that starts with indentation (pasted code) keeps that indentation when sent.
 * Leading blank lines and trailing whitespace are still dropped, and slash commands still parse
 * from the trimmed text.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const WAIT_MS = 30_000;

async function userRowTexts(app: AppHarness): Promise<string[]> {
  const history = await app.env.services
    .toORPCContext()
    .historyService.getHistoryFromLatestBoundary(app.workspaceId);
  if (!history.success) throw new Error(String(history.error));
  return history.data
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
    );
}

describe("sending keeps the first line's indentation (#5695)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("indented code is sent with its leading spaces", async () => {
    const app = await createAppHarness({ branchPrefix: "send-leading-indent" });
    try {
      await app.chat.send("\n  \n    def f():\n        return 1\n\n  ");
      await app.chat.expectTranscriptContains("Mock response:", WAIT_MS);
      await app.chat.expectStreamComplete(WAIT_MS);
      expect(await userRowTexts(app)).toEqual(["    def f():\n        return 1"]);
      await app.chat.expectInputValue("", WAIT_MS);
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
