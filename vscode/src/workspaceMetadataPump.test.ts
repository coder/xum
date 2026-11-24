import { describe, expect, test } from "bun:test";

import type { FrontendWorkspaceMetadata } from "xum/common/types/workspace";
import { pumpWorkspaceMetadata, type WorkspaceMetadataPumpClient } from "./workspaceMetadataPump";

const workspace = (id: string) => ({ id, name: id }) as FrontendWorkspaceMetadata;

// The host replaces the subscription on every refresh (#5109); the old one must go quiet.
describe("pumpWorkspaceMetadata", () => {
  test("an aborted subscription ignores its late events and errors", async () => {
    const controller = new AbortController();
    const client: WorkspaceMetadataPumpClient = {
      workspace: {
        onMetadata: () =>
          Promise.resolve(
            (async function* () {
              yield { type: "snapshot" as const, workspaces: [workspace("parent")] };
              controller.abort(); // replaced while the next event was in flight
              yield { workspaceId: "child", metadata: workspace("child") };
              throw new Error("stream closed");
            })()
          ),
      },
    };
    const seen: string[] = [];
    const errors: unknown[] = [];
    await pumpWorkspaceMetadata({
      client,
      signal: controller.signal,
      onSnapshot: (workspaces) => {
        seen.push(...workspaces.map((w) => w.id));
      },
      onUpdate: (workspaceId) => {
        seen.push(workspaceId);
      },
      onError: (error) => errors.push(error),
    });
    expect(seen).toEqual(["parent"]);
    expect(errors).toEqual([]);
  });
});
