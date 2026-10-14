/**
 * First-run view parity (T3 #5971, Option C step 2, plan section 5.6: PR 3b, gate 8 of PR 4b).
 *   make first-run-view-parity FIRST_RUN_VIEW_PARITY_ARGS="--tree <built tree> [--out <dir>] [--chrome <path>]"
 * Serves the tree's `xum server` on a fresh empty root (the first-run state) and opens "/" in a real
 * Chrome at 390, 744, 1200 and 1900 px, in the light and the dark system theme. Each run holds the
 * app's main chunk, so the static view (#xum-pre) stays alone on screen, measures it, releases the
 * chunk and measures the live wizard's first frame after the handoff.
 * Rule: the static "OSS contributors..." paragraph is within 2 px of the live one in x, y, width and
 * height, and the static phase has exactly one <main>. Shell check (PR 4b's precondition, owner
 * decision 10-14): outside the dialog box and a 4 px margin, no pixel of the static phase's
 * screenshot differs from the live first frame's by more than 16 in a color channel.
 * Until PR 4b serves the view, the served "/" has no #xum-pre: the tool then inserts #6444's
 * FIRST_RUN_VIEW_HTML before </body> of the served "/" by hand (Playwright route), as a test page.
 * Exit: 0 every run passes, 1 a run fails the rule, 2 bad input, 3 an invalid run.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import { FIRST_RUN_VIEW_HTML } from "@/node/orpc/firstRunView";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The served "/" with the static view inserted once, before </body>: outside #root, which React clears. */
export function withFirstRunView(html: string, markup: string): string {
  const parts = html.split("</body>");
  if (parts.length !== 2) throw new Error("the served / needs exactly one </body>");
  return `${parts[0]}${markup}\n</body>${parts[1]}`;
}

/** Gate 8's rule for one run: every failure, or none. */
export function parityFailures(staticBox: Box, liveBox: Box, staticMains: number): string[] {
  const failures = (["x", "y", "width", "height"] as const)
    .map((key) => ({ key, off: Math.abs(staticBox[key] - liveBox[key]) }))
    .filter(({ off }) => off > 2)
    .map(({ key, off }) => `${key} off by ${Math.round(off * 10) / 10} px`);
  if (staticMains !== 1) failures.push(`${staticMains} main landmarks in the static phase`);
  return failures;
}

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

/** The shell check: pixels outside the dialog (CSS px box, 4 px margin) off by more than 16. */
export function shellDiff(a: RawImage, b: RawImage, dialog: Box, scale: number) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw new Error("the static and live screenshots differ in size");
  }
  const [left, top] = [(dialog.x - 4) * scale, (dialog.y - 4) * scale];
  const [right, bottom] = [left + (dialog.width + 8) * scale, top + (dialog.height + 8) * scale];
  let pixels = 0;
  const hit = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (x >= left && x < right && y >= top && y < bottom) continue;
      const i = (y * a.width + x) * a.channels;
      const off = Math.max(...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b.data[i + c])));
      if (off <= 16) continue;
      pixels++;
      Object.assign(hit, {
        x0: Math.min(hit.x0, x),
        y0: Math.min(hit.y0, y),
        x1: Math.max(hit.x1, x),
        y1: Math.max(hit.y1, y),
      });
    }
  }
  const [x, y, width, height] = [hit.x0, hit.y0, hit.x1 + 1 - hit.x0, hit.y1 + 1 - hit.y0];
  const bbox = pixels
    ? { x: x / scale, y: y / scale, width: width / scale, height: height / scale }
    : null;
  return { pixels, bbox };
}

const raw = async (png: Buffer): Promise<RawImage> => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};

const WIDTHS = [
  { width: 390, height: 844, phone: true },
  { width: 744, height: 1133, phone: true },
  { width: 1200, height: 800, phone: false },
  { width: 1900, height: 1000, phone: false },
];
const THEMES = ["light", "dark"] as const;
const TEXT = "OSS contributors with GitHub accounts";

async function startServer(tree: string, root: string, logFile: string) {
  const probePort = net.createServer().listen(0, "127.0.0.1");
  await once(probePort, "listening");
  const { port } = probePort.address() as net.AddressInfo;
  probePort.close();
  const log = fs.openSync(logFile, "w");
  const env = { PATH: process.env.PATH, HOME: root, XUM_ROOT: root, XUM_DISABLE_TELEMETRY: "1" };
  const args = `dist/cli/index.js server --no-auth --host 127.0.0.1 --port ${port}`.split(" ");
  const server = spawn("node", args, {
    cwd: tree,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" },
    detached: true,
    stdio: ["ignore", log, log],
  });
  const origin = `http://127.0.0.1:${port}`;
  const up = () =>
    fetch(`${origin}/health`)
      .then((r) => r.ok)
      .catch(() => false);
  for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  const stop = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      process.kill(-server.pid!, "SIGTERM");
      await once(server, "exit");
    }
    fs.closeSync(log);
  };
  if (!(await up())) {
    await stop();
    throw new Error(`the server did not start, see ${logFile}`);
  }
  return { origin, stop };
}

/** The box of the first `selector` match starting with `text`, in the static view or outside it. */
function boxOf(page: Page, inStatic: boolean, selector = "p", text = TEXT) {
  return page.evaluate(
    ([id, sel, prefix, wantStatic]) => {
      const p = [...document.querySelectorAll(sel)].find(
        (e) => e.textContent?.startsWith(prefix) && !!e.closest(`#${id}`) === wantStatic
      );
      const r = p?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    },
    [FIRST_RUN_VIEW_ID, selector, text, inStatic] as const
  );
}

