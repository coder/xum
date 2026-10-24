/**
 * The proof of phase 5 (5b PR 9): one agent turn with one tool call runs on test layers only.
 * The host trap records every host call while it is armed, and the test fails on any call that
 * the disk rule does not allow. Runs only in its own process: make test-host-proof.
 */
import { afterAll, expect, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IN_MEMORY_WORKSPACE_PATH, makeInMemoryLoop } from "./agentLoop.inMemory.testHarness";
import { createMemoryHost } from "./hostFiles/memoryHostFiles.testHarness";
import { hostTrapOrThrow, type HostTrapRow } from "./hostTrap/hostTrap.testHarness";
import { closeLogFile, getLogFilePath } from "./log";

// Throws at once with plain bun test: the trap loads only with tests/hostProof.bunfig.toml.
const trap = hostTrapOrThrow();

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that calls `toolName` once, then answers. */
function toolThenAnswer(toolName: string, input: unknown): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      call++;
      const chunks: LanguageModelV3StreamPart[] =
        call === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "a" },
              { type: "text-delta", id: "a", delta: "done" },
              { type: "text-end", id: "a" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ];
      return Promise.resolve({
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      });
    },
  });
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * The disk rule of claim 4.3: Config's calls under its root and the log file. Nothing else.
 * - Config and its stores (config.json, providers.jsonc, secrets.json, the plugin registry and
 *   journals of the managed container) stay on the disk until #7209. Config checks each
 *   ancestor of its root for links (lstat).
 * - The log sink writes XUM_ROOT/logs/mux.log (#7209), and its console sink writes stdout. The
 *   file stream writes by fd. Every other fd comes from an open row that this rule checks by
 *   its path, so an fd row needs no path.
 */
function allowedOnDisk(configRoot: string): (row: HostTrapRow) => boolean {
  const logsDir = path.dirname(getLogFilePath());
  return (row) =>
    isInside(configRoot, row.arg) ||
    (row.api === "fs.lstatSync" && isInside(row.arg, configRoot)) ||
    isInside(logsDir, row.arg) ||
    /^fd\/\d+$/.test(row.arg);
}

let disallowed: (row: HostTrapRow) => boolean = () => false;

test("one turn with one tool call runs on test layers only", async () => {
  const host = createMemoryHost();
  await host.files.promises.mkdir(IN_MEMORY_WORKSPACE_PATH, { recursive: true });
  await host.files.promises.writeFile(`${IN_MEMORY_WORKSPACE_PATH}/README.md`, "# hello\n");
  // The test's own setup, before the trap: the empty dir that Config uses as its root.
  const configRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "xum-host-proof-"));
  const allowed = allowedOnDisk(configRoot);
  disallowed = (row) => !allowed(row);
  try {
    trap.arm(); // before the loop is built: constructors count too
    const loop = await makeInMemoryLoop({
      host,
      configRoot,
      model: toolThenAnswer("file_read", { path: "README.md" }),
    });
    try {
      await loop.send("Read the README.");
      await loop.waitForStreamEnd();
    } finally {
      await loop.dispose();
    }
    await host.runtime.idle(); // the `void runtime.exec` of the stream's temp dir cleanup
    closeLogFile(); // else its WriteStream stays open
    await trap.drain(); // open host work of the turn: none, or it fails and names it
    trap.disarm();
    await loop.clock.dispose();

    expect(loop.toolResult("file_read")).toMatchObject({
      success: true,
      content: "1\t# hello\n2\t",
    });
    expect(await loop.chatRoles()).toEqual(["user", "assistant"]);
    // The one exec of the turn: the cleanup of the stream's temp dir.
    expect(host.runtime.execs.every((command) => command.startsWith("rm -rf '"))).toBe(true);
    expect(trap.rows().filter(disallowed)).toEqual([]);
  } finally {
    trap.disarm();
    await fsp.rm(configRoot, { recursive: true, force: true });
  }
}, 60_000);

// A host call after the test (a late callback) also fails the proof.
afterAll(() => expect(trap.rows().filter(disallowed)).toEqual([]));
