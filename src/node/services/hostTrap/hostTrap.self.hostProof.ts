// Self-tests of the host trap. They show that a host call inside the armed window is
// recorded across each async boundary that the in-memory proof can cross. The file ends in
// .hostProof.ts, so `bun test src`, scripts/test-unit-ci.sh and Jest never run it: only
// `make test-host-proof` does, with the trap preloaded before tests/setup.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import * as fsNs from "node:fs";
import fsDefault from "fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { Effect, Exit, Fiber, Scope } from "effect";
import { hostTrapOrThrow } from "./hostTrap.testHarness";

// Fails at once when the trap is absent (the file ran outside make test-host-proof).
const trap = hostTrapOrThrow();
const FILE = __filename;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
});
afterAll(async () => {
  await server.stop(true);
});

/** Arms the trap, runs `work`, drains, disarms, and returns the recorded api names. */
async function within(work: () => unknown): Promise<string[]> {
  trap.arm();
  try {
    await work();
    await trap.drain();
  } finally {
    trap.disarm();
  }
  return trap.rows().map((row) => row.api);
}

test("the trap is installed before tests/setup.ts", () => {
  expect(trap.installedBeforeSetup).toBe(true);
});

test("named, namespace, default, require and dynamic import forms", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CommonJS form is under test
  const required = require("fs") as typeof fsNs;
  // eslint-disable-next-line no-restricted-syntax -- the dynamic import form is under test
  const dynamic = await import("node:fs");
  const apis = await within(() => {
    readFileSync(FILE);
    fsNs.statSync(FILE);
    fsDefault.existsSync(FILE);
    required.lstatSync(FILE);
    dynamic.readdirSync(path.dirname(FILE));
  });
  expect(apis).toEqual([
    "fs.readFileSync",
    "fs.statSync",
    "fs.existsSync",
    "fs.lstatSync",
    "fs.readdirSync",
  ]);
});

test("fs/promises, fs.promises and require of fs/promises", async () => {
  const apis = await within(async () => {
    await fsp.readFile(FILE);
    await fsNs.promises.stat(FILE);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CommonJS form is under test
    await (require("fs/promises") as typeof fsp).lstat(FILE);
  });
  expect(apis).toEqual(["fsp.readFile", "fsp.stat", "fsp.lstat"]);
});

test("a MessageChannel message", async () => {
  const { port1, port2 } = new MessageChannel();
  const received = new Promise<void>((resolve) => {
    port1.onmessage = () => {
      statSync(FILE);
      resolve();
    };
  });
  const apis = await within(async () => {
    port2.postMessage(1);
    await received;
  });
  port1.close();
  expect(apis).toContain("fs.statSync");
});

test("a ReadableStream made before arm()", async () => {
  const stream = new ReadableStream<number>(
    {
      pull(controller) {
        controller.enqueue(readFileSync(FILE).length);
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const apis = await within(() => stream.getReader().read());
  expect(apis).toContain("fs.readFileSync");
});

test("an emitter that outside work emits", async () => {
  const emitter = new EventEmitter();
  const heard = new Promise<void>((resolve) =>
    emitter.on("x", () => {
      statSync(FILE);
      resolve();
    })
  );
  // A timer made before arm() emits inside the window.
  const timer = setTimeout(() => emitter.emit("x"), 5);
  const apis = await within(() => heard);
  clearTimeout(timer);
  expect(apis).toContain("fs.statSync");
});

test("Effect runFork and forkIn fibers", async () => {
  const scope = Effect.runSync(Scope.make());
  const apis = await within(async () => {
    const forked = Effect.runFork(Effect.sleep("1 millis").pipe(Effect.map(() => statSync(FILE))));
    const scoped = Effect.runSync(
      Effect.forkIn(
        Effect.sync(() => readFileSync(FILE)),
        scope,
        { startImmediately: true }
      )
    );
    await Effect.runPromise(Fiber.join(forked));
    await Effect.runPromise(Fiber.join(scoped));
  });
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(apis).toContain("fs.statSync");
  expect(apis).toContain("fs.readFileSync");
});

test("setTimeout, setInterval, setImmediate and nextTick", async () => {
  const apis = await within(async () => {
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        statSync(FILE);
        resolve();
      }, 2)
    );
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        clearInterval(interval);
        fsNs.lstatSync(FILE);
        resolve();
      }, 2);
    });
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        fsNs.existsSync(FILE);
        resolve();
      })
    );
    await new Promise<void>((resolve) =>
      process.nextTick(() => {
        fsNs.readdirSync(path.dirname(FILE));
        resolve();
      })
    );
  });
  expect(apis).toEqual([
    "setTimeout",
    "fs.statSync",
    "setInterval",
    "fs.lstatSync",
    "fs.existsSync",
    "fs.readdirSync",
  ]);
});

