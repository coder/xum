import { describe, expect, test } from "bun:test";
import { fork, type ForkOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MCP_ICON_LIMITS } from "@/common/constants/mcpIcon";
import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import type { MCPConnectionRef } from "@/common/types/mcp";
import { isPngDataUrl } from "@/common/utils/mcp/pngDataUrl";
import type { PinnedHttpsFetchResult } from "@/node/utils/network/pinnedHttpsFetch";
import { decodeMcpIcon } from "./mcpIconDecodeClient";
import { createIconResolver, resolveServerIcon, selectIconCandidate } from "./mcpServerIcon";
import type { IconCandidate } from "./mcpServerIdentity";

const notionSvg = readFileSync(
  path.resolve(__dirname, "../../../tests/fixtures/mcp/notion-icon.svg")
);
const notionDataUrl = `data:image/svg+xml;base64,${notionSvg.toString("base64")}`;
const pngDataUrl = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`;

const stdio: MCPConnectionRef = { key: "notion", transport: "stdio" };
const http: MCPConnectionRef = {
  key: "notion",
  transport: "http",
  origin: "https://mcp.notion.com",
};
const sse: MCPConnectionRef = {
  key: "notion",
  transport: "sse",
  origin: "https://mcp.notion.com:8443",
};
const httpWithoutOrigin: MCPConnectionRef = { key: "local", transport: "http" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("selectIconCandidate", () => {
  test("rejects unsupported schemes and malformed data URLs", () => {
    for (const src of [
      "http://mcp.notion.com/icon.png",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/png,notbase64",
      "data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
      "DATA:image/png;base64,iVBORw0KGgo=",
      "data:image/bmp;base64,Qk0=",
      "data:image/x-icon;base64,AAABAA==",
      "data:image/svg+xml;base64,",
      "",
    ]) {
      expect(selectIconCandidate([{ src }], stdio)).toBeNull();
    }
  });

  test("accepts each allowed data MIME with strict base64 and rejects loose encodings", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]) {
      const selected = selectIconCandidate([{ src: `data:${mime};base64,QUJDRA==` }], stdio);
      expect(selected).toEqual({ kind: "data", base64: "QUJDRA==", mimeTypes: [mime] });
    }
    for (const payload of [
      "QUJDRA=",
      "QUJD RA==",
      "QUJDRA===",
      "QUJ-RA==",
      "QUJDRB==",
      "QUJDR===",
      "QQ",
    ]) {
      expect(selectIconCandidate([{ src: `data:image/png;base64,${payload}` }], stdio)).toBeNull();
    }
  });

  test("bounds data URLs by total length before decoding and by decoded size", () => {
    // Valid base64 that would decode above the body cap while staying under the URL cap.
    const overBody = "A".repeat(716_000);
    expect(overBody.length).toBeLessThanOrEqual(MCP_IDENTITY_LIMITS.iconDataSrcMaxChars);
    expect((overBody.length / 4) * 3).toBeGreaterThan(MCP_ICON_LIMITS.bodyMaxBytes);
    expect(selectIconCandidate([{ src: `data:image/png;base64,${overBody}` }], stdio)).toBeNull();

    const overUrl = "A".repeat(MCP_IDENTITY_LIMITS.iconDataSrcMaxChars);
    expect(selectIconCandidate([{ src: `data:image/png;base64,${overUrl}` }], stdio)).toBeNull();

    const largestAllowed = "A".repeat(Math.floor(MCP_ICON_LIMITS.bodyMaxBytes / 3) * 4);
    expect(
      selectIconCandidate([{ src: `data:image/png;base64,${largestAllowed}` }], stdio)?.kind
    ).toBe("data");
  });

  test("allows https only for url bindings with the exact configured origin", () => {
    const src = "https://mcp.notion.com/static/icon.svg?v=2";
    expect(selectIconCandidate([{ src }], stdio)).toBeNull();
    expect(selectIconCandidate([{ src }], httpWithoutOrigin)).toBeNull();
    const selected = selectIconCandidate([{ src }], http);
    expect(selected?.kind).toBe("https");
    if (selected?.kind !== "https") throw new Error("expected an https selection");
    expect(selected.url.href).toBe(src);
    expect(selected.mimeTypes).toEqual([]);
    expect(selectIconCandidate([{ src: "https://mcp.notion.com:8443/icon.png" }], sse)?.kind).toBe(
      "https"
    );
    // Hostnames are case-insensitive: the serialized origin still matches exactly.
    expect(selectIconCandidate([{ src: "https://MCP.notion.com/icon.svg" }], http)?.kind).toBe(
      "https"
    );
    for (const other of [
      "https://cdn.notion.so/icon.svg",
      "https://mcp.notion.com:8443/icon.svg",
      "https://mcp.notion.com.evil.example/icon.svg",
      "https://user@mcp.notion.com/icon.svg",
      "https://user:pw@mcp.notion.com/icon.svg",
      `https://mcp.notion.com/${"i".repeat(MCP_IDENTITY_LIMITS.iconHttpsSrcMaxChars)}`,
    ]) {
      expect(selectIconCandidate([{ src: other }], http)).toBeNull();
    }
  });

  test("prefers a 32–128 (or any) size, then a dark theme, then declaration order", () => {
    const pick = (candidates: IconCandidate[]): string | null => {
      const selected = selectIconCandidate(candidates, http);
      return selected?.kind === "https" ? selected.url.pathname : null;
    };
    const candidates: IconCandidate[] = [
      { src: "https://mcp.notion.com/tiny.png", sizes: ["16x16"] },
      { src: "https://mcp.notion.com/unsized.png" },
      { src: "https://mcp.notion.com/light-any.svg", sizes: ["any"], theme: "light" },
      { src: "https://mcp.notion.com/dark-48.png", sizes: ["512x512", "48x48"], theme: "dark" },
      { src: "https://mcp.notion.com/dark-64.png", sizes: ["64x64"], theme: "dark" },
    ];
    expect(pick(candidates)).toBe("/dark-48.png");
    // Without a dark match the first sized match wins; without sized matches the
    // first unsized one; a non-matching size is the last resort.
    expect(pick(candidates.slice(0, 3))).toBe("/light-any.svg");
    expect(pick(candidates.slice(0, 2))).toBe("/unsized.png");
    expect(pick(candidates.slice(0, 1))).toBe("/tiny.png");
    // Ineligible candidates never win, whatever their rank.
    expect(
      pick([
        { src: "https://cdn.notion.so/dark.png", sizes: ["64x64"], theme: "dark" },
        candidates[1],
      ])
    ).toBe("/unsized.png");
  });

  test("considers only the first eight candidates and copies what it keeps", () => {
    const filler = Array.from({ length: MCP_IDENTITY_LIMITS.iconCandidatesMax }, (_, i) => ({
      src: `http://mcp.notion.com/${i}.png`,
    }));
    expect(selectIconCandidate([...filler, { src: pngDataUrl }], stdio)).toBeNull();

    const candidate: IconCandidate = { src: pngDataUrl, mimeType: "image/png", sizes: ["64x64"] };
    const selected = selectIconCandidate([candidate], stdio);
    expect(selected).toEqual({
      kind: "data",
      base64: pngDataUrl.slice("data:image/png;base64,".length),
      mimeTypes: ["image/png"],
    });
    candidate.mimeType = "image/jpeg";
    candidate.sizes!.push("mutated");
    expect(selected).toEqual({
      kind: "data",
      base64: pngDataUrl.slice("data:image/png;base64,".length),
      mimeTypes: ["image/png"],
    });
  });

  test("canonicalizes MIME hints to their essence, dedupes, and fails closed on overlong image claims", () => {
    expect(
      selectIconCandidate([{ src: notionDataUrl, mimeType: "Image/SVG+XML; charset=utf-8" }], stdio)
    ).toMatchObject({ mimeTypes: ["image/svg+xml"] });
    expect(
      selectIconCandidate([{ src: notionDataUrl, mimeType: "image/png" }], stdio)
    ).toMatchObject({
      mimeTypes: ["image/png", "image/svg+xml"],
    });
    expect(
      selectIconCandidate([{ src: "https://mcp.notion.com/icon", mimeType: "image/webp" }], http)
    ).toMatchObject({ mimeTypes: ["image/webp"] });
    // Parameters never push a specific claim past the bound…
    expect(
      selectIconCandidate(
        [{ src: notionDataUrl, mimeType: `image/jpeg; padding=${"x".repeat(200)}` }],
        stdio
      )
    ).toMatchObject({ mimeTypes: ["image/jpeg", "image/svg+xml"] });
    // …an overlong specific image essence cannot be relayed, so the candidate is ineligible…
    expect(
      selectIconCandidate([{ src: notionDataUrl, mimeType: `image/${"x".repeat(200)}` }], stdio)
    ).toBeNull();
    // …while an overlong generic type is advisory noise and is simply dropped.
    expect(
      selectIconCandidate(
        [{ src: notionDataUrl, mimeType: `application/${"x".repeat(200)}` }],
        stdio
      )
    ).toMatchObject({ mimeTypes: ["image/svg+xml"] });
  });
});

