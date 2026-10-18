import * as path from "path";
import * as fs from "fs/promises";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionUsageService, type SessionUsageFile } from "./sessionUsageService";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import { createMuxMessage } from "@/common/types/message";
import { SessionUsageFileSchema } from "@/common/orpc/schemas/chatStats";
import { sumUsageHistory, type ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";

const MODEL = "anthropic:claude-sonnet-4-5";

function usage(input: number, output: number, flags: Partial<ChatUsageDisplay> = {}) {
  const result: ChatUsageDisplay = {
    input: { tokens: input, cost_usd: input / 1_000 },
    output: { tokens: output, cost_usd: output / 100 },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    reasoning: { tokens: 0 },
    ...flags,
  };
  return result;
}

function tokens(file: SessionUsageFile | undefined, model = MODEL): number {
  const bucket = file?.byModel[model];
  return bucket ? bucket.input.tokens + bucket.output.tokens : 0;
}

/** Tokens over every model bucket (history rebuilds pick their own bucket keys). */
function allTokens(file: SessionUsageFile | undefined): number {
  return Object.values(file?.byModel ?? {}).reduce(
    (sum, bucket) => sum + bucket.input.tokens + bucket.output.tokens,
    0
  );
}

describe("SessionUsageService in-flight usage", () => {
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let service: SessionUsageService;
  const workspaceId = "in-flight-workspace";

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    service = new SessionUsageService(config, historyService);
  });

  afterEach(async () => {
    await cleanup();
  });

  const sessionDir = () => path.join(config.sessionsDir, workspaceId);
  const ledgerPath = () => path.join(sessionDir(), "session-usage.json");
  const inFlightDir = () => path.join(sessionDir(), "session-usage.in-flight");

  async function readLedgerOnDisk(): Promise<SessionUsageFile | undefined> {
    try {
      return JSON.parse(await fs.readFile(ledgerPath(), "utf-8")) as SessionUsageFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function inFlightFiles(): Promise<string[]> {
    try {
      return await fs.readdir(inFlightDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** A new SessionUsageService on the same disk: what Xum has after a restart. */
  const restartedService = () => new SessionUsageService(config, historyService);

  it("a restart folds a killed stream's finished steps into the ledger once", async () => {
    await service.recordUsage(workspaceId, MODEL, usage(10, 1));
    // Two finished steps: each write holds the stream's cumulative usage.
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(200, 20));
    // The running stream's steps are on disk, outside the settled ledger.
    expect(tokens(await readLedgerOnDisk())).toBe(11);
    expect(await inFlightFiles()).toEqual(["key-a.json"]);

    const restarted = restartedService();
    expect(tokens(await restarted.getSessionUsage(workspaceId))).toBe(231);
    expect(tokens(await readLedgerOnDisk())).toBe(231);
    expect(await inFlightFiles()).toEqual([]);

    // Later reads (and another restart) do not count it again.
    expect(tokens(await restarted.getSessionUsage(workspaceId))).toBe(231);
    expect(tokens(await restartedService().getSessionUsage(workspaceId))).toBe(231);
  });

  it("a crash between the settle's ledger write and its file delete counts the turn once", async () => {
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
    const leftover = await fs.readFile(path.join(inFlightDir(), "key-a.json"), "utf-8");
    // The final usage (one more step than the last in-flight write) settles the stream.
    await service.recordUsage(workspaceId, MODEL, usage(150, 15), {
      settlesInFlightKey: "key-a",
    });
    expect(await inFlightFiles()).toEqual([]);
    expect(tokens(await readLedgerOnDisk())).toBe(165);

    // Recreate the state a crash right after the ledger write leaves: file still present.
    await fs.mkdir(inFlightDir(), { recursive: true });
    await fs.writeFile(path.join(inFlightDir(), "key-a.json"), leftover);

    const restarted = restartedService();
    expect(tokens(await restarted.getSessionUsage(workspaceId))).toBe(165);
    expect(await inFlightFiles()).toEqual([]);
    expect(tokens(await readLedgerOnDisk())).toBe(165);
  });

  it("a settle folds older leftovers in the same ledger write", async () => {
    await service.recordInFlightUsage(workspaceId, "key-dead", "msg-a", MODEL, usage(100, 10));
    const restarted = restartedService();
    await restarted.recordInFlightUsage(workspaceId, "key-b", "msg-b", MODEL, usage(5, 1));
    await restarted.recordUsage(workspaceId, MODEL, usage(5, 1), { settlesInFlightKey: "key-b" });
    expect(tokens(await readLedgerOnDisk())).toBe(116);
    expect(await inFlightFiles()).toEqual([]);
  });

  it("the default view leaves out this process's running streams; includeLiveStreams adds them", async () => {
    // The Costs tab adds the running stream from memory, so the default view must not.
    await service.recordUsage(workspaceId, MODEL, usage(10, 1));
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));

    expect(tokens(await service.getSessionUsage(workspaceId))).toBe(11);
    expect(tokens(await service.getSessionUsage(workspaceId, { includeLiveStreams: true }))).toBe(
      121
    );
    // Reading never moves the running stream into the ledger.
    expect(tokens(await readLedgerOnDisk())).toBe(11);
    expect(await inFlightFiles()).toEqual(["key-a.json"]);
  });

  it("a workspace with only a running stream still reads as empty in the default view", async () => {
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
    expect(await service.getSessionUsage(workspaceId)).toBeUndefined();
    expect(tokens(await service.getSessionUsage(workspaceId, { includeLiveStreams: true }))).toBe(
      110
    );
  });

  it("a discarded stream leaves the ledger and its pricing flags as they were", async () => {
    // Gateway-covered settled usage, then a direct-API stream on the same model.
    const settled = usage(10, 1, { costsIncluded: true });
    await service.recordUsage(workspaceId, MODEL, settled);
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
    // A different-flag writer lands while the stream runs.
    const headless = usage(3, 0, { serviceTier: "flex" });
    await service.recordUsage(workspaceId, MODEL, headless, { skipLastRequestUpdate: true });
    await service.discardInFlightUsage(workspaceId, "key-a");

    expect(await inFlightFiles()).toEqual([]);
    expect((await service.getSessionUsage(workspaceId))?.byModel[MODEL]).toEqual(
      sumUsageHistory([settled, headless])!
    );
  });

  it("mixed pricing flags in one model: steps are kept and fold like a settled write", async () => {
    const settled = usage(10, 1, { costsIncluded: true });
    const running = usage(100, 10);
    await service.recordUsage(workspaceId, MODEL, settled);
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, running);
    // The step is on disk although the bucket's flags differ.
    expect(await inFlightFiles()).toEqual(["key-a.json"]);
    // The settled bucket keeps its own flags while the stream runs.
    expect((await readLedgerOnDisk())?.byModel[MODEL]).toEqual(settled);

    const folded = await restartedService().getSessionUsage(workspaceId);
    expect(folded?.byModel[MODEL]).toEqual(sumUsageHistory([settled, running])!);
  });

  it("another live Xum's stream is added to reads but not folded", async () => {
    await service.recordUsage(workspaceId, MODEL, usage(10, 1));
    await fs.mkdir(inFlightDir(), { recursive: true });
    // process.ppid is alive (it started this test run) and is not this process.
    const foreign = {
      version: 1,
      owner: { pid: process.ppid, id: "other-xum" },
      messageId: "msg-other",
      model: MODEL,
      usage: usage(100, 10),
      updatedAt: Date.now(),
    };
    await fs.writeFile(path.join(inFlightDir(), "key-other.json"), JSON.stringify(foreign));

    expect(tokens(await service.getSessionUsage(workspaceId))).toBe(121);
    expect(tokens(await readLedgerOnDisk())).toBe(11);
    expect(await inFlightFiles()).toEqual(["key-other.json"]);
  });

  it("a failed settle's steps fold on the next read after the stream is released", async () => {
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
    // StreamManager releases the key when the final ledger write fails.
    service.releaseInFlightUsage(workspaceId, "key-a");
    expect(tokens(await service.getSessionUsage(workspaceId))).toBe(110);
    expect(await inFlightFiles()).toEqual([]);
  });

  it("a corrupt in-flight file is removed without breaking reads", async () => {
    await service.recordUsage(workspaceId, MODEL, usage(10, 1));
    await fs.mkdir(inFlightDir(), { recursive: true });
    await fs.writeFile(path.join(inFlightDir(), "key-bad.json"), "{not json");
    expect(tokens(await service.getSessionUsage(workspaceId))).toBe(11);
    expect(await inFlightFiles()).toEqual([]);
  });

  it("a ledger rebuilt from history keeps a running stream separate and counts it once", async () => {
    const message = createMuxMessage("history-msg", "assistant", "done", {
      model: MODEL,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    const appendResult = await historyService.appendToHistory(workspaceId, message);
    if (!appendResult.success) throw new Error(appendResult.error);
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
    await fs.writeFile(ledgerPath(), "{corrupt");

    expect(allTokens(await service.getSessionUsage(workspaceId))).toBe(10);
    await service.recordUsage(workspaceId, MODEL, usage(150, 15), {
      settlesInFlightKey: "key-a",
    });
    expect(allTokens(await restartedService().getSessionUsage(workspaceId))).toBe(175);
  });

  it("the archived-list batch read adds a killed stream without writing", async () => {
    await service.recordUsage(workspaceId, MODEL, usage(10, 1));
    await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
    const restarted = restartedService();
    const batch = await restarted.getSessionUsageBatch([workspaceId]);
    expect(tokens(batch[workspaceId])).toBe(121);
    expect(tokens(await readLedgerOnDisk())).toBe(11);
    // This process's own running stream stays out of the batch view.
    expect(tokens((await service.getSessionUsageBatch([workspaceId]))[workspaceId])).toBe(11);
  });

  describe("file compatibility", () => {
    it("an older Xum's ledger reader accepts a ledger with settled in-flight keys", async () => {
      await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));
      await service.recordUsage(workspaceId, MODEL, usage(100, 10), {
        settlesInFlightKey: "key-a",
      });
      const onDisk = await readLedgerOnDisk();
      expect(onDisk?.settledInFlightKeys).toEqual(["key-a"]);
      // The ORPC schema (the Costs tab's reader in every version) strips the extra field.
      expect(tokens(SessionUsageFileSchema.parse(onDisk))).toBe(110);
    });

    it("a downgrade and upgrade count a killed stream once", async () => {
      // A new Xum is killed mid-turn: its finished steps sit in an in-flight file.
      await service.recordUsage(workspaceId, MODEL, usage(10, 1));
      await service.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage(100, 10));

      // An older Xum ignores the directory: it reads and appends the ledger as JSON.
      const old = JSON.parse(await fs.readFile(ledgerPath(), "utf-8")) as SessionUsageFile;
      old.byModel[MODEL] = sumUsageHistory([old.byModel[MODEL], usage(5, 0)])!;
      await fs.writeFile(ledgerPath(), JSON.stringify(old));

      // The upgraded Xum folds the leftover on its first read.
      expect(tokens(await restartedService().getSessionUsage(workspaceId))).toBe(126);
      expect(tokens(await restartedService().getSessionUsage(workspaceId))).toBe(126);
    });

    it("a new Xum reads an old ledger unchanged and creates no in-flight directory", async () => {
      await fs.mkdir(sessionDir(), { recursive: true });
      const legacy = { byModel: { [MODEL]: usage(10, 1) }, version: 1 };
      await fs.writeFile(ledgerPath(), JSON.stringify(legacy));
      expect(await service.getSessionUsage(workspaceId)).toEqual(legacy as SessionUsageFile);
      expect(await readLedgerOnDisk()).toEqual(legacy as SessionUsageFile);
      expect(await inFlightFiles()).toEqual([]);
    });
  });
});