test("fs callbacks and fs streams", async () => {
  const apis = await within(async () => {
    await new Promise<void>((resolve) =>
      fsNs.readFile(FILE, () => {
        statSync(FILE);
        resolve();
      })
    );
    await new Promise<void>((resolve) =>
      fsNs
        .createReadStream(FILE)
        .on("data", () => undefined)
        .on("close", () => resolve())
    );
  });
  // The stream reads through fs.open and fs.read, which add rows too.
  for (const api of ["fs.readFile", "fs.statSync", "fs.createReadStream"])
    expect(apis).toContain(api);
});

test("child_process, Bun.spawn, Bun.spawnSync and fetch", async () => {
  const apis = await within(async () => {
    await new Promise<void>((resolve) => execFile("true", () => resolve()));
    await Bun.spawn(["true"]).exited;
    Bun.spawnSync(["true"]);
    await (await fetch(server.url)).text();
  });
  // execFile spawns through Bun.spawn, which adds a row too.
  for (const api of ["cp.execFile", "Bun.spawn", "Bun.spawnSync", "fetch"])
    expect(apis).toContain(api);
});

test("Bun.file reads", async () => {
  const apis = await within(async () => {
    await Bun.file(FILE).text();
    await Bun.file(FILE).exists();
  });
  for (const api of ["Bun.file", "Bun.file.text", "Bun.file.exists"]) expect(apis).toContain(api);
});

test("a WriteStream write, the shape of the log sink", async () => {
  const out = path.join(os.tmpdir(), `host-trap-${process.pid}.log`);
  const apis = await within(async () => {
    const stream = fsNs.createWriteStream(out, { flags: "a" });
    stream.write("line\n");
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  });
  fsNs.rmSync(out, { force: true });
  expect(apis).toContain("WriteStream.write");
});

test("drain() waits for the callback of a zero-delay timer or setImmediate", async () => {
  // Not awaited: drain() alone must keep the window open until both callbacks ran.
  const apis = await within(() => {
    setTimeout(() => Bun.spawnSync(["true"]), 0);
    setImmediate(() => fsNs.statSync(FILE));
  });
  // A zero delay is a yield, so the timer itself adds no row. The two callbacks run in either order.
  expect(apis.toSorted()).toEqual(["Bun.spawnSync", "fs.statSync"]);
});

test("a WriteStream opened before arm() still records its writes", async () => {
  const out = path.join(os.tmpdir(), `host-trap-early-${process.pid}.log`);
  // The log sink can open its stream before the proof arms the trap.
  const stream = fsNs.createWriteStream(out, { flags: "a" });
  await new Promise<void>((resolve) => stream.once("open", () => resolve()));
  const apis = await within(() => {
    stream.write("line\n");
  });
  await new Promise<void>((resolve) => stream.end(() => resolve()));
  fsNs.rmSync(out, { force: true });
  // The stream then writes through fs.write, which adds a row too.
  expect(apis).toContain("WriteStream.write");
});

test("drain() waits for a void promise and names open work", async () => {
  trap.arm();
  try {
    // The shape of the fire-and-forget `void runtime.exec(...)` of streamManager.ts.
    void fsp.readFile(FILE);
    await trap.drain();
    const interval = setInterval(() => undefined, 50);
    let failure = "";
    try {
      await trap.drain(200);
    } catch (error) {
      failure = String(error);
    }
    // Clean up the leak: drain() is empty again.
    clearInterval(interval);
    await trap.drain(200);
    expect(failure).toContain("setInterval 50");
  } finally {
    trap.disarm();
  }
});

test("an open FileHandle fails drain() until close()", async () => {
  trap.arm();
  try {
    const handle = await fsp.open(FILE, "r");
    let failure = "";
    try {
      await trap.drain(200);
    } catch (error) {
      failure = String(error);
    }
    await handle.close();
    await trap.drain(200);
    expect(failure).toContain("FileHandle");
  } finally {
    trap.disarm();
  }
});

test("arm() resets the open work", async () => {
  trap.arm();
  const interval = setInterval(() => undefined, 50);
  trap.arm();
  try {
    // The interval of the earlier window does not leak into this one.
    await trap.drain(200);
  } finally {
    clearInterval(interval);
    trap.disarm();
  }
});
