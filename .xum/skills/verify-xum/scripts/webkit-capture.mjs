// Opens one page of a verify-xum run in Playwright WebKit at a phone viewport and writes a
// screenshot and a short report. Run by `verify-xum.sh webkit-capture` (see ../SKILL.md), on the
// host or in the pinned Playwright image. Playwright talks to WebKit over a pipe, so no DevTools
// port listens (only its `webkit-wsl` channel opens one, which this helper never selects).
//
// The page under test is untrusted: it can be a hostile branch, and what this process prints lands
// in a terminal and a transcript. So nothing the page controls is read back as text. The checks
// that wait for the page return one small integer from the page, and node checks its type. The
// report holds fixed text and numbers: the URL verify-xum built, the engine, the viewport, the
// page width and two counts. Every message is a fixed string chosen here. The PNG is the evidence.
// A hostile page can still make these numbers lie, as it can change what it paints.
//
// The backend's auth token arrives on stdin, never in argv or the environment. Redaction of the
// token and the replacement of control characters still run over everything this process prints or
// writes, as a second layer: a container's stdout and stderr land in the Docker daemon's log.
//
// Exit codes: 0 captured. 1 failed. 3 the page shows "<name> failed to load." (as `idle`).
// 4 WebKit did not launch here: the caller tries the next mode.
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const EXIT_CHUNK_FAILED = 3;
const EXIT_NO_WEBKIT = 4;
const WATCHDOG_MS = 180_000;
const DEFAULT_SETTLE_MS = 60_000;
const NAVIGATE_MS = 60_000;
const POLL_MS = 100;

// The page's state is one integer of these bits. Settled, loading and failed are what `idle`'s
// test cannot tell apart: it reads the boot screen and a Mermaid diagram that is still rendering as
// settled, and the startup error and the token prompt as a page. They are matched by element, not
// by text anywhere on the page: a transcript can quote any of these words.
// scripts/verifyXumWebkit.test.ts runs this expression and checks that Mermaid's text is current.
const STATE = {
  chunkFailed: 1,
  connectionError: 2,
  authPrompt: 4,
  loadingScreen: 8,
  mermaidPending: 16,
  settled: 32,
};
const STATE_LIMIT = 64;
const MERMAID_PENDING_TEXT = "Rendering diagram...";

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const { values: args } = parseArgs({
  options: {
    checkout: { type: "string" },
    base: { type: "string" },
    path: { type: "string" },
    out: { type: "string" },
    mode: { type: "string" },
    "settled-js": { type: "string" },
    "chunk-failed-js": { type: "string" },
    "settle-ms": { type: "string" },
  },
  strict: true,
});
for (const name of ["checkout", "base", "path", "out", "mode", "settled-js", "chunk-failed-js"]) {
  if (!args[name]) throw new Error(`missing --${name}`);
}
const settleMs = args["settle-ms"] === undefined ? DEFAULT_SETTLE_MS : Number(args["settle-ms"]);
if (!Number.isInteger(settleMs) || settleMs <= 0)
  throw new Error("--settle-ms must be a positive integer");
// The report goes next to the screenshot: a name that does not end in .png would overwrite it.
if (!args.out.endsWith(".png")) throw new Error("--out must end in .png");

const STATE_JS = `(() => {
  let state = 0;
  if ((${args["chunk-failed-js"]}) === true) state |= 1;
  if (document.querySelector('.boot-loader[role="alert"]')) state |= 2;
  // Exact, through aria-labelledby: SshPromptDialog's "SSH Authentication Required" is another dialog.
  const prompt = [...document.querySelectorAll('[role="dialog"]')].some(
    (dialog) =>
      document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent.trim() ===
      "Authentication Required"
  );
  if (prompt) state |= 4;
  if (document.querySelector('.boot-loader[aria-busy="true"]')) state |= 8;
  const pending = [...document.querySelectorAll(".mermaid-container")].some(
    (frame) =>
      frame.querySelector("svg") === null &&
      frame.textContent.trim() === ${JSON.stringify(MERMAID_PENDING_TEXT)}
  );
  if (pending) state |= 16;
  if ((${args["settled-js"]}) === true) state |= 32;
  return state;
})()`;

const outputs = [args.out, args.out.replace(/\.png$/, ".txt")];
const staged = (file) => `${file}.tmp`;
// Both files are written under staged names and renamed together once everything has worked. Any
// earlier exit removes them, so a failed run never leaves a file that reads as its result.
let committed = false;
process.on("exit", () => {
  if (committed) return;
  for (const file of outputs) {
    fs.rmSync(file, { force: true });
    fs.rmSync(staged(file), { force: true });
  }
});

const token = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
const tokenForms = [
  ...new Set([
    token,
    encodeURIComponent(token),
    new URLSearchParams({ t: token }).toString().slice(2),
  ]),
].filter(Boolean);

// A control character (ESC and BEL start terminal escape sequences, such as an OSC 52 clipboard
// write) becomes a space: C0, DEL and C1. A loop, not a regex: lint bans control characters there.
function plain(text) {
  return Array.from(String(text), (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }).join("");
}

