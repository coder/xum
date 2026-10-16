/**
 * Writes src/common/staticWorkspaceView/phoneChrome.generated.ts (T3 #5971, C step 4) from the live
 * workspace page of a built tree.
 *   make generate-phone-chrome | check-phone-chrome [PHONE_CHROME_ARGS="--chrome <path>"]
 * It writes the neutral seed into a temp folder, starts `xum server` on it and opens the seeded
 * workspace in Chrome with Lighthouse's phone emulation (412x823, DPR 1.75, touch). The live DOM
 * becomes a SkeletonNode tree (phoneChrome.ts): ids, a11y and test hooks go, workspace data becomes
 * slots or empty nodes, and the transcript rows become one user and one assistant template.
 * Every width in PHONE_CHROME_WIDTHS.checked must give the same tree, or the script fails.
 * --check compares with the checked-in file instead and exits 1 on drift, naming the first path.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { PHONE_CHROME_JSON } from "../../src/common/staticWorkspaceView/phoneChrome.generated";
import { PHONE_CHROME_WIDTHS } from "../../src/common/staticWorkspaceView/phoneChrome";
import { writeNeutralSeed } from "./neutralSeed";

const OUT = path.join(
  import.meta.dirname,
  "../../src/common/staticWorkspaceView/phoneChrome.generated.ts"
);
const REGENERATE = "make generate-phone-chrome";
/** SkillIndicator's span while the skill list loads (#6221): what the live first frame shows. */
const SKILLS_PLACEHOLDER = ["span", { "aria-hidden": "true", class: "h-6 w-6 shrink-0" }];

async function startServer(root: string, home: string, log: string) {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as net.AddressInfo;
  probe.close();
  const args = `dist/cli/index.js server --no-auth --host 127.0.0.1 --port ${port}`.split(" ");
  const fd = fs.openSync(log, "w");
  const env = { PATH: process.env.PATH, HOME: home, XUM_ROOT: root, XUM_DISABLE_TELEMETRY: "1" };
  const server = spawn("node", args, {
    cwd: path.join(import.meta.dirname, "../.."),
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" },
    detached: true, // its own process group, so the stop also ends the server's children
    stdio: ["ignore", fd, fd],
  });
  const origin = `http://127.0.0.1:${port}`;
  const up = () =>
    fetch(`${origin}/health`).then(
      (r) => r.ok,
      () => false
    );
  const stop = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    process.kill(-server.pid!, "SIGTERM");
    await once(server, "exit");
  };
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) {
    await stop();
    const tail = fs.readFileSync(log, "utf8").slice(-2000); // the temp folder goes next
    throw new Error(`xum server did not start. Its log ends with:\n${tail}`);
  }
  return { origin, stop };
}

/** Runs in the page: the skeleton of the live DOM. Self-contained, Playwright serializes it. */
function capture(placeholder: unknown) {
  type Node = string | { slot: string } | [string, Record<string, string>, ...Node[]];
  const SKIP =
    "[id^=DndDescribedBy],[id^=DndLiveRegion],#review-immersive-root,.mobile-hide-right-sidebar," +
    "input[type=file],.sr-only";
  // Ids, a11y and test hooks go: the copy is inert and must not duplicate live hooks.
  const DROP =
    /^(id|role|tabindex|title|for|name|aria-(?!hidden).*|data-testid|data-message-id|data-tutorial|data-state|data-autofocus-state|data-loaded|autocomplete|spellcheck)$/;
  const children = new Map<Element, Node[]>();
  const swapped = new Map<Element, Node>();
  const MODE_STYLE = /var\(--color-[\w-]*-mode\)/; // the selected agent's color, workspace state
  const one = (selector: string, scope: ParentNode = document) => {
    const found = scope.querySelectorAll(selector);
    if (found.length !== 1)
      throw new Error(`"${selector}" matched ${found.length} elements, not 1`);
    return found[0];
  };
  const slot = (selector: string, kids: Node[], scope?: ParentNode) =>
    children.set(one(selector, scope), kids);
  // Every region that shows workspace or user state is a slot: the page builder fills it.
  slot("[data-testid=workspace-title]", [{ slot: "title" }]);
  slot("[data-testid=notify-on-response-button]", [{ slot: "notify" }]);
  slot('[data-component=ChatInputSurface] button[style*="-mode)"]', [{ slot: "mode" }]);
  slot("[data-component=ModelSelectorGroup]", [{ slot: "model" }]); // model, provider, thinking
  slot("button:has([data-context-usage-percent])", []); // the usage meter
  slot("[data-testid=workspace-footer-bar]", [{ slot: "footer" }]); // runtime, project, git
  swapped.set(one('button[aria-label*="skills loaded"]'), placeholder as Node);
  const log = one("[role=log]");
  const convert = (el: Element): Node => {
    const swap = swapped.get(el);
    if (swap) return swap;
    const tag = el.tagName === "MAIN" ? "div" : el.localName; // one <main>: the boot loader's
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) {
      if (!DROP.test(a.name) && !(a.name === "style" && MODE_STYLE.test(a.value))) {
        attrs[a.name] = a.value;
      }
    }
    const kids: Node[] = children.get(el) ?? [];
    if (!children.has(el)) {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) kids.push(c.textContent!);
        if (c.nodeType !== 1 || (c as Element).matches(SKIP)) continue;
        if (el === log && (c as Element).matches("[data-transcript-message]")) {
          if (!kids.some((k) => typeof k === "object" && "slot" in k)) kids.push({ slot: "rows" });
        } else kids.push(convert(c as Element));
      }
    }
    return [tag, attrs, ...kids];
  };
  const row = (selector: string) => {
    const rows = [...document.querySelectorAll(selector)];
    const el = rows.at(-1)!.closest("[data-transcript-message]")!;
    slot(".markdown-content > div", [{ slot: "md" }], el);
    slot("[data-message-timestamp]", [{ slot: "ts" }], el);
    // The provider icon and the route text belong to the row's model too.
    if (selector.includes("assistant")) slot("[data-model-display]", [{ slot: "model" }], el);
    // The actions depend on the row and the workspace (prompt arrows, no Fork in a scratch one).
    slot("[data-message-meta-actions]", [{ slot: "actions" }], el);
    return convert(el);
  };
  return {
    chrome: convert(document.querySelector("#root")!.firstElementChild!),
    user: row("[data-message-id^=user]"),
    assistant: row("[data-message-id^=assistant]"),
  };
}

