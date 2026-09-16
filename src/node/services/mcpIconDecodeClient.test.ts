import { describe, expect, test } from "bun:test";
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { decodeMcpIcon } from "./mcpIconDecodeClient";
import { isPngDataUrl } from "@/common/utils/mcp/pngDataUrl";

const deadline = () => AbortSignal.timeout(3_000);
const notion = readFileSync(path.resolve(__dirname, "../../../tests/fixtures/mcp/notion-icon.svg"));

describe("killable MCP icon decoder", () => {
  test("decodes supported raster types and the unchanged Notion SVG into bounded PNG", async () => {
    const source = sharp({ create: { width: 100, height: 80, channels: 4, background: "red" } });
    const inputs: Array<[Buffer, string]> = [
      [await source.clone().png().toBuffer(), "image/png"],
      [await source.clone().jpeg().toBuffer(), "image/jpeg"],
      [await source.clone().gif().toBuffer(), "image/gif"],
      [await source.clone().webp().toBuffer(), "image/webp"],
      [notion, "image/svg+xml"],
    ];
    for (const [input, mime] of inputs) {
      const result = await decodeMcpIcon(input, [mime], deadline());
      expect(isPngDataUrl(result)).toBe(true);
      const data = Buffer.from(result!.split(",")[1], "base64");
      expect(data.length).toBeLessThanOrEqual(32 * 1024);
      const metadata = await sharp(data).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.width).toBeLessThanOrEqual(64);
      expect(metadata.height).toBeLessThanOrEqual(64);
      expect(metadata.pages ?? 1).toBe(1);
      expect(
        (await sharp(data).stats()).isOpaque || (await sharp(data).stats()).channels[3].max > 0
      ).toBe(true);
    }
  });

  test("rejects garbage, source MIME conflicts, forbidden SVG, excessive pixels and body bytes", async () => {
    for (const [bytes, types] of [
      [Buffer.from("garbage"), []],
      [notion, ["image/png"]],
      [notion, ["image/svg+xml", "image/jpeg"]],
      [
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>'
        ),
        ["image/svg+xml"],
      ],
      [
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"><rect width="20000" height="20000"/></svg>'
        ),
        ["image/svg+xml"],
      ],
      [Buffer.alloc(512 * 1024 + 1), []],
    ] satisfies Array<[Buffer, string[]]>)
      expect(await decodeMcpIcon(bytes, types, deadline())).toBeNull();
    expect(await decodeMcpIcon(notion, ["application/octet-stream"], deadline())).not.toBeNull();
  });

  test("does not spawn for expired jobs", async () => {
    const signal = AbortSignal.abort();
    expect(
      await decodeMcpIcon(notion, [], signal, () => {
        throw new Error("must not spawn");
      })
    ).toBeNull();
  });

  test("kills a stalled filtering child and waits for its observed exit", async () => {
    let pid: number | undefined;
    const exitSignals: Array<NodeJS.Signals | null> = [];
    let exited = false;
    let enteredFilter = false;
    const started = Date.now();
    const result = await decodeMcpIcon(notion, [], AbortSignal.timeout(500), (_entry, options) => {
      const child = fork(
        path.resolve(__dirname, "../../../tests/fixtures/mcp/stalled-icon-worker.ts"),
        options
      );
      pid = child.pid;
      child.on("message", (message) => {
        enteredFilter = message === "filtering";
      });
      child.on("exit", (_code, signal) => {
        exited = true;
        exitSignals.push(signal);
      });
      return child;
    });
    expect(result).toBeNull();
    expect(exited).toBe(true);
    expect(enteredFilter).toBe(true);
    expect(exitSignals).toEqual(["SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  test("treats failed launches as absent artwork", async () => {
    expect(
      await decodeMcpIcon(notion, [], deadline(), (_entry, options) =>
        fork("/missing-mcp-icon-worker.cjs", options)
      )
    ).toBeNull();
  });
});
