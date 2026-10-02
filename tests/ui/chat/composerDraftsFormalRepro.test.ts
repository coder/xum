/**
 * Repros of composer-draft counterexamples found by the TLA+ model in formal/composer-drafts/
 * (ComposerDrafts.tla; run formal/composer-drafts/check.sh). The backend is real; only
 * WorkspaceService.sendMessage is wrapped to hold or fail its reply.
 *
 * D1 (MC_send_restore, known: #5226 item 12): a send clears what it took from the composer
 * before the RPC, and a failure puts the whole pre-send draft back (`setDraft(preSendDraft)`,
 * ChatInput). Text that reached the composer while the send was in flight (another window's
 * edit, a restore, typing once the stream is starting) is replaced and then saved over, so it is
 * lost.
 *
 * D4 (MC_quit_during_send): the optimistic clear is saved to the backend draft by the normal
 * debounce while the send is still being prepared (stream startup can take seconds). If the app
 * quits or crashes in that window, the backend never accepted the message and the durable draft
 * is already empty: the text exists nowhere durable.
 *
 * D2 (MC_send_restore, suspected design gap): when the backend accepted the message but the RPC
 * then failed, the same restore puts the sent text back into the composer next to the message
 * that is already in the transcript (sendMessage carries no idempotency key, so sending it again
 * duplicates it).
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { waitFor } from "@testing-library/react";

import { getDraftStore } from "@/browser/stores/DraftStore";
import type { DraftScope } from "@/common/orpc/schemas/drafts";
import { expectReproFailure } from "@/node/utils/formalRepro.testHarness";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const WAIT = { timeout: 30_000 };
/** Each repro's target fails like this until its finding is fixed (formalRepro.testHarness). */
const STILL_FAILS = (expected: boolean) => ({
  matcher: "toBe",
  expected: String(expected),
  received: String(!expected),
});

type SendMessage = AppHarness["env"]["services"]["workspaceService"]["sendMessage"];

/** Holds every sendMessage reply until `release()`, then answers with `reply`. */
function holdSendReplies(
  app: AppHarness,
  reply: (realSend: SendMessage, args: Parameters<SendMessage>) => ReturnType<SendMessage>
) {
  const workspaceService = app.env.services.workspaceService;
  const realSend: SendMessage = workspaceService.sendMessage.bind(workspaceService);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = jest
    .spyOn(workspaceService, "sendMessage")
    .mockImplementation(async (...args: Parameters<SendMessage>) => {
      await gate;
      return await reply(realSend, args);
    });
  return { spy, release: () => release() };
}

const refused = () =>
  Promise.resolve({
    success: false as const,
    error: { type: "unknown" as const, raw: "formal repro: send refused" },
  });

describe("formal/composer-drafts: composer text across a failed send", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a failed send keeps text another window typed while it was in flight (D1)", async () => {
    await expectReproFailure(async () => {
      const app = await createAppHarness({ branchPrefix: "formal-send-typed" });
      const held = holdSendReplies(app, () => refused());
      try {
        const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
        await app.chat.send("first message");
        await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(1), WAIT);
        await waitFor(() => expect(getDraftStore().getView(scope).text).toBe(""), WAIT);
        // The optimistic clear is saved before the other window types (no simultaneous edit).
        await getDraftStore().flush(scope);
        expect((await app.env.services.draftService.get(scope)).text).toBe("");

        // This window's textarea is disabled while its send is in flight, but a second window on
        // the same workspace keeps typing; its edit reaches this window through the draft events.
        await app.env.services.draftService.update({ scope, text: "typed in another window" });
        await waitFor(
          () => expect(getDraftStore().getView(scope).text).toBe("typed in another window"),
          WAIT
        );

        held.release();
        await waitFor(
          () =>
            expect(app.view.container.textContent ?? "").toContain("formal repro: send refused"),
          WAIT
        );
        await waitFor(() => expect(getDraftStore().getView(scope).text).not.toBe(""), WAIT);
        await getDraftStore().flush(scope);
        const saved = await app.env.services.draftService.get(scope);
        // Target assertion: restoring the failed send's text does not drop the newer text.
        expect(saved.text.includes("typed in another window")).toBe(true);
      } finally {
        held.spy.mockRestore();
        await app.dispose();
      }
    }, STILL_FAILS(true));
  }, 120_000);

  test("control: a failed send with no typing restores the sent text", async () => {
    const app = await createAppHarness({ branchPrefix: "formal-send-restore" });
    try {
      const held = holdSendReplies(app, () => refused());
      await app.chat.send("first message");
      await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(1), WAIT);
      held.release();
      await app.chat.expectInputValue("first message", WAIT.timeout);
      held.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("text of a send still being prepared stays durable until accepted (D4)", async () => {
    await expectReproFailure(async () => {
      const app = await createAppHarness({ branchPrefix: "formal-send-pending" });
      const held = holdSendReplies(app, (realSend, args) => realSend(...args));
      try {
        const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
        await app.chat.send("first message");
        await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(1), WAIT);
        // Force the debounced draft write now (a fixed sleep raced slow CI writes); the backend
        // has not seen the message yet.
        await getDraftStore().flush(scope);
        const saved = await app.env.services.draftService.get(scope);
        // Target assertion: until the backend accepts the message, a durable copy of it exists.
        expect(saved.text.includes("first message")).toBe(true);
      } finally {
        held.release();
        held.spy.mockRestore();
        await app.dispose();
      }
    }, STILL_FAILS(true));
  }, 120_000);

  test("control: once the send is accepted the message is in the transcript", async () => {
    const app = await createAppHarness({ branchPrefix: "formal-send-accepted-control" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains("Mock response: first message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      await getDraftStore().flush(scope);
      expect((await app.env.services.draftService.get(scope)).text).toBe("");
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("a reply lost after the backend accepted does not bring the text back (D2)", async () => {
    await expectReproFailure(async () => {
      const app = await createAppHarness({ branchPrefix: "formal-send-accepted" });
      const held = holdSendReplies(app, async (realSend, args) => {
        await realSend(...args);
        throw new Error("formal repro: reply lost after acceptance");
      });
      try {
        await app.chat.send("accepted message");
        held.release();
        await app.chat.expectTranscriptContains("Mock response: accepted message", WAIT.timeout);
        await app.chat.expectStreamComplete();
        await waitFor(
          () =>
            expect(app.view.container.textContent ?? "").toContain(
              "formal repro: reply lost after acceptance"
            ),
          WAIT
        );
        const value = await app.chat.getInputValue();
        // Target assertion: a message the backend accepted is not put back into the composer.
        expect(value.includes("accepted message")).toBe(false);
      } finally {
        held.spy.mockRestore();
        await app.dispose();
      }
    }, STILL_FAILS(false));
  }, 120_000);
});
