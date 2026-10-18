import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { MIN_NODE_MAJOR, nodeVersionWarning, warnIfUnsupportedNode } from "./nodeVersion";

describe("nodeVersionWarning", () => {
  test("warns on a Node older than the minimum", () => {
    expect(nodeVersionWarning({ node: "20.19.0" })).toContain("Node 20.19.0 is not supported");
  });

  test("stays quiet on the minimum and newer", () => {
    expect(nodeVersionWarning({ node: `${MIN_NODE_MAJOR}.0.0` })).toBeUndefined();
    expect(nodeVersionWarning({ node: "24.11.1" })).toBeUndefined();
  });

  test("never warns in Electron or Bun, whatever Node version they report", () => {
    expect(nodeVersionWarning({ node: "20.0.0", electron: "44.5.1" })).toBeUndefined();
    expect(nodeVersionWarning({ node: "20.0.0", bun: "1.4.3" })).toBeUndefined();
  });

  test("returns nothing for a version it cannot parse", () => {
    expect(nodeVersionWarning({ node: "garbage" })).toBeUndefined();
    expect(nodeVersionWarning({})).toBeUndefined();
  });
});

test("warnIfUnsupportedNode writes only to stderr, so stdout output such as xum api JSON stays clean", () => {
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = spyOn(console, "log");
  const stdoutSpy = spyOn(process.stdout, "write");
  try {
    warnIfUnsupportedNode({ node: "20.19.0" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
  }
});

test("package.json engines.node matches MIN_NODE_MAJOR", async () => {
  const pkg = JSON.parse(
    await fs.readFile(path.join(import.meta.dir, "..", "..", "package.json"), "utf-8")
  ) as { engines?: { node?: string } };
  expect(pkg.engines?.node).toBe(`>=${MIN_NODE_MAJOR}`);
});
