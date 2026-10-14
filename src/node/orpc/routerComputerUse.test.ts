import { describe, expect, test } from "bun:test";
import { createRouterClient, type RouterClient } from "@orpc/server";

import { createTestComputerUseService } from "@/node/services/computerUse/computerUseTestFixtures";
import type { ORPCContext } from "./context";
import { router } from "./router";

type Client = RouterClient<ReturnType<typeof router>>;

describe("computerUse procedures", () => {
  test.each<[string, (client: Client) => Promise<unknown>]>([
    [
      "setEnabled",
      (client) => client.computerUse.setEnabled({ workspaceId: "ssh", enabled: true }),
    ],
    ["toggle", (client) => client.computerUse.toggle({ workspaceId: "ssh" })],
  ])("a refused %s reaches the client with its reason", async (_route, request) => {
    const { service } = createTestComputerUseService({
      runtimes: { ssh: { type: "ssh", host: "example", srcBaseDir: "/home/me/src" } },
    });
    const context = { computerUseService: service } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    const error = await request(client).then(
      () => null,
      (rejection: Error) => rejection
    );
    expect(error).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(error?.message).toContain("only available in local workspaces");
  });
});
