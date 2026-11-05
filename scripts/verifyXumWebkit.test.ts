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
  /** `page.goto` throws this, as it does when the sandbox is gone. */
  gotoError?: string;
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
              if (options.gotoError) throw new Error(options.gotoError);
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

/** Decodes output that must be valid UTF-8: `controlCharacters` cannot see a raw C1 byte once it is decoded. */
function strictUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

  test("names the step that failed, and none of the error's own text", async () => {
    const run = await runHelper({
      gotoError: `net::ERR_CONNECTION_REFUSED at ${TOKEN} \u001b]52;c;Zm9v\u0007`,
    });
    expect(run.exitCode).toBe(1);
    // Closing the browser works, so the step of the first failure stays the one that is named.
    expect(run.stderr).toContain(
      "failed while trying to open the page (is the sandbox still running?)"
    );
    expect(run.stderr).not.toContain("close the browser");
    expect(run.stderr).not.toContain("ERR_CONNECTION_REFUSED");
    expect(controlCharacters(run.stderr)).toEqual([]);
    expectNoToken(run.stderr);
    expect(fs.readdirSync(run.evidenceDir)).toEqual([]);
  });

  test("reaches the terminal in one place, say(), and nothing else writes to stdout or stderr", () => {
    // fail() goes through say(). Any other way out (console.*, process.stdout.write, fs.writeSync(2, ...))
    // would skip safe(). Comments are dropped first: the header names stdout and stderr.
    const code = fs.readFileSync(HELPER, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const sinks =
      /\bconsole\s*[.[]|\bstd(?:out|err)\b|\bwriteSync\b|\bwriteFileSync\s*\(\s*[12]\b|\/dev\/(?:std|fd)/g;
    const sayBody = /\nfunction say\(message\) \{[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
    expect(sayBody).toContain("process.stderr.write(");
    expect(code.match(sinks)).toEqual(["stderr"]);
  });

  test("say() redacts the token and strips control characters from any text it is given", () => {
    // The helper only passes say() fixed text, so no run of the helper reaches it with hostile input.
    const source = fs.readFileSync(HELPER, "utf8");
    const part =
      /const token = fs\.readFileSync\(0[\s\S]*?\nfunction say\(message\) \{[\s\S]*?\n\}\n/.exec(
        source
      )?.[0];
    expect(part, "say() is not in the helper").toBeDefined();
    // OSC 52 writes the terminal's clipboard.
    const hostile = [
      "boom \u001b]52;c;Zm9v\u0007 \u009b31m del\u007f end",
      `${TOKEN} ${encodeURIComponent(TOKEN)} ${new URLSearchParams({ t: TOKEN }).toString().slice(2)}`,
      "?token=other-secret",
    ].join(" ");
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import * as fs from "node:fs";\n${part}\nsay(${JSON.stringify(hostile)});`,
      ],
      { input: TOKEN, env: { PATH: process.env.PATH ?? "" } }
    );
    const stderr = strictUtf8(result.stderr);
    expect(result.status, stderr).toBe(0);
    expect(stderr).toContain("boom ");
    expect(stderr).toContain("?token=<redacted>");
    expect(controlCharacters(stderr)).toEqual([]);
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expectNoToken(stderr);
    expect(stderr).not.toContain("other-secret");
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

describe("verify-xum.sh webkit-capture arguments", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const C1_CSI = String.fromCharCode(0x9b);
  const scriptSource = fs.readFileSync(path.join(SKILL_SCRIPTS, "verify-xum.sh"), "utf8");

  /** A scratch git repo that holds a copy of the real script (it finds its checkout from its own location). */
  function scratchCheckout(root: string, dirName: string) {
    const repo = path.join(root, dirName);
    fs.mkdirSync(repo);
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: root } });
    expect(git("init", "-q").status).toBe(0);
    // The script refuses a git dir that group or others can write, whatever the caller's umask.
    fs.chmodSync(path.join(repo, ".git"), 0o755);
    const script = path.join(repo, "verify-xum.sh");
    fs.copyFileSync(path.join(SKILL_SCRIPTS, "verify-xum.sh"), script);
    return { repo, script };
  }

  const newRoot = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-xum-args-test-")));
    tempDirs.push(root);
    return root;
  };

  const quoteBytes = (bytes: Uint8Array) =>
    `$'${[...bytes]
      .map((byte) =>
        byte < 0x20 || byte > 0x7e || byte === 0x5c || byte === 0x27
          ? `\\x${byte.toString(16).padStart(2, "0")}`
          : String.fromCharCode(byte)
      )
      .join("")}'`;
  const quote = (value: string) => quoteBytes(Buffer.from(value, "utf8"));

  /**
   * Runs the script's argument checks. They run before it reads a run, so no sandbox is needed:
   * with valid arguments it stops at "no run at".
   */
  function runCapture(...captureArgs: string[]) {
    const root = newRoot();
    const { repo, script } = scratchCheckout(root, "repo");
    const result = spawnSync("bash", [script, "webkit-capture", ...captureArgs], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", HOME: root, VERIFY_XUM_HOME: path.join(root, "home") },
      encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr };
  }

  function runDockerMode(options: {
    checkoutName?: string;
    endpoint?: string;
    playwrightVersion?: string;
  }) {
    const root = newRoot();
    const { repo, script } = scratchCheckout(root, options.checkoutName ?? "repo");
    const home = path.join(root, "home");
    const run = path.join(home, "run1");
    fs.mkdirSync(path.join(run, "evidence"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(run, "tmp"), { mode: 0o700 });
    fs.chmodSync(home, 0o700);
    fs.chmodSync(run, 0o700);
    if (options.playwrightVersion === undefined) {
      fs.symlinkSync(
        path.join(import.meta.dir, "../node_modules"),
        path.join(repo, "node_modules")
      );
    } else {
      // The script asks the checkout's vite for the folder it serves, so the fake keeps that one.
      const playwright = path.join(repo, "node_modules/playwright-core");
      fs.mkdirSync(playwright, { recursive: true });
      fs.symlinkSync(
        path.join(import.meta.dir, "../node_modules/vite"),
        path.join(repo, "node_modules/vite")
      );
      fs.writeFileSync(
        path.join(playwright, "package.json"),
        JSON.stringify({ name: "playwright-core", version: options.playwrightVersion })
      );
    }
    fs.writeFileSync(
      path.join(run, "state.env"),
      [
        ["VERIFY_XUM_RUN_ID", "run1"],
        ["VERIFY_XUM_RUN", run],
        ["VERIFY_XUM_CHECKOUT", repo],
        ["VERIFY_XUM_ROOT", path.join(run, "tmp/root")],
        ["VERIFY_XUM_BACKEND", "http://127.0.0.1:9"],
        ["VERIFY_XUM_URL", "http://127.0.0.1:9"],
        ["VERIFY_XUM_EVIDENCE", path.join(run, "evidence")],
      ]
        .map(([name, value]) => `export ${name}=${quote(value)}`)
        .join("\n")
    );
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(root, "docker-calls");
    const endpoint = quote(options.endpoint ?? "unix:///var/run/docker.sock");
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/bash\necho "$1 $2" >> "${calls}"\nif [ "$1 $2" = "context inspect" ]; then printf %s ${endpoint}; exit 0; fi\nexit 1\n`,
      { mode: 0o755 }
    );
    const result = spawnSync(
      "bash",
      [script, "webkit-capture", "/workspace/x", "chat/reply", run],
      {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: root,
          VERIFY_XUM_HOME: home,
          VERIFY_XUM_WEBKIT: "docker",
        },
      }
    );
    const stderr = strictUtf8(result.stderr);
    const dockerCalls = fs.existsSync(calls)
      ? fs.readFileSync(calls, "utf8").trimEnd().split("\n")
      : [];
    return { status: result.status, stderr, dockerCalls };
  }

  test("refuses a name with no <feature>/ folder, which Docker would mount as all the evidence", () => {
    const result = runCapture("/workspace/x", "reply");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("<feature>/<step>");
  });

  test("accepts <feature>/<step>, and gets as far as reading the run", () => {
    const result = runCapture("/workspace/x", "chat/reply");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no run at");
  });

  test("refuses a path with a control character", () => {
    const result = runCapture(`/workspace/x${ESC}]52;c;Zm9v`, "chat/reply");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PATH must not hold a control character");
    expect(controlCharacters(result.stderr)).toEqual([]);
  });

  test("refuses a path with a lone raw 0x9B byte, which a terminal outside UTF-8 mode reads as CSI", () => {
    const root = newRoot();
    const { repo, script } = scratchCheckout(root, "repo");
    // The byte cannot go through a JS string argument, which node encodes as UTF-8: bash builds it.
    const result = spawnSync(
      "bash",
      ["-c", String.raw`exec bash "$0" webkit-capture $'/workspace/x\x9b' chat/reply`, script],
      {
        cwd: repo,
        env: { PATH: process.env.PATH ?? "", HOME: root, VERIFY_XUM_HOME: path.join(root, "home") },
      }
    );
    const stderr = strictUtf8(result.stderr);
    expect(result.status, stderr).toBe(1);
    expect(stderr).toContain("PATH must not hold a control character");
  });

  describe("has_control_char", () => {
    const body = /^has_control_char\(\) \{[^\n]*\n[\s\S]*?\n\}$/m.exec(scriptSource)?.[0];
    const refuses = (...bytes: number[]) => {
      expect(body, "has_control_char is not in verify-xum.sh").toBeDefined();
      const result = spawnSync("bash", [
        "-c",
        `${body}\nhas_control_char ${quoteBytes(Buffer.from([0x2f, ...bytes, 0x78]))}`,
      ]);
      expect(result.status, strictUtf8(result.stderr)).toBeOneOf([0, 1]);
      return result.status === 0;
    };

    test.each([
      ["a lone raw 0x9B", [0x9b]],
      ["a lone raw 0x90 (DCS)", [0x90]],
      ["a lone raw 0x9D (OSC)", [0x9d]],
      ["a raw 0x9B after a complete two-byte character", [0xc3, 0xa9, 0x9b]],
      [
        "a raw 0x9B after the start of a three-byte character that another character cut short",
        [0xe2, 0xc3, 0x9b, 0x82, 0x9b],
      ],
      ["a C1 CSI encoded in UTF-8", [0xc2, 0x9b]],
      ["ESC", [0x1b]],
      ["DEL", [0x7f]],
    ])("refuses %s", (_label, bytes) => {
      expect(refuses(...bytes)).toBe(true);
    });

    test.each([
      ["a two-byte character whose second byte is 0x9B", [0xc3, 0x9b]],
      ["a three-byte character whose last byte is 0x9B", [0xe2, 0x82, 0x9b]],
      ["a four-byte character whose last byte is 0x9B", [0xf0, 0x9f, 0x98, 0x9b]],
      ["a lone raw 0xA0, which is no control character", [0xa0]],
      ["plain ASCII", [0x61]],
    ])("accepts %s", (_label, bytes) => {
      expect(refuses(...bytes)).toBe(false);
    });
  });

  test.each([
    ["ESC", ESC],
    ["a C1 CSI", C1_CSI],
  ])(
    "does not hand Docker a checkout path with %s in it, and prints no such path",
    (_label, control) => {
      const result = runDockerMode({ checkoutName: `repo${control}x` });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("has a control character in its path");
      expect(controlCharacters(result.stderr)).toEqual([]);
      expect(result.dockerCalls).toEqual([]);
    }
  );

  test.each([
    ["a local socket with ESC", `unix:///var/run/docker.sock${ESC}]52;c;Zm9v${BEL}`],
    ["a remote host with ESC", `tcp://docker.example:2375${ESC}]52;c;Zm9v${BEL}`],
    ["a local socket with a C1 CSI", `unix:///var/run/docker.sock${C1_CSI}31m`],
  ])("prints no control character of a Docker endpoint that is %s", (_label, endpoint) => {
    const result = runDockerMode({ endpoint });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("the Docker endpoint has a control character");
    expect(controlCharacters(result.stderr)).toEqual([]);
    expect(result.stderr).not.toContain("Zm9v");
    expect(result.dockerCalls).toEqual(["context inspect"]);
  });

  test("names the playwright-core version of node_modules when it is not the image's", () => {
    const result = runDockerMode({ playwrightVersion: "1.0.0" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("node_modules holds playwright-core 1.0.0,");
  });

  test("prints no control character of that version", () => {
    const result = runDockerMode({ playwrightVersion: `1.0.0${ESC}]52;c;Zm9v${BEL}` });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "node_modules holds playwright-core a version with a control character"
    );
    expect(controlCharacters(result.stderr)).toEqual([]);
    expect(result.stderr).not.toContain("Zm9v");
    expect(result.dockerCalls).toEqual(["context inspect"]);
  });
});