async function captureAt(browser: Browser, url: string, width: number) {
  const page = await browser.newPage({
    viewport: { width, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(url);
  // Explicit readiness, never a quiet interval: the chat view's reveal barrier (data-loaded,
  // useChatViewDataReady), the loaded skill list and the agent's color. Other late data (git,
  // usage, settings) sits in slots, and every width is a separate load that must give one tree.
  await page.waitForSelector('[data-testid=message-window][data-loaded="true"] [data-message-id]');
  await page.waitForSelector('button[aria-label*="skills loaded"]');
  // Attached, not visible: a container query hides the picker at 360 px (CSS only, same DOM).
  const agent = '[data-component=ChatInputSurface] button[style*="-mode)"]';
  await page.waitForSelector(agent, { state: "attached" });
  const tree = JSON.stringify(await page.evaluate(capture, SKILLS_PLACEHOLDER));
  await page.close();
  return tree;
}

/** Where two trees first differ: the key path, the tags on the way and both values; or null. */
export function firstDiff(a: unknown, b: unknown, at = "", tags = ""): string | null {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    const show = (v: unknown) => JSON.stringify(v)?.slice(0, 160) ?? "nothing";
    return a === b ? null : `${at} (${tags})\n  checked in: ${show(a)}\n  live page:  ${show(b)}`;
  }
  const tag =
    Array.isArray(a) && typeof a[0] === "string" ? `${tags ? `${tags} > ` : ""}${a[0]}` : tags;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const diff = firstDiff(Reflect.get(a, key), Reflect.get(b, key), `${at}/${key}`, tag);
    if (diff !== null) return diff;
  }
  return null;
}

async function main() {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, chrome: { type: "string" } },
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-chrome-"));
  const trees: string[] = [];
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let browser: Browser | undefined;
  let wider = "";
  try {
    const seed = writeNeutralSeed(path.join(tmp, "seed"));
    server = await startServer(seed.root, seed.home, path.join(tmp, "server.log"));
    const url = `${server.origin}/workspace/${seed.workspaceId}`;
    browser = await chromium.launch({ executablePath: values.chrome });
    for (const width of PHONE_CHROME_WIDTHS.checked)
      trees.push(await captureAt(browser, url, width));
    // One px past the range must not give the phone tree: the live cutoff moved otherwise.
    wider = await captureAt(browser, url, PHONE_CHROME_WIDTHS.max + 1);
  } finally {
    await browser?.close();
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const json = trees[PHONE_CHROME_WIDTHS.checked.indexOf(412)];
  PHONE_CHROME_WIDTHS.checked.forEach((width, i) => {
    const diff = firstDiff(JSON.parse(json), JSON.parse(trees[i]));
    assert(diff === null, `the ${width} px tree differs from the 412 px tree at ${diff}`);
  });
  assert(
    wider !== json,
    `the phone tree also renders at ${PHONE_CHROME_WIDTHS.max + 1} px: widen PHONE_CHROME_WIDTHS`
  );
  const escaped = json.replaceAll("<", "\\u003c"); // safe to embed in a <script> later
  if (values.check) {
    const diff = firstDiff(JSON.parse(PHONE_CHROME_JSON), JSON.parse(json));
    if (diff === null) return console.log("phone chrome skeleton matches the live page");
    console.error(
      `The live phone workspace page drifted from phoneChrome.generated.ts at ${diff}\n` +
        `A UI change moved, added or restyled that element. Regenerate and commit:\n  ${REGENERATE}`
    );
    process.exit(1);
  }
  fs.writeFileSync(
    OUT,
    "// GENERATED by `make generate-phone-chrome` (scripts/perf/generatePhoneChrome.ts). Do not edit.\n" +
      "// `make check-phone-chrome` fails when the live page drifts from it.\n" +
      `export const PHONE_CHROME_JSON = ${JSON.stringify(escaped)};\n`
  );
  console.log(`wrote ${OUT}: ${escaped.length} chars`);
}

if (import.meta.main) await main();
