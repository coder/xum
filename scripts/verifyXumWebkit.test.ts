import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { MERMAID_PENDING_TEXT } from "../src/browser/features/Messages/MermaidPendingFrame";

const SKILL_SCRIPTS = path.join(import.meta.dir, "../.xum/skills/verify-xum/scripts");
const HELPER = path.join(SKILL_SCRIPTS, "webkit-capture.mjs");
const TOKEN = "tok-3f9a/+=secret value";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Docker image of verify-xum.sh webkit-capture", () => {
  const script = fs.readFileSync(path.join(SKILL_SCRIPTS, "verify-xum.sh"), "utf8");
  const pinned = (name: string) => new RegExp(`^${name}=(\\S+)$`, "m").exec(script)?.[1];

  test("carries the Playwright version of the root playwright-core pin, by digest", () => {
    // The image's browsers are the revisions that its Playwright version drives. A bump of the
    // root pin without a new digest makes the in-container launch fail on a missing executable.
    const rootPin = (
      JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../package.json"), "utf8")) as {
        devDependencies: Record<string, string>;
      }
    ).devDependencies["playwright-core"];
    expect(pinned("WEBKIT_IMAGE_PLAYWRIGHT_CORE")).toBe(rootPin);
    expect(pinned("WEBKIT_IMAGE")).toMatch(/^mcr\.microsoft\.com\/playwright@sha256:[0-9a-f]{64}$/);
  });
});

interface FakeRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  evidenceDir: string;
  /** What the fake Playwright saw. */
  seen: { contextOptions?: Record<string, unknown>; url?: string };
}

/**
 * Runs the real helper with a fake `playwright-core` in a scratch checkout, so no browser is
 * needed. The fake page reports `scrollWidth`, a failed-chunk flag and one console error that
 * echoes the URL it was given (the token included), like a Vite failure would.
 */
async function runHelper(options: {
  scrollWidth?: number;
  chunkFailed?: boolean;
  launchError?: string;
  /** The page never settles and still shows these placeholders. */
  stuckOn?: string[];
}): Promise<FakeRun> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-xum-webkit-test-"));
  tempDirs.push(root);
  const pw = path.join(root, "checkout/node_modules/playwright-core");
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, "package.json"), '{"name":"playwright-core","version":"9.9.9"}');
  fs.writeFileSync(
    path.join(pw, "index.js"),
    `
const fs = require("fs");
const seen = {};
const save = () => fs.writeFileSync(process.env.FAKE_SEEN, JSON.stringify(seen));
exports.webkit = {
  async launch() {
    if (${JSON.stringify(options.launchError ?? null)}) throw new Error(${JSON.stringify(options.launchError ?? "")});
    return {
      version: () => "27.2",
      close: async () => {},
      async newContext(contextOptions) {
        seen.contextOptions = contextOptions;
        save();
        return { async newPage() {
          const handlers = {};
          return {
            on: (event, handler) => { handlers[event] = handler; },
            async goto(url) {
              seen.url = url;
              save();
              handlers.console?.({ type: () => "error", text: () => "Failed to load resource: " + url });
            },
            async waitForFunction() {
              if (${JSON.stringify(options.stuckOn !== undefined)}) {
                throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
              }
            },
            async evaluate(expression) {
              if (typeof expression === "string" && expression.includes("innerText")) return ${JSON.stringify(options.stuckOn ?? [])};
              if (typeof expression === "string") return ${JSON.stringify(options.chunkFailed ?? false)};
              return { scrollWidth: ${options.scrollWidth ?? 390}, innerWidth: 390 };
            },
            async screenshot({ path }) { fs.writeFileSync(path, "png"); },
            url: () => seen.url,
          };
        } };
      },
    };
  },
};`
  );
  const evidenceDir = path.join(root, "evidence/chat");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const seenPath = path.join(root, "seen.json");

  const proc = Bun.spawn(
    [
      "node",
      HELPER,
      ...["--checkout", path.join(root, "checkout")],
      ...["--base", "http://127.0.0.1:9"],
      ...["--path", "/workspace/abc"],
      ...["--out", path.join(evidenceDir, "reply-webkit.png")],
      ...["--mode", "host"],
      ...["--settled-js", "true"],
      ...["--chunk-failed-js", "false"],
    ],
    {
      env: { PATH: process.env.PATH ?? "", FAKE_SEEN: seenPath },
      stdin: new Blob([TOKEN]),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const seen = fs.existsSync(seenPath)
    ? (JSON.parse(fs.readFileSync(seenPath, "utf8")) as FakeRun["seen"])
    : {};
  return { exitCode, stdout, stderr, evidenceDir, seen };
}

function expectNoToken(text: string) {
  for (const form of [
    TOKEN,
    encodeURIComponent(TOKEN),
    new URLSearchParams({ t: TOKEN }).toString().slice(2),
  ]) {
    expect(text).not.toContain(form);
  }
}

describe("webkit-capture.mjs", () => {
  test("opens the page as a phone with the token, and writes a report without it", async () => {
    const run = await runHelper({});
    expect(run.exitCode, run.stderr).toBe(0);

    // The page got the token, so the app signs in; the evidence never holds it.
    expect(new URL(run.seen.url ?? "").searchParams.get("token")).toBe(TOKEN);
    expect(run.seen.contextOptions).toMatchObject({ isMobile: true, hasTouch: true });
    expect(fs.readFileSync(path.join(run.evidenceDir, "reply-webkit.png"), "utf8")).toBe("png");
    const report = fs.readFileSync(path.join(run.evidenceDir, "reply-webkit.txt"), "utf8");
    expect(report).toContain("console and page errors: 1");
    expect(report).toContain("token=<redacted>");
    expect(report).toContain("scrollWidth <= innerWidth: true (390 <= 390)");
    expectNoToken(report + run.stdout + run.stderr);
  });

  test("says when the page is wider than the viewport", async () => {
    const run = await runHelper({ scrollWidth: 800 });
    expect(run.exitCode, run.stderr).toBe(0);
    const report = fs.readFileSync(path.join(run.evidenceDir, "reply-webkit.txt"), "utf8");
    expect(report).toContain("scrollWidth <= innerWidth: false (800 <= 390)");
  });

  test("exits 3 and keeps no evidence when the page shows a failed chunk, as idle does", async () => {
    const run = await runHelper({ chunkFailed: true });
    expect(run.exitCode).toBe(3);
    expect(fs.readdirSync(run.evidenceDir)).toEqual([]);
    expectNoToken(run.stdout + run.stderr);
  });

  test("names the placeholder a page is stuck on instead of capturing it", async () => {
    const run = await runHelper({ stuckOn: [MERMAID_PENDING_TEXT] });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(JSON.stringify(MERMAID_PENDING_TEXT));
    expect(fs.readdirSync(run.evidenceDir)).toEqual([]);
  });

  test("waits for Mermaid's own placeholder, which no CSS transition or busy flag shows", () => {
    // `idle`'s test reads a page that still says "Rendering diagram..." as settled.
    expect(fs.readFileSync(HELPER, "utf8")).toContain(JSON.stringify(MERMAID_PENDING_TEXT));
  });

  test("exits 4 with one line when WebKit does not launch, so the caller can try Docker", async () => {
    const run = await runHelper({
      launchError: `browserType.launch: \n╔═══╗\n║ Host system is missing dependencies to run browsers. ║\n╚═══╝ ${TOKEN}`,
    });
    expect(run.exitCode).toBe(4);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain("Host system is missing dependencies");
    expectNoToken(run.stderr);
  });
});
