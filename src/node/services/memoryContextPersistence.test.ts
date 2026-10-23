import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

import { Config } from "@/node/config";

import { MEMORY_CONTEXT_FILE_NAME, MemoryContextStore } from "./memoryContextPersistence";
import { DisposableTempDir } from "./tempDir";

const WORKSPACE_ID = "workspace-memory-context-file";

/** The file schema of builds that still had the Memory Hot Set experiment. */
const OldBuildFileSchema = z.object({
  version: z.literal(1),
  windowKey: z.string().min(1),
  contexts: z.record(
    z.string(),
    z.object({
      context: z
        .object({
          indexEntries: z.array(z.object({ path: z.string(), description: z.string() })),
          hotMemoriesBlock: z.string().nullable(),
        })
        .nullable(),
      includesHotMemories: z.boolean(),
      memoryEnabled: z.boolean(),
      hotSetEnabled: z.boolean(),
    })
  ),
});

/** canReuseMemoryContext of those builds. */
function oldBuildReuses(
  cached: z.infer<typeof OldBuildFileSchema>["contexts"][string],
  wanted: { memoryEnabled: boolean; hotSetEnabled: boolean; includeHotMemories: boolean }
): boolean {
  return (
    cached.memoryEnabled === wanted.memoryEnabled &&
    cached.hotSetEnabled === wanted.hotSetEnabled &&
    (cached.includesHotMemories || !wanted.includeHotMemories)
  );
}

describe("MemoryContextStore", () => {
  // After a downgrade, a rebuilt context can hold a different memory index, and Anthropic
  // then rejects the replayed thinking blocks with a 400.
  test("writes a file that an older build with Hot Set off reuses", async () => {
    using tempDir = new DisposableTempDir("memory-context-downgrade");
    const config = new Config(tempDir.path);
    const store = new MemoryContextStore(config, WORKSPACE_ID);
    const indexEntries = [{ path: "/memories/global/a.md", description: "note" }];
    expect(
      await store.save(
        "window-1",
        new Map([
          ["with-memory", { context: { indexEntries }, memoryEnabled: true }],
          ["memory-off", { context: null, memoryEnabled: false }],
        ])
      )
    ).toBe(true);

    const raw = await fs.readFile(
      path.join(config.sessionsDir, WORKSPACE_ID, MEMORY_CONTEXT_FILE_NAME),
      "utf-8"
    );
    const old = OldBuildFileSchema.parse(JSON.parse(raw));
    const withMemory = old.contexts["with-memory"];
    expect(withMemory.context).toEqual({ indexEntries, hotMemoriesBlock: null });
    // The older build asks index-only first, then with the hot set when it kept memory.
    for (const includeHotMemories of [false, true]) {
      expect(
        oldBuildReuses(withMemory, {
          memoryEnabled: true,
          hotSetEnabled: false,
          includeHotMemories,
        })
      ).toBe(true);
      expect(
        oldBuildReuses(old.contexts["memory-off"], {
          memoryEnabled: false,
          hotSetEnabled: false,
          includeHotMemories,
        })
      ).toBe(true);
    }
    // An older build with Hot Set on must rebuild: the saved context holds no hot block.
    expect(
      oldBuildReuses(withMemory, {
        memoryEnabled: true,
        hotSetEnabled: true,
        includeHotMemories: true,
      })
    ).toBe(false);

    // This build reads its own file back without the retired fields.
    const loaded = await store.load();
    expect(loaded?.windowKey).toBe("window-1");
    expect(loaded?.contexts.get("with-memory")).toStrictEqual({
      context: { indexEntries },
      memoryEnabled: true,
    });
  });
});
