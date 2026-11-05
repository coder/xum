import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import { Window } from "happy-dom";

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

  test("names the Playwright version of the root playwright-core pin, and pins the image by digest", () => {
    // The image's browsers are the revisions that its Playwright version drives. This catches a
    // bump of the root pin that leaves the version constant behind. A digest that does not hold
    // that version's browsers cannot be seen offline: the launch then fails with Playwright's
    // "Executable doesn't exist" message.
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
  seen: { contextOptions?: Record<string, unknown>; url?: string; stateCalls?: number };
}

/** A value that the fake page returns from `page.evaluate`: a number, or a hostile one. */
type PageValue = number | { kind: "string" | "object" | "nan" | "infinity"; text?: string };

/**
 * Runs the real helper with a fake `playwright-core` in a scratch checkout, so no browser is
 * needed. The fake page answers the state check with `states` in order (the last one repeats), the
 * width check with `widths`, and emits console and page errors when it is opened.
 */
async function runHelper(options: {
  states?: PageValue[];
  widths?: PageValue[];
  settleMs?: number;
  launchError?: string;
  /** Closing the browser fails after the screenshot and the report were written. */
  closeError?: string;
  /** How many console errors and page errors the page emits, each with `errorText`. */
  consoleErrors?: number;
  pageErrors?: number;
  errorText?: string;
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
const options = ${JSON.stringify(options)};
const seen = { stateCalls: 0 };
const save = () => fs.writeFileSync(process.env.FAKE_SEEN, JSON.stringify(seen));
const value = (v) => {
  if (typeof v === "number") return v;
  if (v.kind === "string") return v.text;
  if (v.kind === "object") return { toString: () => v.text };
  return v.kind === "nan" ? NaN : Infinity;
};
exports.webkit = {
  async launch() {
    if (options.launchError) throw new Error(options.launchError);
    return {
      version: () => "27.2",
      close: async () => {
        if (options.closeError) throw new Error(options.closeError);
      },
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
              const text = options.errorText ?? "Failed to load resource: " + url;
              for (let i = 0; i < (options.consoleErrors ?? 1); i += 1) handlers.console?.({ type: () => "error", text: () => text });
              handlers.console?.({ type: () => "log", text: () => text });
              for (let i = 0; i < (options.pageErrors ?? 0); i += 1) handlers.pageerror?.({ message: text });
            },
            async evaluate(expression) {
              if (typeof expression === "string") {
                const states = options.states ?? [32];
                seen.stateCalls += 1;
                save();
                return value(states[Math.min(seen.stateCalls - 1, states.length - 1)]);
              }
              return (options.widths ?? [390, 390]).map(value);
            },
            async screenshot({ path }) { fs.writeFileSync(path, "png"); },
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
      ...["--settle-ms", String(options.settleMs ?? 5000)],
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

/** Characters that start a terminal escape sequence or act on the terminal: C0 (but not a newline), DEL, C1. */
function controlCharacters(text: string): string[] {
  return [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && char !== "\n") || (code >= 0x7f && code <= 0x9f);
  });
}

const readReport = (run: FakeRun) =>
  fs.readFileSync(path.join(run.evidenceDir, "reply-webkit.txt"), "utf8");

// The state bits of webkit-capture.mjs, written out here so a change of a bit fails a test.
const SETTLED = 32;

describe("webkit-capture.mjs", () => {
  test("opens the page as a phone with the token, and writes a report of fixed text", async () => {
    const run = await runHelper({});
    expect(run.exitCode, run.stderr).toBe(0);

    // The page got the token, so the app signs in. The evidence holds the URL without it.
    expect(new URL(run.seen.url ?? "").searchParams.get("token")).toBe(TOKEN);
    expect(run.seen.contextOptions).toMatchObject({ isMobile: true, hasTouch: true });
    expect(fs.readdirSync(run.evidenceDir).sort()).toEqual([
      "reply-webkit.png",
      "reply-webkit.txt",
    ]);
    expect(fs.readFileSync(path.join(run.evidenceDir, "reply-webkit.png"), "utf8")).toBe("png");
    const report = readReport(run);
    expect(report).toContain("url: http://127.0.0.1:9/workspace/abc\n");
    expect(report).toContain("console errors: 1\n");
    expect(report).toContain("page errors: 0\n");
    expect(report).toContain("scrollWidth <= innerWidth: true (390 <= 390)");
    // The fake page's console error echoes its URL, token included. None of its text is kept.
    expect(report).not.toContain("Failed to load resource");
    expectNoToken(report + run.stdout + run.stderr);
  });

  test("says when the page is wider than the viewport", async () => {
    const run = await runHelper({ widths: [800, 390] });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(readReport(run)).toContain("scrollWidth <= innerWidth: false (800 <= 390)");
  });

  test("exits 3 and keeps no evidence when the page shows a failed chunk, as idle does", async () => {
    const run = await runHelper({ states: [1 | SETTLED] });
    expect(run.exitCode).toBe(3);
    expect(fs.readdirSync(run.evidenceDir)).toEqual([]);
    expectNoToken(run.stdout + run.stderr);
  });

  test.each([
    [8 | SETTLED, "the loading screen"],
    [16 | SETTLED, "a Mermaid diagram that is still rendering"],
    [8, "the loading screen"],
  ])("names what a page that never settles still shows (state %d)", async (state, shown) => {
    const run = await runHelper({ states: [state], settleMs: 400 });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`did not settle in 0.4 s: it still shows ${shown}.`);
    expect(fs.readdirSync(run.evidenceDir)).toEqual([]);
  });

  test.each([
    [2 | SETTLED, "the startup connection error"],
    [4 | SETTLED, "the authentication prompt"],
  ])(
    "exits 1 and keeps no evidence when the page shows a startup failure (state %d)",
    async (state, shown) => {
      const run = await runHelper({ states: [state] });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(`the page shows ${shown}.`);
      expect(fs.readdirSync(run.evidenceDir)).toEqual([]);
    }
  );

  test("keeps no evidence when closing the browser fails after the files were written", async () => {
    const run = await runHelper({ closeError: "browser.close: target closed" });
    expect(run.exitCode).not.toBe(0);
    expect(fs.readdirSync(run.evidenceDir)).toEqual([]);
    expect(run.stderr).toContain("failed while trying to close the browser");
    expect(run.stderr).not.toContain("target closed");
  });

  test("prints and writes no text that a hostile page controls, and counts its errors", async () => {
    // OSC 52 writes the terminal's clipboard. The page also tries the token, colour codes, a C1 CSI
    // and DEL. Its errors are many (10,000 of each kind) and its answers to the state and width
    // checks are not integers or finite numbers, or are objects with a toString.
    const hostile = `boom \u001b]52;c;Zm9v\u0007 ${TOKEN} \u001b[31mred\u001b[0m \u009b31m del\u007f end`;
    const answers: PageValue[] = [
      { kind: "string", text: hostile },
      { kind: "object", text: hostile },
      { kind: "nan" },
      { kind: "infinity" },
      -1,
      64,
      1.5,
      SETTLED,
    ];
    const run = await runHelper({
      states: answers,
      widths: [
        { kind: "string", text: hostile },
        { kind: "object", text: hostile },
      ],
      consoleErrors: 10_000,
      pageErrors: 10_000,
      errorText: hostile,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    // Each bad answer counted as "not settled": the helper kept asking until the good one.
    expect(run.seen.stateCalls).toBe(answers.length);
    const report = readReport(run);
    expect(report).toContain("console errors: 10000\n");
    expect(report).toContain("page errors: 10000\n");
    expect(report).toContain("scrollWidth <= innerWidth: unknown");
    const everything = report + run.stdout + run.stderr;
    expect(controlCharacters(everything)).toEqual([]);
    expectNoToken(everything);
    for (const word of ["boom", "end", "red", "del", "Zm9v"])
      expect(everything).not.toContain(word);
    expect(report.split("\n")).toHaveLength(7);
  });

  test("exits 4 with one fixed line when WebKit does not launch, so the caller can try Docker", async () => {
    const run = await runHelper({
      launchError: `browserType.launch: \n╔═══╗\n║ Host system is missing dependencies to run browsers. ║\n╚═══╝ ${TOKEN} \u001b]52;c;Zm9v\u0007`,
    });
    expect(run.exitCode).toBe(4);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain("Host system is missing dependencies");
    expect(controlCharacters(run.stderr)).toEqual([]);
    expect(run.stderr).not.toContain("Zm9v");
    expectNoToken(run.stderr);
  });

  test("waits for Mermaid's own placeholder, which no CSS transition or busy flag shows", () => {
    // `idle`'s test reads a page that still says "Rendering diagram..." as settled.
    expect(fs.readFileSync(HELPER, "utf8")).toContain(JSON.stringify(MERMAID_PENDING_TEXT));
  });
});

describe("the state check that webkit-capture.mjs runs in the browser", () => {
  const source = fs.readFileSync(HELPER, "utf8");
  const match = /const STATE_JS = `([\s\S]*?)`;\n/.exec(source);
  /** Its in-page expression, with the two expressions that verify-xum.sh passes in filled in. */
  function stateOf(html: string, chunkFailed = "false"): unknown {
    expect(match, "STATE_JS is not in the helper").not.toBeNull();
    const expression = (match?.[1] ?? "")
      .replace('${args["chunk-failed-js"]}', chunkFailed)
      .replace('${args["settled-js"]}', "true")
      .replace("${JSON.stringify(MERMAID_PENDING_TEXT)}", JSON.stringify(MERMAID_PENDING_TEXT));
    const window = new Window();
    window.document.body.innerHTML = html;
    return window.eval(expression);
  }
  const dialog = (id: string, title: string) =>
    `<div role="dialog" aria-labelledby="${id}"><h2 id="${id}">${title}</h2></div>`;

  test("sees the startup failures by element, and not the SSH prompt or a transcript's words", () => {
    expect(stateOf('<div class="boot-loader" role="alert"></div>')).toBe(2 | SETTLED);
    expect(stateOf(dialog("t", "Authentication Required"))).toBe(4 | SETTLED);
    expect(stateOf(dialog("t", "SSH Authentication Required"))).toBe(SETTLED);
    expect(stateOf("<p>Authentication Required, Unable to connect to the Xum backend.</p>")).toBe(
      SETTLED
    );
  });

  test("sees content that is still loading by element, and not a transcript's words", () => {
    expect(stateOf('<div class="boot-loader" role="status" aria-busy="true"></div>')).toBe(
      8 | SETTLED
    );
    expect(stateOf(`<div class="mermaid-container"> ${MERMAID_PENDING_TEXT} </div>`)).toBe(
      16 | SETTLED
    );
    expect(stateOf('<div class="mermaid-container"><svg><text>Done</text></svg></div>')).toBe(
      SETTLED
    );
    expect(stateOf(`<p>Loading Xum</p><p>${MERMAID_PENDING_TEXT}</p>`)).toBe(SETTLED);
    // A finished diagram can have a node with the placeholder's own words.
    expect(
      stateOf(
        `<div class="mermaid-container"><svg><text>${MERMAID_PENDING_TEXT}</text></svg></div>`
      )
    ).toBe(SETTLED);
  });

  test("reports a failed chunk only when verify-xum.sh's own check says true", () => {
    expect(stateOf("<p>x</p>", "true")).toBe(1 | SETTLED);
    expect(stateOf("<p>x</p>", '"true"')).toBe(SETTLED);
  });
});

describe("verify-xum.sh webkit-capture NAME", () => {
  /**
   * Runs a copy of the real script in a scratch git repo (the script finds its checkout from its own
   * location). Its argument checks run before it reads a run, so no sandbox is needed: with a valid
   * name it stops at "no run at".
   */
  function runCapture(name: string) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "verify-xum-name-test-"));
    tempDirs.push(repo);
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: repo } });
    expect(git("init", "-q").status).toBe(0);
    // The script refuses a git dir that group or others can write, whatever the caller's umask.
    fs.chmodSync(path.join(repo, ".git"), 0o755);
    const script = path.join(repo, "verify-xum.sh");
    fs.copyFileSync(path.join(SKILL_SCRIPTS, "verify-xum.sh"), script);
    const result = spawnSync("bash", [script, "webkit-capture", "/workspace/x", name], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", HOME: repo, VERIFY_XUM_HOME: path.join(repo, "home") },
      encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr };
  }

  test("refuses a name with no <feature>/ folder, which Docker would mount as all the evidence", () => {
    const result = runCapture("reply");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("<feature>/<step>");
  });

  test("accepts <feature>/<step>, and gets as far as reading the run", () => {
    const result = runCapture("chat/reply");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no run at");
  });
});
