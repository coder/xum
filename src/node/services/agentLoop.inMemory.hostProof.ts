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
import { allowedOnDisk } from "./agentLoop.inMemory.diskRule.testHarness";
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

let disallowed: (row: HostTrapRow) => boolean = () => false;
let configRoot: string | undefined;
let disposeClock: (() => Promise<void>) | undefined;

test("one turn with one tool call runs on test layers only", async () => {
  const host = createMemoryHost();
  await host.files.promises.mkdir(IN_MEMORY_WORKSPACE_PATH, { recursive: true });
  await host.files.promises.writeFile(`${IN_MEMORY_WORKSPACE_PATH}/README.md`, "# hello\n");
  // The test's own setup, before the trap: the empty dir that Config uses as its root.
  configRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "xum-host-proof-"));
  const allowed = allowedOnDisk(configRoot, path.dirname(getLogFilePath()));
  disallowed = (row) => !allowed(row);
  // The trap stays armed until afterAll, so a late callback after the test still adds a row.
  trap.arm(); // before the loop is built: constructors count too
  const model = toolThenAnswer("file_read", { path: "README.md" });
  const loop = await makeInMemoryLoop({ host, configRoot, model });
  disposeClock = () => loop.clock.dispose();
  try {
    await loop.send("Read the README.");
    await loop.waitForStreamEnd();
  } finally {
    await loop.dispose();
  }
  await host.runtime.idle(); // the `void runtime.exec` of the stream's temp dir cleanup
  closeLogFile(); // else its WriteStream stays open
  await trap.drain(); // open host work of the turn: none, or it fails and names it

  // One tool call: a second run of the same call fails here.
  const results = loop.toolResults("file_read");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ success: true, content: "1\t# hello\n2\t" });
  expect(await loop.chatRoles()).toEqual(["user", "assistant"]);
  // The turn goes on after the tool result: a second model call gives the answer.
  expect(model.doStreamCalls).toHaveLength(2);
  expect(await loop.lastAssistantText()).toBe("done");
  // The one exec of the turn: the cleanup of the stream's temp dir.
  expect(host.runtime.execs).toHaveLength(1);
  expect(host.runtime.execs[0]).toStartWith("rm -rf '");
  expect(trap.rows().filter(disallowed)).toEqual([]);
}, 60_000);

// A host call after the test (a late callback) also fails the proof. The rows are read after a
// second drain() and before disarm(). The test's own cleanup runs after it: the clock's runtime (its bounded teardown
// sets a real timer) and the config root.
afterAll(async () => {
  await trap.drain(); // host work that a late callback opened after the test's own drain()
  const late = trap.rows().filter(disallowed);
  trap.disarm();
  await disposeClock?.();
  if (configRoot !== undefined) await fsp.rm(configRoot, { recursive: true, force: true });
  expect(late).toEqual([]);
});
