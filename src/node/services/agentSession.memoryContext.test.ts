import { describe, expect, test, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import type { MemorySessionContext } from "./memoryService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { MEMORY_CONTEXT_FILE_NAME } from "./memoryContextPersistence";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Err } from "@/common/types/result";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Behavior under test: the memory session context (index snapshot +
 * hot-memories block) is computed once per model in a context window and
 * recomputed only at window boundaries (compaction, rollover, reset), never
 * after a memory write or a server restart, so the injected bytes stay
 * prompt-cache-stable (#5248) and replayed Anthropic thinking stays valid.
 */

const WORKSPACE_ID = "workspace-hot-memories-test";

async function createSession(args: {
  historyService: HistoryService;
  config: Config;
  buildMemorySessionContext: AIService["buildMemorySessionContext"];
  isExperimentEnabled?: AIService["isExperimentEnabled"];
  aiEmitter?: EventEmitter;
}): Promise<AgentSession> {
  const { session } = await createAgentSessionHarness({
    workspaceId: WORKSPACE_ID,
    config: args.config,
    historyService: args.historyService,
    aiEmitter: args.aiEmitter,
    aiServiceOverrides: {
      getWorkspaceMetadata: mock(() => Promise.resolve(Err("metadata unavailable"))),
      buildMemorySessionContext: args.buildMemorySessionContext,
      isExperimentEnabled: args.isExperimentEnabled ?? (() => false),
    },
  });
  return session;
}

interface PrivateSessionAccess {
  resolveMemoryContext: (
    modelString: string,
    options?: Parameters<AIService["buildMemorySessionContext"]>[2],
    cache?: Map<string, unknown>,
    persistence?: { windowKey: string | undefined }
  ) => Promise<MemorySessionContext | undefined>;
  getPostCompactionAttachmentsIfNeeded: () => Promise<unknown>;
  clearPostCompactionState: () => Promise<void>;
  applyContextResetSideEffects: () => Promise<void>;
}

/** Resolve as a stream of the context window whose first history row is `windowKey`. */
function resolveInWindow(
  session: AgentSession,
  modelString: string,
  windowKey = "window-1"
): Promise<MemorySessionContext | undefined> {
  return (session as unknown as PrivateSessionAccess).resolveMemoryContext(
    modelString,
    undefined,
    undefined,
    { windowKey }
  );
}

async function writePendingPostCompactionState(sessionDir: string): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "post-compaction.json"),
    JSON.stringify({ version: 1, createdAt: Date.now(), diffs: [], loadedSkills: [] })
  );
}

