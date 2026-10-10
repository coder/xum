// Spawned by tests/bunEachTableGc.test.ts in a fresh `bun test` process: on an unprotected
// Bun 1.3.12 this file fails or segfaults, which must never happen in a shared test process.
// Not named *.test.ts, so no test lane runs it directly.
import { describe, expect, test } from "bun:test";

/** Forces the GC window between `.each(table)` and the registration call. */
function collectGarbage(): void {
  Bun.gc(true);
  for (let index = 0; index < 200_000; index++) {
    void { index, list: [index] };
  }
  Bun.gc(true);
}

const testRows = test.each([
  ["ssh", { type: "ssh", host: "user@host", srcBaseDir: "~/mux" }],
  ["docker", { type: "docker", image: "ubuntu:22.04" }],
]);
collectGarbage();
testRows("test.each keeps the %s row", (label, row) => {
  expect(row).toEqual(
    label === "ssh"
      ? { type: "ssh", host: "user@host", srcBaseDir: "~/mux" }
      : { type: "docker", image: "ubuntu:22.04" }
  );
});

const describeRows = describe.each([
  ["retry snapshot", { retrySendOptions: "required_report" }],
  ["user row", { row: "recovery" }],
] as const);
collectGarbage();
describeRows("describe.each keeps the %s row", (label, persisted) => {
  test("row", () => {
    expect(Object.keys(persisted)).toEqual([label === "user row" ? "row" : "retrySendOptions"]);
  });
});
