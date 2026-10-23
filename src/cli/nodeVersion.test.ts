import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {
  BROTLI_FIXED_NODE_RELEASES,
  nodeVersionWarning,
  warnIfUnsupportedNode,
} from "./nodeVersion";

describe("nodeVersionWarning", () => {
  test("warns on a Node older than the minimum", () => {
    expect(nodeVersionWarning({ node: "20.19.0" })).toContain("Node 20.19.0 is not supported");
  });

  test.each(["22.23.3", "22.0.0", "23.0.0", "23.11.1", "24.22.0", "25.9.0", "26.12.0"])(
    "warns that Node %s is affected by CVE-2026-111497",
    (node) => {
      expect(nodeVersionWarning({ node })).toContain("CVE-2026-111497");
    }
  );

  test.each(["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "27.0.0"])(
    "stays quiet on Node %s, which has the Brotli fix",
    (node) => {
      expect(nodeVersionWarning({ node })).toBeUndefined();
    }
  );

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

test("package.json engines.node allows exactly the releases with the Brotli fix", async () => {
  const pkg = JSON.parse(
    await fs.readFile(path.join(import.meta.dir, "..", "..", "package.json"), "utf-8")
  ) as { engines?: { node?: string } };
  const releases = BROTLI_FIXED_NODE_RELEASES.map((release) => release.join("."));
  const expected = [
    ...releases.slice(0, -1).map((release) => `^${release}`),
    `>=${releases[releases.length - 1]}`,
  ].join(" || ");
  expect(pkg.engines?.node).toBe(expected);
});
