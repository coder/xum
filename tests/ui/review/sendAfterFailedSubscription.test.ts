import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { waitFor } from "@testing-library/react";

import type { Review } from "@/common/types/review";
import type { TestEnvironment } from "../../ipc/setup";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

const NOTE = "attached-note-5011";

function attachedReview(): Review {
  return {
    id: "r1",
    data: { filePath: "a.ts", lineRange: "+1", selectedCode: "x", userNote: NOTE },
    status: "attached",
    createdAt: 1,
  };
}

/** Make every review-state subscription fail (its initial snapshot read throws) while `failing`. */
function breakReviewStateSubscription(env: TestEnvironment) {
  const service = env.services.reviewStateService;
  const original = service.getSnapshotWithRevision.bind(service);
  const control = { failing: true };
  jest.spyOn(service, "getSnapshotWithRevision").mockImplementation((workspaceId: string) => {
    if (control.failing) return Promise.reject(new Error("review state unavailable"));
    return original(workspaceId);
  });
  return control;
}

/**
 * Make the backend refuse every sendMessage (a send that stops after the review read). The
 * reply is delayed like a real round trip, so the UI renders the state before the refusal.
 */
function refuseSends(env: TestEnvironment, raw: string) {
  jest.spyOn(env.services.workspaceService, "sendMessage").mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { success: false, error: { type: "unknown", raw } };
  });
}

/**
 * Every distinct error alert text shown from now on. A toast that appears and is then replaced
 * still counts, so a wrong toast cannot hide behind the real error.
 */
function recordAlerts(container: HTMLElement) {
  const seen = new Set<string>();
  const record = () => {
    for (const alert of container.querySelectorAll('[role="alert"]')) {
      if (alert.textContent) seen.add(alert.textContent);
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return {
    seen,
    stop: () => {
      record();
      observer.disconnect();
    },
  };
}

async function reviewStatus(env: TestEnvironment, workspaceId: string) {
  const snapshot = await env.services.reviewStateService.getSnapshot(workspaceId);
  return snapshot.sections.reviews?.r1?.status;
}

// #5011: a send while the first review-state subscription has failed used to go out without
// the persisted attached notes, silently.
describe("Send after a failed review-state subscription", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("retries the subscription and attaches the persisted notes", async () => {
    let control: { failing: boolean } | undefined;
    const app = await createAppHarness({
      branchPrefix: "review-sub-retry",
      beforeRenderEnvironment: (env) => {
        control = breakReviewStateSubscription(env);
      },
    });

    try {
      await app.env.services.reviewStateService.applyDelta(app.workspaceId, {
        reviews: { set: { r1: attachedReview() } },
      });
      // The composer never saw the note: the subscription is failing.
      expect(app.view.container.textContent).not.toContain(NOTE);

      control!.failing = false;
      await app.chat.send("send with notes");
      await app.chat.expectTranscriptContains("Mock response:");

      // Sent with the message, so the composer marks it checked.
      await waitFor(
        async () => {
          expect(await reviewStatus(app.env, app.workspaceId)).toBe("checked");
        },
        { timeout: 10_000 }
      );
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("a command that sends nothing shows no missing-notes error", async () => {
    const app = await createAppHarness({
      branchPrefix: "review-sub-vim",
      beforeRenderEnvironment: (env) => {
        breakReviewStateSubscription(env);
      },
    });

    try {
      await app.env.services.reviewStateService.applyDelta(app.workspaceId, {
        reviews: { set: { r1: attachedReview() } },
      });

      await app.chat.send("/vim");
      // The command ran (it clears the input) after the bounded review read settled.
      await app.chat.expectInputValue("", 10_000);
      expect(app.view.container.querySelector('[role="alert"]')).toBeNull();
      expect(await reviewStatus(app.env, app.workspaceId)).toBe("attached");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  // #5149: the missing-notes toast belongs to an accepted send only. A send that stops shows
  // just its own error, which the missing-notes toast must neither precede nor replace.
  test("a refused send shows only its own error", async () => {
    const sendError = "send refused 5149";
    const app = await createAppHarness({
      branchPrefix: "review-sub-refused",
      beforeRenderEnvironment: (env) => {
        breakReviewStateSubscription(env);
        refuseSends(env, sendError);
      },
    });

    try {
      await app.env.services.reviewStateService.applyDelta(app.workspaceId, {
        reviews: { set: { r1: attachedReview() } },
      });
      const alerts = recordAlerts(app.view.container);

      await app.chat.send("refused send");
      await waitFor(
        () => {
          expect(app.view.container.querySelector('[role="alert"]')?.textContent).toContain(
            sendError
          );
        },
        { timeout: 10_000 }
      );
      alerts.stop();
      expect([...alerts.seen].filter((text) => !text.includes(sendError))).toEqual([]);
      expect(await reviewStatus(app.env, app.workspaceId)).toBe("attached");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("a /compact that fails to start shows only its own error", async () => {
    const compactError = "compaction refused 5149";
    const app = await createAppHarness({
      branchPrefix: "review-sub-compact",
      beforeRenderEnvironment: (env) => {
        breakReviewStateSubscription(env);
        refuseSends(env, compactError);
      },
    });

    try {
      await app.env.services.reviewStateService.applyDelta(app.workspaceId, {
        reviews: { set: { r1: attachedReview() } },
      });
      const alerts = recordAlerts(app.view.container);

      await app.chat.send("/compact");
      // The failed command restores its text into the composer once it has settled.
      await app.chat.expectInputValue("/compact", 10_000);
      await waitFor(() => {
        expect(app.view.container.querySelector('[role="alert"]')).not.toBeNull();
      });
      alerts.stop();
      // Only the compaction error, never replaced by the missing-notes toast.
      expect([...alerts.seen].filter((text) => !text.includes(compactError))).toEqual([]);
      expect(app.view.container.querySelector('[role="alert"]')?.textContent).toContain(
        compactError
      );
      expect(await reviewStatus(app.env, app.workspaceId)).toBe("attached");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("a started /compact still says the notes were left out", async () => {
    const app = await createAppHarness({
      branchPrefix: "review-sub-compact-ok",
      beforeRenderEnvironment: (env) => {
        breakReviewStateSubscription(env);
      },
    });

    try {
      await app.env.services.reviewStateService.applyDelta(app.workspaceId, {
        reviews: { set: { r1: attachedReview() } },
      });

      await app.chat.send("/compact");
      await waitFor(
        () => {
          expect(app.view.container.querySelector('[role="alert"]')).not.toBeNull();
        },
        { timeout: 10_000 }
      );
      expect(await reviewStatus(app.env, app.workspaceId)).toBe("attached");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("sends without notes and says so when the notes still cannot be loaded", async () => {
    const app = await createAppHarness({
      branchPrefix: "review-sub-broken",
      beforeRenderEnvironment: (env) => {
        breakReviewStateSubscription(env);
      },
    });

    try {
      await app.env.services.reviewStateService.applyDelta(app.workspaceId, {
        reviews: { set: { r1: attachedReview() } },
      });

      expect(app.view.container.querySelector('[role="alert"]')).toBeNull();
      await app.chat.send("send without notes");
      // The user is told (an error toast), not left to find the notes missing.
      await waitFor(
        () => {
          expect(app.view.container.querySelector('[role="alert"]')).not.toBeNull();
        },
        { timeout: 10_000 }
      );
      await app.chat.expectTranscriptContains("Mock response:");
      // Not sent, so it stays attached for the next send.
      expect(await reviewStatus(app.env, app.workspaceId)).toBe("attached");
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
