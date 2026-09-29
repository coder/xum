import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { waitFor } from "@testing-library/react";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getPendingWorkspaceSendErrorKey,
  getReviewStateKey,
  getReviewsKey,
} from "@/common/constants/storage";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

// #5007: structurally invalid persisted values (hand-edited, written by another build, or
// truncated) must self-heal at read time instead of crashing the workspace view through the
// ErrorBoundary.
describe("Malformed persisted workspace state", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a pendingSendError without a known type is dropped instead of crashing the view", async () => {
    const app = await createAppHarness({
      branchPrefix: "bad-pending-error",
      beforeRender: (workspaceId) => {
        updatePersistedState(getPendingWorkspaceSendErrorKey(workspaceId), {
          message: "no type",
        });
      },
    });

    try {
      const errorKey = getPendingWorkspaceSendErrorKey(app.workspaceId);
      await waitFor(() => {
        expect(readPersistedState<unknown>(errorKey, null)).toBeNull();
      });
      expect(app.view.container.textContent).not.toContain("Something went wrong");
      expect(app.view.container.querySelector('[data-testid="message-window"]')).not.toBeNull();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("a valid pendingSendError still surfaces its toast and is cleared", async () => {
    const app = await createAppHarness({
      branchPrefix: "good-pending-error",
      beforeRender: (workspaceId) => {
        updatePersistedState(getPendingWorkspaceSendErrorKey(workspaceId), {
          type: "unknown",
          raw: "creation send failed",
        });
      },
    });

    try {
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("creation send failed");
      });
      expect(
        readPersistedState<unknown>(getPendingWorkspaceSendErrorKey(app.workspaceId), null)
      ).toBeNull();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("malformed legacy review keys leave the view usable and are removed", async () => {
    const app = await createAppHarness({
      branchPrefix: "bad-review-keys",
      beforeRender: (workspaceId) => {
        // Legacy keys are refused by the key registry now; seed them as an older build left them.
        window.localStorage.setItem(getReviewsKey(workspaceId), JSON.stringify({}));
        // A known field holding a malformed entry must be dropped too, not imported.
        window.localStorage.setItem(
          getReviewStateKey(workspaceId),
          JSON.stringify({ readState: { hunk: "yes" } })
        );
      },
    });

    try {
      await waitFor(
        () => {
          expect(readPersistedState<unknown>(getReviewsKey(app.workspaceId), null)).toBeNull();
          expect(readPersistedState<unknown>(getReviewStateKey(app.workspaceId), null)).toBeNull();
        },
        { timeout: 10_000 }
      );
      expect(app.view.container.textContent).not.toContain("Something went wrong");
      expect(app.view.container.querySelector('[data-testid="message-window"]')).not.toBeNull();
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