async function main(): Promise<number> {
  const { values: a } = parseArgs({
    options: {
      tree: { type: "string" },
      out: { type: "string" },
      chrome: { type: "string", default: "/usr/bin/google-chrome" },
    },
  });
  if (!a.tree || !fs.existsSync(path.join(a.tree, "dist/cli/index.js"))) {
    console.error("--tree must be a built checkout (see the header of this file)");
    return 2;
  }
  const out = path.resolve(a.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "parity-out-")));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-root-"));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let browser: Browser | undefined;
  const results = [];
  let injected = false;
  try {
    server = await startServer(path.resolve(a.tree), root, path.join(out, "server.log"));
    const { origin } = server;
    // A route-fulfilled document has no local address space, so Local Network Access would block the
    // app's WebSocket to 127.0.0.1. pageTiming.ts navigates without fulfill and needs no such flag.
    browser = await chromium.launch({
      executablePath: a.chrome,
      headless: true,
      args: ["--disable-features=LocalNetworkAccessChecks"],
    });
    for (const size of WIDTHS) {
      for (const theme of THEMES) {
        const name = `${size.width}-${theme}`;
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          colorScheme: theme,
          ...(size.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
        });
        const page = await context.newPage();
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        await page.route(`${origin}/`, async (route) => {
          const response = await route.fetch();
          const html = await response.text();
          injected ||= !html.includes(`id="${FIRST_RUN_VIEW_ID}"`);
          const body = html.includes(`id="${FIRST_RUN_VIEW_ID}"`)
            ? html
            : withFirstRunView(html, FIRST_RUN_VIEW_HTML);
          await route.fulfill({ status: response.status(), contentType: "text/html", body });
        });
        await page.route(/\/main-[^/]+\.js$/, async (route) => {
          await held;
          await route.continue();
        });
        await page.goto(`${origin}/`, { waitUntil: "commit" });
        // Measure the painted static view: stylesheets applied (a stylesheet that never loads is an
        // invalid run after 60 s), then the fonts that layout asked for.
        const sheets = "link[rel=stylesheet]";
        await page.waitForFunction(
          (selector) =>
            [...document.querySelectorAll<HTMLLinkElement>(selector)].every((l) => l.sheet),
          sheets,
          { timeout: 60_000 }
        );
        // (No named inner functions: tsx's keepNames would wrap them in __name, which the page lacks.)
        await page.evaluate(async () => {
          void document.body.offsetHeight; // layout now, so the fonts it needs start loading
          await document.fonts.ready;
          for (let i = 0; i < 2; i++)
            await new Promise((resolve) => requestAnimationFrame(resolve));
        });
        const staticBox = await boxOf(page, true);
        const staticDialog = await boxOf(page, true, "[role=dialog]", "");
        if (!staticBox) throw new Error(`${name}: the static view shows no target paragraph`);
        const staticMains = await page.evaluate(() => document.querySelectorAll("main").length);
        const staticShot = await page.screenshot({
          path: path.join(out, `static-${name}.png`),
          fullPage: true,
        });
        release();
        const handle = await page.waitForFunction(
          ([id, text]) => {
            if (document.getElementById(id)) return null;
            const p = [...document.querySelectorAll("p")].find((e) =>
              e.textContent?.startsWith(text)
            );
            const r = p?.getBoundingClientRect();
            return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
          },
          [FIRST_RUN_VIEW_ID, TEXT] as const,
          { polling: "raf", timeout: 120_000 }
        );
        const liveBox = (await handle.jsonValue())!;
        const liveShot = await page.screenshot({
          path: path.join(out, `live-${name}.png`),
          fullPage: true,
        });
        const liveDialog = await boxOf(page, false, "[role=dialog]", "");
        if (!staticDialog || !liveDialog) throw new Error(`${name}: a phase shows no dialog`);
        const [x, y] = [
          Math.min(staticDialog.x, liveDialog.x),
          Math.min(staticDialog.y, liveDialog.y),
        ];
        const dialog = {
          x,
          y,
          width: Math.max(staticDialog.x + staticDialog.width, liveDialog.x + liveDialog.width) - x,
          height:
            Math.max(staticDialog.y + staticDialog.height, liveDialog.y + liveDialog.height) - y,
        };
        const [a, b] = [await raw(staticShot), await raw(liveShot)];
        const shell = shellDiff(a, b, dialog, a.width / size.width);
        const failures = parityFailures(staticBox, liveBox, staticMains);
        if (shell.pixels > 0) {
          const at = Object.values(shell.bbox!).map((v) => Math.round(v));
          failures.push(
            `shell: ${shell.pixels} pixels off by more than 16 at x,y,w,h ${at.join(",")}`
          );
        }
        results.push({ name, staticBox, liveBox, staticMains, dialog, shell, failures });
        console.log(`${name}: ${failures.length ? failures.join(", ") : "pass"}`);
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await server?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const report = { tree: path.resolve(a.tree), injected, results };
  fs.writeFileSync(path.join(out, "parity.json"), JSON.stringify(report, null, 2));
  console.log(`${injected ? "test page (constant inserted by hand)" : "served view"}: ${out}`);
  return results.every((r) => r.failures.length === 0) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(String((error as { code?: unknown }).code).startsWith("ERR_PARSE_ARGS") ? 2 : 3);
    }
  );
}
