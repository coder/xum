import { describe, expect, test } from "bun:test";
import type { NameGenerationError } from "@/common/types/errors";
import { Ok, type Result } from "@/common/types/result";
import { WorkspaceNaming } from "@/node/services/workspaceNaming";
import type { GenerateWorkspaceIdentityResult } from "@/node/services/workspaceTitleGenerator";

function draft(): Promise<Result<GenerateWorkspaceIdentityResult, NameGenerationError>> {
  return Promise.resolve(Ok({ name: "fix-login", title: "Fix login", modelUsed: "anthropic:claude-haiku-4-5" }));
}

describe("WorkspaceNaming", () => {
  test("one auto-title claim per workspace until it is released", () => {
    const naming = new WorkspaceNaming();
    expect(naming.claimAutoTitle("ws-a")).toBe(true);
    expect(naming.claimAutoTitle("ws-a")).toBe(false);
    expect(naming.claimAutoTitle("ws-b")).toBe(true);
    naming.releaseAutoTitle("ws-a");
    expect(naming.claimAutoTitle("ws-a")).toBe(true);
  });

  test("a creation takes a form's naming request once, and only recent requests stay", () => {
    const naming = new WorkspaceNaming();
    const first = draft();
    naming.retainDraftNaming("draft-0", first);
    for (let i = 1; i <= 16; i++) naming.retainDraftNaming(`draft-${i}`, draft());

    // The 17th request pushed out the oldest one.
    expect(naming.takeDraftNaming("draft-0")).toBeUndefined();
    const newest = naming.takeDraftNaming("draft-16");
    expect(newest).toBeDefined();
    expect(naming.takeDraftNaming("draft-16")).toBeUndefined();
    expect(naming.takeDraftNaming("draft-1")).toBeDefined();
    expect(naming.takeDraftNaming(undefined)).toBeUndefined();
  });

  test("a fork waits until the creation's naming settles", async () => {
    const naming = new WorkspaceNaming();
    expect(await naming.waitForCreationNaming("ws-a")).toBe(true);

    let settle!: () => void;
    naming.trackCreationNaming(
      "ws-a",
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );
    let waited: boolean | undefined;
    const wait = naming.waitForCreationNaming("ws-a").then((result) => {
      waited = result;
    });
    // A full timer tick: every microtask chain of an already settled wait has run by then.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waited).toBeUndefined();

    settle();
    await wait;
    expect(waited).toBe(true);
  });
});