describe("resolveServerIcon", () => {
  test("refuses an over-budget candidate set before its deadline, selection, fetch, or decode", async () => {
    const seams = { deadline: 0, fetch: 0, decode: 0 };
    const resolver = createIconResolver({
      createDeadline: () => {
        seams.deadline++;
        return new AbortController().signal;
      },
      fetch: () => {
        seams.fetch++;
        return Promise.resolve(null);
      },
      decode: () => {
        seams.decode++;
        return Promise.resolve(pngDataUrl);
      },
    });
    // Near the single-source limit while still decodable (<= bodyMaxBytes once decoded).
    const src = `data:image/png;base64,${"A".repeat(699_048)}`;
    expect(src.length).toBeLessThanOrEqual(MCP_ICON_LIMITS.candidateSrcTotalMaxChars);
    const reads: Array<Array<string | symbol>> = [];
    const candidates = Array.from({ length: MCP_IDENTITY_LIMITS.iconCandidatesMax }, () => {
      const keys: Array<string | symbol> = [];
      reads.push(keys);
      return new Proxy<IconCandidate>(
        { src, mimeType: "image/png", sizes: ["64x64"] },
        {
          get: (target, key): unknown => {
            keys.push(key);
            return Reflect.get(target, key);
          },
        }
      );
    });
    expect(await resolver.resolve(candidates, stdio)).toBeNull();
    expect(seams).toEqual({ deadline: 0, fetch: 0, decode: 0 });
    // Only `src` lengths were read, and only until the budget overflowed.
    expect(reads).toEqual([["src"], ["src"], [], [], [], [], [], []]);

    // A single near-limit source still takes the normal path.
    expect(await resolver.resolve([{ src, mimeType: "image/png" }], stdio)).toBe(pngDataUrl);
    expect(seams).toEqual({ deadline: 1, fetch: 0, decode: 1 });
  });

  test("renders the unchanged Notion SVG data URL into a bounded PNG through the real decoder", async () => {
    const result = await resolveServerIcon(
      [{ src: notionDataUrl, mimeType: "image/svg+xml" }],
      stdio
    );
    expect(isPngDataUrl(result)).toBe(true);
  }, 15_000);

  test("returns null without work when nothing is eligible", async () => {
    let touched = 0;
    const resolver = createIconResolver({
      fetch: () => {
        touched++;
        return Promise.resolve(null);
      },
      decode: () => {
        touched++;
        return Promise.resolve(null);
      },
    });
    expect(await resolver.resolve([{ src: "https://mcp.notion.com/icon.png" }], stdio)).toBeNull();
    expect(await resolver.resolve([], http)).toBeNull();
    expect(touched).toBe(0);
  });

  test("fetches https candidates through the pinned fetch and decodes with the observed MIME hints", async () => {
    const fetchCalls: URL[] = [];
    const decodeCalls: Array<{ bytes: Buffer; mimeTypes: string[] }> = [];
    const resolver = createIconResolver({
      fetch: (url, signal) => {
        fetchCalls.push(url);
        expect(signal.aborted).toBe(false);
        return Promise.resolve<PinnedHttpsFetchResult>({
          bytes: notionSvg,
          contentType: "image/svg+xml; charset=utf-8",
        });
      },
      decode: (bytes, mimeTypes) => {
        decodeCalls.push({ bytes, mimeTypes });
        return Promise.resolve(pngDataUrl);
      },
    });
    expect(
      await resolver.resolve(
        [{ src: "https://mcp.notion.com/icon.svg", mimeType: "image/svg+xml" }],
        http
      )
    ).toBe(pngDataUrl);
    expect(fetchCalls.map(String)).toEqual(["https://mcp.notion.com/icon.svg"]);
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0].bytes.equals(notionSvg)).toBe(true);
    expect(decodeCalls[0].mimeTypes).toEqual(["image/svg+xml"]);

    // A data candidate decodes its own bytes with the data MIME as the hint.
    expect(await resolver.resolve([{ src: notionDataUrl }], stdio)).toBe(pngDataUrl);
    expect(fetchCalls).toHaveLength(1);
    expect(decodeCalls[1].bytes.equals(notionSvg)).toBe(true);
    expect(decodeCalls[1].mimeTypes).toEqual(["image/svg+xml"]);
  });

  test("a fetched content-type is judged by its essence through the real decoder", async () => {
    const withContentType = (contentType: string) =>
      createIconResolver({
        fetch: () => Promise.resolve({ bytes: notionSvg, contentType }),
      }).resolve([{ src: "https://mcp.notion.com/icon.svg" }], http);
    // A conflicting specific claim hidden behind long parameters still rejects…
    expect(await withContentType(`image/jpeg; padding=${"x".repeat(200)}`)).toBeNull();
    // …a matching claim with long parameters still renders…
    expect(
      isPngDataUrl(
        await withContentType(`image/svg+xml; charset=utf-8; padding=${"x".repeat(200)}`)
      )
    ).toBe(true);
    // …and an unrelated generic type stays advisory.
    expect(isPngDataUrl(await withContentType(`application/${"x".repeat(200)}`))).toBe(true);
  }, 15_000);

  test("an overlong specific image content-type fails closed before decoding", async () => {
    let decodes = 0;
    const resolver = createIconResolver({
      fetch: () => Promise.resolve({ bytes: notionSvg, contentType: `image/${"x".repeat(200)}` }),
      decode: () => {
        decodes++;
        return Promise.resolve(pngDataUrl);
      },
    });
    expect(await resolver.resolve([{ src: "https://mcp.notion.com/icon.svg" }], http)).toBeNull();
    expect(decodes).toBe(0);
  });

  test("absent or failing fetches yield null and never reach the decoder", async () => {
    let decodes = 0;
    const failing = createIconResolver({
      fetch: () => Promise.reject(new Error("socket hang up")),
      decode: () => {
        decodes++;
        return Promise.resolve(pngDataUrl);
      },
    });
    expect(await failing.resolve([{ src: "https://mcp.notion.com/icon.svg" }], http)).toBeNull();
    const absent = createIconResolver({
      fetch: () => Promise.resolve(null),
      decode: () => {
        decodes++;
        return Promise.resolve(pngDataUrl);
      },
    });
    expect(await absent.resolve([{ src: "https://mcp.notion.com/icon.svg" }], http)).toBeNull();
    expect(decodes).toBe(0);
    // The failed job released its slot: the resolver still serves later jobs.
    const later = createIconResolver({
      fetch: () => Promise.reject(new Error("boom")),
      decode: () => Promise.resolve(pngDataUrl),
    });
    await later.resolve([{ src: "https://mcp.notion.com/icon.svg" }], http);
    expect(await later.resolve([{ src: notionDataUrl }], stdio)).toBe(pngDataUrl);
  });

  /** Decoder stand-in: each call holds its slot until the test releases it, like a child exit. */
  function createHeldDecoder() {
    const releases: Array<Deferred<string | null>> = [];
    let live = 0;
    let maxLive = 0;
    const decode = (_bytes: Buffer, _mimeTypes: string[], signal: AbortSignal) => {
      live++;
      maxLive = Math.max(maxLive, live);
      const gate = deferred<string | null>();
      releases.push(gate);
      return gate.promise.then((value) => {
        live--;
        return signal.aborted ? null : value;
      });
    };
    return {
      decode,
      releases,
      get live() {
        return live;
      },
      get maxLive() {
        return maxLive;
      },
    };
  }

  test("runs at most two jobs at once and frees a slot only when the decoder settles", async () => {
    const held = createHeldDecoder();
    const resolver = createIconResolver({ decode: held.decode });
    const jobs = Array.from({ length: 5 }, () => resolver.resolve([{ src: notionDataUrl }], stdio));
    await tick();
    expect(held.live).toBe(2);
    expect(held.releases).toHaveLength(2);

    held.releases[0].resolve(pngDataUrl);
    await tick();
    expect(held.live).toBe(2);
    expect(held.releases).toHaveLength(3);
    expect(await jobs[0]).toBe(pngDataUrl);

    for (const release of held.releases.slice(1)) release.resolve(pngDataUrl);
    await tick();
    for (const release of held.releases.slice(3)) release.resolve(pngDataUrl);
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: 5 }, () => pngDataUrl));
    expect(held.maxLive).toBe(2);
    expect(held.releases).toHaveLength(5);
  });

  test("rejects the ninth queued job immediately", async () => {
    const held = createHeldDecoder();
    const resolver = createIconResolver({ decode: held.decode });
    const total = MCP_ICON_LIMITS.concurrentJobs + MCP_ICON_LIMITS.queuedJobs;
    const jobs = Array.from({ length: total }, () =>
      resolver.resolve([{ src: notionDataUrl }], stdio)
    );
    await tick();
    expect(held.live).toBe(MCP_ICON_LIMITS.concurrentJobs);
    expect(await resolver.resolve([{ src: notionDataUrl }], stdio)).toBeNull();
    expect(held.releases).toHaveLength(MCP_ICON_LIMITS.concurrentJobs);

    for (let i = 0; i < total; i++) {
      await tick();
      held.releases[i]?.resolve(pngDataUrl);
    }
    expect(await Promise.all(jobs)).toEqual(Array.from({ length: total }, () => pngDataUrl));
  });

  test("the deadline covers queueing: an expired queued job is dropped without launching", async () => {
    const held = createHeldDecoder();
    const controllers: AbortController[] = [];
    let fetches = 0;
    const resolver = createIconResolver({
      decode: held.decode,
      fetch: () => {
        fetches++;
        return Promise.resolve({ bytes: notionSvg, contentType: "image/svg+xml" });
      },
      createDeadline: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
    });
    const running = [
      resolver.resolve([{ src: notionDataUrl }], stdio),
      resolver.resolve([{ src: notionDataUrl }], stdio),
    ];
    const queued = resolver.resolve([{ src: "https://mcp.notion.com/icon.svg" }], http);
    await tick();
    expect(held.live).toBe(2);
    controllers[2].abort();
    expect(await queued).toBeNull();
    expect(fetches).toBe(0);

    // Releasing the running jobs must not resurrect the expired one.
    held.releases[0].resolve(pngDataUrl);
    held.releases[1].resolve(pngDataUrl);
    await tick();
    expect(await Promise.all(running)).toEqual([pngDataUrl, pngDataUrl]);
    expect(held.releases).toHaveLength(2);
    expect(fetches).toBe(0);
  });

  test("an expired job never fetches or decodes, and a running job's slot outlives its abort", async () => {
    const held = createHeldDecoder();
    const controllers: AbortController[] = [];
    let fetches = 0;
    const resolver = createIconResolver({
      decode: held.decode,
      fetch: () => {
        fetches++;
        return Promise.resolve({ bytes: notionSvg, contentType: "image/svg+xml" });
      },
      createDeadline: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
    });

    // Job 0 is already expired at admission.
    const expiredResult = resolver.resolve([{ src: "https://mcp.notion.com/icon.svg" }], http);
    controllers[0].abort();
    expect(await expiredResult).toBeNull();
    expect(fetches).toBe(0);
    expect(held.releases).toHaveLength(0);

    // Jobs 1 and 2 hold both slots; job 3 waits. Aborting job 1 must not free its
    // slot until its decoder settles (the child has exited).
    const first = resolver.resolve([{ src: notionDataUrl }], stdio);
    const second = resolver.resolve([{ src: notionDataUrl }], stdio);
    const third = resolver.resolve([{ src: notionDataUrl }], stdio);
    await tick();
    expect(held.live).toBe(2);
    controllers[1].abort();
    await tick();
    expect(held.live).toBe(2);
    expect(held.releases).toHaveLength(2);

    held.releases[0].resolve(pngDataUrl);
    expect(await first).toBeNull();
    await tick();
    expect(held.releases).toHaveLength(3);
    held.releases[1].resolve(pngDataUrl);
    held.releases[2].resolve(pngDataUrl);
    expect(await Promise.all([second, third])).toEqual([pngDataUrl, pngDataUrl]);
  });
  test("five jobs through the real killable decoder keep at most two live children and reap them all", async () => {
    interface ObservedChild {
      pid: number;
      /** Resolves once the fixture reports it entered its (stalled) filtering phase. */
      filtering: Promise<void>;
      /** Resolves with the exit signal and how many children had been born by then. */
      exited: Promise<{ signal: NodeJS.Signals | null; birthsAtExit: number }>;
    }
    const children: ObservedChild[] = [];
    let live = 0;
    let maxLive = 0;
    const spawnStalled = (_entry: string, options: ForkOptions) => {
      const child = fork(
        path.resolve(__dirname, "../../../tests/fixtures/mcp/stalled-icon-worker.ts"),
        options
      );
      live++;
      maxLive = Math.max(maxLive, live);
      const filtering = new Promise<void>((resolve) =>
        child.on("message", (message) => {
          if (message === "filtering") resolve();
        })
      );
      const exited = new Promise<{ signal: NodeJS.Signals | null; birthsAtExit: number }>(
        (resolve) =>
          child.once("exit", (_code, signal) => {
            live--;
            resolve({ signal, birthsAtExit: children.length });
          })
      );
      if (child.pid === undefined) throw new Error("fixture child did not start");
      children.push({ pid: child.pid, filtering, exited });
      return child;
    };
    const controllers: AbortController[] = [];
    const resolver = createIconResolver({
      decode: (bytes, mimeTypes, signal) => decodeMcpIcon(bytes, mimeTypes, signal, spawnStalled),
      createDeadline: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      },
    });

    const jobs = Array.from({ length: 5 }, () => resolver.resolve([{ src: notionDataUrl }], stdio));
    // Admission and spawning complete within the current microtask turn.
    await tick();
    expect(children).toHaveLength(2);
    await Promise.all([children[0].filtering, children[1].filtering]);
    expect(live).toBe(2);

    // Each admitted job is aborted in turn; the next queued job may only be
    // born after the killed child's exit was observed.
    for (let index = 0; index < 5; index++) {
      controllers[index].abort();
      const exit = await children[index].exited;
      expect(exit.signal).toBe("SIGKILL");
      expect(exit.birthsAtExit).toBe(Math.min(index + 2, 5));
      await tick();
      if (index + 2 < 5) {
        expect(children).toHaveLength(index + 3);
        await children[index + 2].filtering;
      } else {
        expect(children).toHaveLength(5);
      }
    }

    expect(await Promise.all(jobs)).toEqual([null, null, null, null, null]);
    expect(children).toHaveLength(5);
    expect(maxLive).toBe(2);
    expect(live).toBe(0);
    for (const child of children) {
      expect(() => process.kill(child.pid, 0)).toThrow();
    }
  }, 20_000);
});