function redact(text) {
  let clean = String(text);
  for (const form of tokenForms) clean = clean.split(form).join("<redacted>");
  return clean.replace(/([?&]token=)[^&#\s"'<>]+/g, "$1<redacted>");
}

const safe = (text) => plain(redact(text));

// The one place that writes to stderr, so every message goes through redaction and control stripping.
function say(message) {
  process.stderr.write(`webkit-capture: ${safe(message)}\n`);
}

function fail(message, code = 1) {
  say(message);
  process.exit(code);
}

// An unexpected error can carry text from the page (Playwright copies a page's exception into its
// own), so only the step is named.
let step = "start";
const failAtStep = () => fail(`failed while trying to ${step}. Run the command again.`);
process.on("uncaughtException", failAtStep);
process.on("unhandledRejection", failAtStep);
// The watchdog also ends a container whose caller was killed: nothing else stops it.
setTimeout(
  () => fail(`no result after ${WATCHDOG_MS / 1000} s, while trying to ${step}`),
  WATCHDOG_MS
);

const require = createRequire(path.join(args.checkout, "package.json"));
const { webkit } = require("playwright-core");
const playwrightVersion = require("playwright-core/package.json").version;

// What the page returned for STATE_JS, or undefined when it is not an integer in range: the page
// is then treated as not settled.
function readState(value) {
  const ok =
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value < STATE_LIMIT;
  return ok ? value : undefined;
}

// Playwright's launch failure is a long table. Only its kind is passed on, as a fixed string.
function launchProblem(error) {
  const text = typeof error?.message === "string" ? error.message : "";
  if (text.includes("Host system is missing dependencies")) {
    return "WebKit cannot start here: Host system is missing dependencies to run browsers.";
  }
  if (text.includes("Executable doesn't exist")) {
    return "WebKit's browser is not installed here: Executable doesn't exist.";
  }
  return "WebKit did not launch, for a reason this helper does not know.";
}

step = "launch WebKit";
let browser;
try {
  browser = await webkit.launch();
} catch (error) {
  fail(launchProblem(error), EXIT_NO_WEBKIT);
}

let exitCode = 0;
try {
  step = "open a browser page";
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  let consoleErrors = 0;
  let pageErrors = 0;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors += 1;
  });
  page.on("pageerror", () => {
    pageErrors += 1;
  });

  step = "open the page (is the sandbox still running?)";
  const inputUrl = new URL(args.path, args.base);
  const openUrl = new URL(inputUrl);
  if (token) openUrl.searchParams.set("token", token);
  await page.goto(openUrl.href, { waitUntil: "load", timeout: NAVIGATE_MS });

  step = "wait for the page";
  const deadline = Date.now() + settleMs;
  let state;
  for (;;) {
    state = await page.evaluate(STATE_JS).then(readState, () => undefined);
    const failed =
      state !== undefined &&
      (state & (STATE.chunkFailed | STATE.connectionError | STATE.authPrompt)) !== 0;
    const loading =
      state === undefined || (state & (STATE.loadingScreen | STATE.mermaidPending)) !== 0;
    if (failed || (state !== undefined && (state & STATE.settled) !== 0 && !loading)) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const has = (bit) => state !== undefined && (state & bit) !== 0;
  if (has(STATE.chunkFailed)) {
    say(
      "the page shows '<name> failed to load.' or 'Xum could not load': a module fetch from Vite failed. Run the command again."
    );
    exitCode = EXIT_CHUNK_FAILED;
  } else if (has(STATE.connectionError) || has(STATE.authPrompt)) {
    const shown = has(STATE.connectionError)
      ? "the startup connection error"
      : "the authentication prompt";
    say(`the page shows ${shown}.`);
    exitCode = 1;
  } else if (!has(STATE.settled) || has(STATE.loadingScreen) || has(STATE.mermaidPending)) {
    const still = [];
    if (has(STATE.loadingScreen)) still.push("the loading screen");
    if (has(STATE.mermaidPending)) still.push("a Mermaid diagram that is still rendering");
    const detail = still.length > 0 ? `: it still shows ${still.join(" and ")}` : "";
    say(`the page did not settle in ${settleMs / 1000} s${detail}.`);
    exitCode = 1;
  } else {
    step = "read the page width";
    const widths = await page
      .evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
      .catch(() => undefined);
    const numbers =
      Array.isArray(widths) &&
      widths.length === 2 &&
      widths.every((n) => typeof n === "number" && Number.isFinite(n));
    const widthLine = numbers
      ? `document.documentElement.scrollWidth <= innerWidth: ${widths[0] <= widths[1]} (${widths[0]} <= ${widths[1]})`
      : "document.documentElement.scrollWidth <= innerWidth: unknown (the page did not return two numbers)";

    step = "take the screenshot";
    await page.screenshot({ path: staged(outputs[0]), type: "png" });

    step = "write the report";
    const lines = [
      `url: ${inputUrl.href}`,
      `engine: WebKit ${browser.version()}, playwright-core ${playwrightVersion}, ${args.mode}`,
      `viewport: ${JSON.stringify(PHONE)}`,
      widthLine,
      `console errors: ${consoleErrors}`,
      `page errors: ${pageErrors}`,
    ];
    fs.writeFileSync(staged(outputs[1]), `${lines.map(safe).join("\n")}\n`);
  }
} finally {
  // An error on its way out of the try block is reported with its own step, unless closing fails too.
  const stepBeforeClose = step;
  step = "close the browser";
  await browser.close();
  step = stepBeforeClose;
}
if (exitCode === 0) {
  for (const file of outputs) fs.renameSync(staged(file), file);
  committed = true;
}
process.exit(exitCode);
