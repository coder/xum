import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { z } from "zod";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import type { MemorySessionContext } from "@/node/services/memoryService";
import { isErrnoWithCode } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";

/**
 * Session file that holds the memory context of the current context window.
 *
 * Why it exists: AgentSession freezes the memory context (memory index in the memory tool
 * description, hot-memories block in the system prompt) per context window. The cache lived
 * only in RAM, so a server restart rebuilt it from memory files that other agents had changed
 * meanwhile. The next request then had a different system prompt or tool list. Anthropic
 * rejected every replayed thinking block with a 400 ("The `system` prompt differs from the one
 * this block was created with"), the repair dropped all earlier thinking, and the prompt cache
 * missed. Seen live after each server upgrade: 20 to 30 workspaces per restart.
 */
export const MEMORY_CONTEXT_FILE_NAME = "memory-context.json";

/** One model's cached memory context and the gates it was built under. */
export interface CachedMemoryContext {
  context: MemorySessionContext | null;
  includesHotMemories: boolean;
  memoryEnabled: boolean;
  hotSetEnabled: boolean;
}

const CachedMemoryContextSchema = z.object({
  context: z
    .object({
      indexEntries: z.array(z.object({ path: z.string(), description: z.string() })),
      hotMemoriesBlock: z.string().nullable(),
    })
    .nullable(),
  includesHotMemories: z.boolean(),
  memoryEnabled: z.boolean(),
  hotSetEnabled: z.boolean(),
});

const MemoryContextFileSchema = z.object({
  version: z.literal(1),
  /** Id of the first history row of the window the contexts belong to. */
  windowKey: z.string().min(1),
  contexts: z.record(z.string(), CachedMemoryContextSchema),
});

type MemoryContextFile = z.infer<typeof MemoryContextFileSchema>;

/** The file form: only the fields the prompt uses (runtime entries also carry scope and relPath). */
function toFile(
  windowKey: string,
  entries: Array<[string, CachedMemoryContext]>
): MemoryContextFile {
  const data: MemoryContextFile = { version: 1, windowKey, contexts: {} };
  for (const [modelString, cached] of entries) {
    data.contexts[modelString] = {
      includesHotMemories: cached.includesHotMemories,
      memoryEnabled: cached.memoryEnabled,
      hotSetEnabled: cached.hotSetEnabled,
      context:
        cached.context == null
          ? null
          : {
              indexEntries: cached.context.indexEntries.map((entry) => ({
                path: entry.path,
                description: entry.description,
              })),
              hotMemoriesBlock: cached.context.hotMemoriesBlock,
            },
    };
  }
  return data;
}

/**
 * Loads, saves and discards the memory-context file of one workspace. Saving is an
 * optimization: a failed read or write logs and falls back to a rebuilt context, never fails
 * the turn.
 *
 * File operations run one at a time on a private chain, not under the shared
 * workspaceFileLocks: window boundaries call discard() from paths that can already hold that
 * lock. One AgentSession owns a workspace per process, so the private chain is enough.
 */
export class MemoryContextStore {
  private readonly filePath: string;
  /** Bumped by discard(); loads and saves that started before it are dropped. */
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    config: Config,
    private readonly workspaceId: string
  ) {
    assert(workspaceId.length > 0, "MemoryContextStore requires a workspace id");
    this.filePath = path.join(config.sessionsDir, workspaceId, MEMORY_CONTEXT_FILE_NAME);
  }

  /**
   * The saved window key and contexts by model, or null when none is saved, the file is
   * malformed, or discard() ran during the read.
   */
  async load(): Promise<{
    windowKey: string;
    contexts: Map<string, CachedMemoryContext>;
  } | null> {
    const generation = this.generation;
    const raw = await this.enqueue("read", async () => {
      try {
        return await fs.readFile(this.filePath, "utf-8");
      } catch (error) {
        if (isErrnoWithCode(error, "ENOENT")) return null;
        throw error;
      }
    });
    if (raw == null || generation !== this.generation) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.warn("Ignoring unparseable", error);
      return null;
    }
    const parsed = MemoryContextFileSchema.safeParse(json);
    if (!parsed.success) {
      this.warn("Ignoring malformed", parsed.error);
      return null;
    }
    return {
      windowKey: parsed.data.windowKey,
      contexts: new Map(Object.entries(parsed.data.contexts)),
    };
  }

  async save(windowKey: string, contexts: ReadonlyMap<string, CachedMemoryContext>): Promise<void> {
    assert(windowKey.length > 0, "MemoryContextStore.save requires a window key");
    const generation = this.generation;
    // Copy now: the caller keeps mutating the map after this returns.
    const entries = [...contexts];
    await this.enqueue("write", async () => {
      // A window boundary that ran while this write waited owns the file now.
      if (generation !== this.generation) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFileAtomic(this.filePath, JSON.stringify(toFile(windowKey, entries)));
    });
  }

  /** A window boundary: the saved context must not reach the next window. */
  async discard(): Promise<void> {
    this.generation++;
    await this.enqueue("delete", () => fs.rm(this.filePath, { force: true }));
  }

  /** Run one file operation after the earlier ones; a failure logs and resolves undefined. */
  private enqueue<T>(action: string, operation: () => Promise<T>): Promise<T | undefined> {
    const result = this.queue.then(operation).catch((error: unknown) => {
      this.warn(`Failed to ${action}`, error);
      return undefined;
    });
    this.queue = result.then(() => undefined);
    return result;
  }

  private warn(prefix: string, error: unknown): void {
    log.warn(`${prefix} ${MEMORY_CONTEXT_FILE_NAME}`, {
      workspaceId: this.workspaceId,
      error: getErrorMessage(error),
    });
  }
}
