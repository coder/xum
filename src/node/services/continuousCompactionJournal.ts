import { applyCacheControl } from "@/common/utils/ai/cacheStrategy";
import { promises as fs } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { modelMessageSchema, type ModelMessage } from "ai";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import assert from "@/common/utils/assert";
import {
  ContinuousCompactionJournalSchema,
  type ContinuousCompactionJournal,
} from "@/common/orpc/schemas/continuousCompaction";
import { prepareMessagesForProvider } from "./messagePipeline";
import { log } from "./log";

// JSON.stringify otherwise silently drops functions/symbols and coerces binary/URL options.
// Undefined object properties are absent SDK options; undefined array entries are not.
export function exactJson(value: unknown): z.infer<ReturnType<typeof z.json>> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(exactJson);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, exactJson(v)])
    );
  }
  throw new Error("Continuous prefix contains a non-JSON value");
}

export function stripMessageCacheControl(messages: ModelMessage[]): ModelMessage[] {
  const stripOptions = (options: ModelMessage["providerOptions"]) =>
    options &&
    Object.fromEntries(
      Object.entries(options).map(([provider, values]) => {
        const { cacheControl: _cache, ...rest } = values;
        return [provider, rest];
      })
    );
  return messages.map((message) => ({
    ...message,
    providerOptions: stripOptions(message.providerOptions),
    ...(Array.isArray(message.content)
      ? {
          content: message.content.map((part) => ({
            ...part,
            providerOptions: stripOptions(
              "providerOptions" in part ? part.providerOptions : undefined
            ),
          })),
        }
      : {}),
  })) as ModelMessage[];
}

export async function rebuildContinuousPrefix(
  journal: ContinuousCompactionJournal,
  workspaceId: string
): Promise<ModelMessage[]> {
  const messages = await prepareMessagesForProvider({
    ...journal.preparation,
    workspaceId,
    messagesWithSentinel: journal.prefixSourceRows,
    postCompactionAttachments: journal.postCompactionAttachments,
  });
  const prefix = stripMessageCacheControl(messages);
  return [
    ...journal.systemPrefix.map((message) => modelMessageSchema.parse(message)),
    ...(journal.cacheEnabled
      ? applyCacheControl(prefix, "anthropic:prefix", journal.preparation.anthropicCacheTtl)
      : prefix),
  ];
}

/** Serialized journal I/O plus a synchronous invalidation fence shared by reset and prepareStep. */
export class ContinuousCompactionJournalStore {
  private generation = 0;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    private readonly workspaceId: string
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  clear(): Promise<void> {
    this.generation++;
    return this.enqueue(() => fs.rm(this.path, { force: true }));
  }

  exists(): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        await fs.access(this.path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn("[continuous-compaction] journal unavailable", error);
        return false;
      }
    });
  }

  read(): Promise<ContinuousCompactionJournal | null> {
    return this.enqueue(async () => {
      try {
        return ContinuousCompactionJournalSchema.parse(
          JSON.parse(await fs.readFile(this.path, "utf8"))
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn("[continuous-compaction] discarded invalid journal", error);
          await fs
            .rm(this.path, { force: true })
            .catch((cleanupError: unknown) =>
              log.warn("[continuous-compaction] invalid journal cleanup failed", cleanupError)
            );
        }
        return null;
      }
    });
  }

  write(
    journal: ContinuousCompactionJournal,
    prefix: ModelMessage[],
    isCurrent: () => boolean
  ): Promise<ContinuousCompactionJournal | null> {
    const generation = this.generation;
    return this.enqueue(async () => {
      try {
        let wire: ContinuousCompactionJournal["prefix"];
        try {
          wire = z.array(z.json()).parse(exactJson(prefix));
          const parsed = wire.map((message) => modelMessageSchema.parse(message));
          assert(
            isDeepStrictEqual(exactJson(parsed), wire),
            "Prefix schema dropped request fields"
          );
        } catch {
          wire = undefined;
          // The fallback is allowed only if the pinned source pipeline reproduces the actual wire.
          const rebuilt = await rebuildContinuousPrefix(journal, this.workspaceId);
          assert(
            isDeepStrictEqual(rebuilt, prefix),
            "Prefix cannot be reproduced from journal sources"
          );
        }
        const payload = exactJson({ ...journal, prefix: wire });
        const parsed = ContinuousCompactionJournalSchema.parse(payload);
        assert(
          isDeepStrictEqual(exactJson(parsed), payload),
          "Journal schema dropped request fields"
        );
        if (generation !== this.generation || !isCurrent()) return null;
        await writeFileAtomic(this.path, JSON.stringify(payload), { mode: 0o600 });
        const reread = ContinuousCompactionJournalSchema.parse(
          JSON.parse(await fs.readFile(this.path, "utf8"))
        );
        assert(isDeepStrictEqual(exactJson(reread), payload), "Journal round-trip mismatch");
        if (generation !== this.generation || !isCurrent()) {
          await fs.rm(this.path, { force: true });
          return null;
        }
        return reread;
      } catch (error) {
        log.warn("[continuous-compaction] prefix not swapped: journal failed", error);
        await fs.rm(this.path, { force: true }).catch(() => undefined);
        return null;
      }
    });
  }
}

export interface ContinuousPrefixSwap {
  prefix: ModelMessage[];
  firstTailToolCallId: string;
  journal: ContinuousCompactionJournal;
}
