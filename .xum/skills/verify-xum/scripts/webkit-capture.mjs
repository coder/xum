// Opens one page of a verify-xum run in Playwright WebKit at a phone viewport and writes a
// screenshot and a short report. Run by `verify-xum.sh webkit-capture` (see ../SKILL.md), on the
// host or in the pinned Playwright image. Playwright talks to WebKit over a pipe, so no DevTools port
// listens (under WSL it opens one).
//
// The backend's auth token arrives on stdin, never in argv or the environment, and every message
// this process prints or writes is redacted with the same rules as `redact_token` in
// verify-xum.sh. A container's stdout and stderr land in the Docker daemon's log, so the redaction
// cannot wait for the caller.
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
const STEP_TIMEOUT_MS = 60_000;
const MAX_PROBLEM_LINES = 20;
// States that `idle`'s test reads as settled. Loading: the boot screen (index.html and
// LoadingScreen, aria-busy) and Mermaid's pending frame, which has no transition and no busy flag.
// Failed: AppLoader's startup connection error and the token prompt, which show instead of the
// requested page. They are matched by element, not by text anywhere on the page: a transcript can
// quote any of these words. scripts/verifyXumWebkit.test.ts checks that Mermaid's text is current.
const MERMAID_PENDING_TEXT = "Rendering diagram...";
const STILL_LOADING_JS = `(() => {
  const loading = [];
  if (document.querySelector('.boot-loader[aria-busy="true"]')) loading.push("the loading screen");
  const pending = [...document.querySelectorAll(".mermaid-container")].some(
    (frame) => frame.textContent.trim() === ${JSON.stringify(MERMAID_PENDING_TEXT)}
  );
  if (pending) loading.push("a Mermaid diagram that is still rendering");
  return loading;
})()`;
const STARTUP_FAILED_JS = `(() => {
  const failed = [];
  if (document.querySelector('.boot-loader[role="alert"]')) failed.push("the startup connection error");
  const prompt = [...document.querySelectorAll('[role="dialog"]')].some((dialog) =>
    dialog.textContent.includes("Authentication Required")
  );
  if (prompt) failed.push("the authentication prompt");
  return failed;
})()`;

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
  },
  strict: true,
});
for (const name of ["checkout", "base", "path", "out", "mode", "settled-js", "chunk-failed-js"]) {
  if (!args[name]) throw new Error(`missing --${name}`);
}
// The report goes next to the screenshot: a name that does not end in .png would overwrite it.
if (!args.out.endsWith(".png")) throw new Error("--out must end in .png");

const token = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
const tokenForms = [
  ...new Set([
    token,
    encodeURIComponent(token),
    new URLSearchParams({ t: token }).toString().slice(2),
  ]),
].filter(Boolean);

function redact(text) {
  let clean = String(text);
  for (const form of tokenForms) clean = clean.split(form).join("<redacted>");
  return clean.replace(/([?&]token=)[^&#\s"'<>]+/g, "$1<redacted>");
}

function fail(message, code = 1) {
  process.stderr.write(`webkit-capture: ${redact(message)}\n`);
  process.exit(code);
}

process.on("uncaughtException", (error) => fail(error.stack ?? String(error)));
process.on("unhandledRejection", (error) =>
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
);
// The watchdog also ends a container whose caller was killed: nothing else stops it.
setTimeout(() => fail(`no result after ${WATCHDOG_MS / 1000} s`), WATCHDOG_MS);

const require = createRequire(path.join(args.checkout, "package.json"));
const { webkit } = require("playwright-core");
const playwrightVersion = require("playwright-core/package.json").version;

// Playwright's launch failure for missing host libraries is a boxed, multi-line table.
function oneLine(text, max = 200) {
  return redact(text)
    .replace(/[╔╗╚╝║═]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

let browser;
try {
  browser = await webkit.launch();
} catch (error) {
  fail(oneLine(error instanceof Error ? error.message : String(error)), EXIT_NO_WEBKIT);
}

let exitCode = 0;
try {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));

  const url = new URL(args.path, args.base);
  if (token) url.searchParams.set("token", token);
  await page.goto(url.href, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
  const settled = await page
    .waitForFunction(
      `(${args["chunk-failed-js"]}) || ${STARTUP_FAILED_JS}.length > 0 || ((${args["settled-js"]}) && ${STILL_LOADING_JS}.length === 0)`,
      undefined,
      { timeout: STEP_TIMEOUT_MS }
    )
    .then(
      () => true,
      (error) => {
        if (error?.name !== "TimeoutError") throw error;
        return false;
      }
    );
  const startupFailed = settled ? await page.evaluate(STARTUP_FAILED_JS) : [];
  if (!settled) {
    const loading = await page.evaluate(STILL_LOADING_JS);
    process.stderr.write(
      `webkit-capture: the page did not settle in ${STEP_TIMEOUT_MS / 1000} s${
        loading.length > 0 ? `: it still shows ${loading.join(" and ")}` : ""
      }.\n`
    );
    exitCode = 1;
  } else if ((await page.evaluate(args["chunk-failed-js"])) === true) {
    process.stderr.write(
      "webkit-capture: the page shows '<name> failed to load.': a module fetch from Vite failed. Run the command again.\n"
    );
    exitCode = EXIT_CHUNK_FAILED;
  } else if (startupFailed.length > 0) {
    process.stderr.write(`webkit-capture: the page shows ${startupFailed.join(" and ")}.\n`);
    exitCode = 1;
  } else {
    const widths = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    await page.screenshot({ path: args.out });

    const fits = widths.scrollWidth <= widths.innerWidth;
    const lines = [
      `url: ${page.url()}`,
      `engine: WebKit ${browser.version()}, playwright-core ${playwrightVersion}, ${args.mode}`,
      `viewport: ${JSON.stringify(PHONE)}`,
      `document.documentElement.scrollWidth <= innerWidth: ${fits} (${widths.scrollWidth} <= ${widths.innerWidth})`,
      `console and page errors: ${problems.length}`,
      ...problems.slice(0, MAX_PROBLEM_LINES).map((problem) => oneLine(problem)),
    ];
    if (problems.length > MAX_PROBLEM_LINES) {
      lines.push(`... ${problems.length - MAX_PROBLEM_LINES} more`);
    }
    fs.writeFileSync(args.out.replace(/\.png$/, ".txt"), `${redact(lines.join("\n"))}\n`);
  }
} finally {
  await browser.close();
}
process.exit(exitCode);
