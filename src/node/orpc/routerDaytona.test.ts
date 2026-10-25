import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createRouterClient } from "@orpc/server";

import { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { DAYTONA_BUSY_MESSAGE } from "@/node/services/daytona/daytonaAccount";
import { DaytonaService } from "@/node/services/daytona/daytonaService";
import type { ORPCContext } from "./context";
import { router } from "./router";

describe("daytona procedures", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-router-daytona-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  test("a settings refusal reaches the client as a bad request with its reason", async () => {
    const daytonaService = new DaytonaService({
      credentialsStore: new DaytonaCredentialsStore(rootDir, {}),
      rootDir,
    });
    const context = { daytonaService } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    let release!: () => void;
    const lease = daytonaService.account.withAccountLease(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const error = await client.daytona.setConfig({ apiKey: "k" }).then(
      () => null,
      (rejection: Error) => rejection
    );
    release();
    await lease;
    expect(error).toMatchObject({ code: "BAD_REQUEST" });
    expect(error?.message).toContain(DAYTONA_BUSY_MESSAGE);
  });
});