describe("AgentSession memory context", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  test("keeps the window's context after a memory write", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve<MemorySessionContext>({
        indexEntries: [{ path: `/memories/global/v${version}.md`, description: "note" }],
        hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
      });
    });
    const aiEmitter = new EventEmitter();
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
      aiEmitter,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      const first = await priv.resolveMemoryContext("test-model");
      // The agent's own successful write: before #5248 this rebuilt the index and
      // hot set, rewriting the memory tool description and the system prompt.
      aiEmitter.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId: WORKSPACE_ID,
        messageId: "assistant-1",
        toolCallId: "call-1",
        toolName: "memory",
        result: { success: true },
        timestamp: Date.now(),
      });
      await Promise.resolve();
      expect(await priv.resolveMemoryContext("test-model")).toEqual(first);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  test.each(["reset", "new segment"] as const)(
    "rebuilds the context at a %s window boundary",
    async (boundary) => {
      const { historyService, config, cleanup } = await createTestHistoryService();
      historyCleanup = cleanup;

      let version = 0;
      const buildMemorySessionContext = mock(() => {
        version++;
        return Promise.resolve<MemorySessionContext>({
          indexEntries: [],
          hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
        });
      });
      const session = await createSession({ historyService, config, buildMemorySessionContext });
      const priv = session as unknown as PrivateSessionAccess;

      try {
        const first = await priv.resolveMemoryContext("test-model");
        // Rollover and manual reset share applyContextResetSideEffects; a full
        // history clear or destructive replace starts a new segment.
        if (boundary === "reset") await priv.applyContextResetSideEffects();
        else await priv.clearPostCompactionState();
        const next = await priv.resolveMemoryContext("test-model");
        expect(next).not.toEqual(first);
        expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
      } finally {
        await session.dispose();
      }
    }
  );

  test("upgrades an index-only memory context when hot memories are requested", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(
      (_workspaceId: string, modelString: string, options?: { includeHotMemories?: boolean }) =>
        Promise.resolve({
          indexEntries: [],
          hotMemoriesBlock:
            options?.includeHotMemories === false
              ? null
              : `<hot_memories>${modelString}</hot_memories>`,
        })
    );
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(
        (await priv.resolveMemoryContext("model-a", { includeHotMemories: false }))
          ?.hotMemoriesBlock
      ).toBeNull();
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("caches memory context separately per model", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock((_workspaceId: string, modelString: string) =>
      Promise.resolve({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>${modelString}</hot_memories>`,
      })
    );
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-b"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-b</hot_memories>"
      );
      expect((await priv.resolveMemoryContext("model-a"))?.hotMemoriesBlock).toBe(
        "<hot_memories>model-a</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("caches the absence of memory context without re-querying per turn", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const buildMemorySessionContext = mock(() => Promise.resolve(null));
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(await priv.resolveMemoryContext("test-model")).toBeUndefined();
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  test("invalidates Memory/HotSet gate changes without losing model-specific caching", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    let memoryEnabled = true;
    let hotSetEnabled = true;
    const buildMemorySessionContext = mock<AIService["buildMemorySessionContext"]>(
      (_workspace, model, options) =>
        Promise.resolve(
          memoryEnabled
            ? {
                indexEntries: [],
                hotMemoriesBlock:
                  hotSetEnabled && options?.includeHotMemories !== false ? model : null,
              }
            : null
        )
    );
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
      isExperimentEnabled: (id) =>
        (id === EXPERIMENT_IDS.MEMORY && memoryEnabled) ||
        (id === EXPERIMENT_IDS.MEMORY_HOT_SET && hotSetEnabled),
    });
    const priv = session as unknown as PrivateSessionAccess;
    try {
      expect((await priv.resolveMemoryContext("primary"))?.hotMemoriesBlock).toBe("primary");
      await priv.resolveMemoryContext("primary");
      // An index-only lookup reuses the fuller cached context.
      await priv.resolveMemoryContext("primary", { includeHotMemories: false });
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
      expect((await priv.resolveMemoryContext("fallback"))?.hotMemoriesBlock).toBe("fallback");
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
      hotSetEnabled = false;
      expect((await priv.resolveMemoryContext("primary"))?.hotMemoriesBlock).toBeNull();
      memoryEnabled = false;
      expect(await priv.resolveMemoryContext("primary")).toBeUndefined();
      memoryEnabled = true;
      hotSetEnabled = true;
      expect((await priv.resolveMemoryContext("primary"))?.hotMemoriesBlock).toBe("primary");
    } finally {
      await session.dispose();
    }
  });

  // A server restart creates a new AgentSession for the same context window. Before the
  // context was saved in the session dir, the restart rebuilt it from memory files that
  // other agents had changed. Anthropic then rejected every replayed thinking block ("The
  // `system` prompt / `tools` list differs"), and the prompt cache missed.
  test("keeps the window's context across a server restart", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve<MemorySessionContext>({
        indexEntries: [{ path: `/memories/global/v${version}.md`, description: "note" }],
        hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
      });
    });

    const before = await createSession({ historyService, config, buildMemorySessionContext });
    let first: MemorySessionContext | undefined;
    try {
      first = await resolveInWindow(before, "test-model");
    } finally {
      await before.dispose();
    }

    const after = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect(await resolveInWindow(after, "test-model")).toEqual(first);
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
      // A model the old process never resolved still gets its own fresh context.
      expect((await resolveInWindow(after, "other-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v2</hot_memories>"
      );
    } finally {
      await after.dispose();
    }
  });

  test.each(["reset", "new segment", "compaction"] as const)(
    "rebuilds after a restart when a %s boundary ended the saved window",
    async (boundary) => {
      const { historyService, config, cleanup } = await createTestHistoryService();
      historyCleanup = cleanup;

      let version = 0;
      const buildMemorySessionContext = mock(() => {
        version++;
        return Promise.resolve<MemorySessionContext>({
          indexEntries: [],
          hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
        });
      });

      const before = await createSession({ historyService, config, buildMemorySessionContext });
      try {
        const priv = before as unknown as PrivateSessionAccess;
        await resolveInWindow(before, "test-model");
        if (boundary === "reset") await priv.applyContextResetSideEffects();
        else if (boundary === "new segment") await priv.clearPostCompactionState();
        else {
          await writePendingPostCompactionState(path.join(config.sessionsDir, WORKSPACE_ID));
          await priv.getPostCompactionAttachmentsIfNeeded();
        }
      } finally {
        await before.dispose();
      }

      const after = await createSession({ historyService, config, buildMemorySessionContext });
      try {
        expect((await resolveInWindow(after, "test-model"))?.hotMemoriesBlock).toBe(
          "<hot_memories>v2</hot_memories>"
        );
      } finally {
        await after.dispose();
      }
    }
  );

  // A file can outlive its window: a failed delete, or an older build that crossed a
  // boundary without knowing the file. The next window's first row differs, so it is ignored.
  test("rebuilds after a restart when the saved file names another window", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve<MemorySessionContext>({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
      });
    });
    const before = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      await resolveInWindow(before, "test-model", "window-1");
    } finally {
      await before.dispose();
    }

    const after = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect((await resolveInWindow(after, "test-model", "window-2"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v2</hot_memories>"
      );
    } finally {
      await after.dispose();
    }
  });

  test("retries a failed save on the next cache hit", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 0;
    const buildMemorySessionContext = mock(() => {
      version++;
      return Promise.resolve<MemorySessionContext>({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
      });
    });
    // A directory at the file's path makes the first write fail.
    const filePath = path.join(config.sessionsDir, WORKSPACE_ID, MEMORY_CONTEXT_FILE_NAME);
    await fs.mkdir(filePath, { recursive: true });
    const before = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      await resolveInWindow(before, "test-model");
      await fs.rm(filePath, { recursive: true });
      await resolveInWindow(before, "test-model");
    } finally {
      await before.dispose();
    }

    const after = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect((await resolveInWindow(after, "test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v1</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await after.dispose();
    }
  });

  test("rebuilds the context when the saved file is malformed", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const sessionDir = path.join(config.sessionsDir, WORKSPACE_ID);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, MEMORY_CONTEXT_FILE_NAME), "{not json");
    const buildMemorySessionContext = mock(() =>
      Promise.resolve<MemorySessionContext>({
        indexEntries: [],
        hotMemoriesBlock: "<hot_memories>fresh</hot_memories>",
      })
    );
    const session = await createSession({ historyService, config, buildMemorySessionContext });
    try {
      expect((await resolveInWindow(session, "test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>fresh</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
  });

  test("recomputes the context after a compaction boundary is consumed", async () => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    let version = 1;
    const buildMemorySessionContext = mock(() =>
      Promise.resolve({
        indexEntries: [],
        hotMemoriesBlock: `<hot_memories>v${version}</hot_memories>`,
      })
    );
    const session = await createSession({
      historyService,
      config,
      buildMemorySessionContext,
    });
    const priv = session as unknown as PrivateSessionAccess;

    try {
      expect((await priv.resolveMemoryContext("test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v1</hot_memories>"
      );

      // Consume a pending compaction boundary (first stream after compaction).
      version = 2;
      await writePendingPostCompactionState(path.join(config.sessionsDir, WORKSPACE_ID));
      await priv.getPostCompactionAttachmentsIfNeeded();

      expect((await priv.resolveMemoryContext("test-model"))?.hotMemoriesBlock).toBe(
        "<hot_memories>v2</hot_memories>"
      );
      expect(buildMemorySessionContext).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });
});
