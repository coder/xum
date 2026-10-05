import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";

import { createTestComputerUseService } from "@/node/services/computerUse/computerUseTestFixtures";
import type { ORPCContext } from "./context";
import { router } from "./router";

describe("computerUse procedures", () => {
  test("a refused request reaches the client with its reason", async () => {
    const { service } = createTestComputerUseService({
      runtimes: { ssh: { type: "ssh", host: "example", srcBaseDir: "/home/me/src" } },
    });
    const context = { computerUseService: service } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    const error = await client.computerUse.setEnabled({ workspaceId: "ssh", enabled: true }).then(
      () => null,
      (rejection: Error) => rejection
    );
    expect(error).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(error?.message).toContain("only available in local workspaces");
  });
});
