import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createRowTreeClient,
  defaultRowTreeWorkerPath,
  type RowTreeClient,
  type RowTreeRow,
} from "./rowTreeClient";

let dir: string;
const clients: RowTreeClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.dispose()));
beforeAll(async () => (dir = await mkdtemp(path.join(tmpdir(), "row-tree-"))));
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A fake worker script: it counts its starts, then runs `body` with `port` and `reply`. */
async function fakeWorker(name: string, body: string): Promise<string> {
  const file = path.join(dir, `${name}.cjs`);
  await writeFile(
    file,
    `const port = require("node:worker_threads").parentPort;
require("node:fs").appendFileSync(${JSON.stringify(path.join(dir, `${name}.starts`))}, "x");
const reply = (m, trees) => port.postMessage({ id: m.id, trees: trees ?? m.rows.map((r) => ["p", {}, r.text]) });
${body}`
  );
  return file;
}
const starts = async (name: string) =>
  (await readFile(path.join(dir, `${name}.starts`), "utf8").catch(() => "")).length;
/** A worker records its start asynchronously, after the client created it. */
async function untilStarts(name: string, count: number) {
  for (let i = 0; i < 200 && (await starts(name)) < count; i++) await Bun.sleep(10);
  expect(await starts(name)).toBe(count);
}
const client = (workerPath: string, limits = {}) => {
  const created = createRowTreeClient({ workerPath, limits });
  clients.push(created);
  return created;
};
const rows: RowTreeRow[] = [{ text: "hi", isUser: true }];
/** Polls until the worker answers: its start is asynchronous by design (the first read gets null). */
async function untilTrees(c: RowTreeClient, key = "k", input = rows) {
  for (let i = 0; i < 200; i++) {
    const trees = await c.render("ws", key, input);
    if (trees[0] !== null) return trees;
    await Bun.sleep(10);
  }
  throw new Error("the worker never answered");
}

describe("createRowTreeClient", () => {
  test("the first read gets null, later reads get trees, and a tail key hit is memoized", async () => {
    const c = client(
      await fakeWorker("ok", `port.on("message", (m) => reply(m)); port.postMessage("ready");`)
    );
    expect(await c.render("ws", "k", rows)).toEqual([null]);
    const trees = await untilTrees(c);
    expect(trees).toEqual([["p", {}, "hi"]]);
    expect(await c.render("ws", "k", rows)).toBe(trees);
    // An edit of the last row changes the tail key, so the memo misses.
    expect(await c.render("ws", "k2", [{ text: "edited", isUser: true }])).toEqual([
      ["p", {}, "edited"],
    ]);
  });

  test("trees outside the allow-list or over the byte cap give null", async () => {
    const trees = `m.rows.map((r) => r.text === "link" ? ["a", { href: "https://x.test" }] : r.text === "huge" ? ["p", {}, "x".repeat(70000)] : ["p", {}])`;
    const c = client(
      await fakeWorker(
        "bad",
        `port.on("message", (m) => reply(m, ${trees})); port.postMessage("ready");`
      )
    );
    await untilTrees(c);
    const input = ["link", "huge", "ok"].map((text) => ({ text, isUser: false }));
    expect(await c.render("ws", "k3", input)).toEqual([null, null, ["p", {}]]);
  });

  test("a batch timeout and a crash give null and start a new worker", async () => {
    const hang = await fakeWorker(
      "hang",
      `port.on("message", () => {}); port.postMessage("ready");`
    );
    const c = client(hang, { batchTimeoutMs: 30 });
    await c.render("ws", "k", rows);
    await Bun.sleep(200); // ready: a worker that never replies gives no other signal
    expect(await c.render("ws", "k", rows)).toEqual([null]); // timed out
    await c.render("ws", "k", rows);
    await untilStarts("hang", 2);

    const crash = await fakeWorker(
      "crash",
      `port.on("message", () => process.exit(1)); port.postMessage("ready");`
    );
    const d = client(crash);
    await d.render("ws", "k", rows);
    await Bun.sleep(200);
    expect(await d.render("ws", "k", rows)).toEqual([null]);
  });

  test("a load that never finishes backs off after 3 failures", async () => {
    const c = client(await fakeWorker("stuck", `setInterval(() => {}, 1000);`), {
      loadTimeoutMs: 20,
      backoffMs: 60_000,
    });
    for (let i = 0; i < 6; i++) {
      expect(await c.render("ws", "k", rows)).toEqual([null]);
      await Bun.sleep(60);
    }
    expect(await starts("stuck")).toBe(3);
  });

  test("a reply resets the failure count, so separate crashes never back off", async () => {
    const body = `port.on("message", (m) => (m.rows[0].text === "boom" ? process.exit(1) : reply(m))); port.postMessage("ready");`;
    const c = client(await fakeWorker("flaky", body), { backoffMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      await untilTrees(c, `ok${i}`); // a reply after each restart
      expect(await c.render("ws", `boom${i}`, [{ text: "boom", isUser: true }])).toEqual([null]);
    }
    await untilTrees(c, "after"); // 4 crashes, never 3 in a row: no backoff
  });

  test("a newer request for a busy workspace replaces the waiting one", async () => {
    const slow = await fakeWorker(
      "slow",
      `port.on("message", (m) => setTimeout(() => reply(m), 50)); port.postMessage("ready");`
    );
    const c = client(slow);
    await untilTrees(c, "warm");
    const [a, b, n] = await Promise.all(
      ["a", "b", "c"].map((key) => c.render("ws", key, [{ text: key, isUser: true }]))
    );
    expect([a, b, n]).toEqual([[["p", {}, "a"]], [null], [["p", {}, "c"]]]);
  });

  test("the idle stop ends the worker, and the next read starts a new one", async () => {
    const c = client(
      await fakeWorker("idle", `port.on("message", (m) => reply(m)); port.postMessage("ready");`),
      { idleMs: 30 }
    );
    await untilTrees(c);
    await Bun.sleep(80);
    expect(await c.render("ws", "other", rows)).toEqual([null]);
    await untilStarts("idle", 2);
  });

  test("the real worker renders a row with the live components", async () => {
    const c = client(defaultRowTreeWorkerPath());
    const [tree] = await untilTrees(c, "k", [{ text: "a `b`", isUser: false }]);
    expect(JSON.stringify(tree)).toContain('["code",{},"b"]');
  }, 15_000);
});
