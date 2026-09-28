import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { installDom } from "./dom";

const RADIX_ORDER_FIXTURE = path.join(import.meta.dir, "domIsolation.radixOrder.child.test.tsx");
const RADIX_ORDER_CHILD_TIMEOUT_MS = 60_000;

// Pins the harness invariant that a poisoned teardown (a test setting
// globalThis.document = undefined) cannot propagate past a file boundary.
describe("dom harness file-boundary isolation", () => {
  test("uninstall never leaves document undefined once a baseline exists", () => {
    globalThis.document = undefined as unknown as Document;
    globalThis.window = undefined as unknown as Window & typeof globalThis;

    const uninstall = installDom();
    uninstall();

    expect(typeof globalThis.document).not.toBe("undefined");
    expect(typeof globalThis.window).not.toBe("undefined");
  });

  test("preloads react-dnd before a poisoned boundary", () => {
    const savedDocument = globalThis.document;
    globalThis.document = undefined as unknown as Document;
    try {
      // Guards the eager preload in dom.ts: without it, this require would be
      // @react-dnd/asap's first evaluation and would crash on document access.
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- must evaluate lazily, after document is removed
        require("react-dnd");
      }).not.toThrow();
    } finally {
      globalThis.document = savedDocument;
    }
  });

  test(
    "rebinds Radix's layout effect when the harness loads after a document-less Radix import",
    () => {
      // This process already has a document and Radix bound, so the scenario needs a fresh
      // `bun test` child. The fixture pins the order (Radix, then the harness) and opens a
      // real Popover; `mock.module` only works under the test runner, hence a child test.
      const child = Bun.spawnSync({
        cmd: [process.execPath, "test", RADIX_ORDER_FIXTURE],
        cwd: path.resolve(import.meta.dir, "../.."),
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: RADIX_ORDER_CHILD_TIMEOUT_MS,
      });
      const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
      // A timeout surfaces as a kill signal rather than an exit code.
      expect({ exitCode: child.exitCode, signal: child.signalCode ?? null, output }).toMatchObject({
        exitCode: 0,
        signal: null,
      });
      // A skipped or undiscovered fixture is not evidence that the scenario ran.
      expect(output).toMatch(/\b1 pass\b/);
      expect(output).not.toMatch(/\b1 skip\b/);
    },
    RADIX_ORDER_CHILD_TIMEOUT_MS + 10_000
  );
});
