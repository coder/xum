#!/usr/bin/env bun

/**
 * Browser-mode workspace-switch tear repro.
 *
 * Why this exists:
 * - The remaining artifact was reported in the web/dev-server path, not Electron.
 * - The visible tear can show up either as a transcript shift or as the composer briefly
 *   disappearing while the target workspace opens.
 *
 * What it does:
 * 1. Boots an isolated `make dev-server` instance with a temporary MUX_ROOT.
 * 2. Creates two real workspaces in the browser app and sends live mock-chat turns.
 * 3. Replays both seen->seen switches and reload->unseen switches while sampling layout.
 * 4. Exits with code 1 when the target transcript shifts after it is visible or when the
 *    composer disappears during a workspace open.
 */
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { chromium, type Page } from "playwright";
import sharp from "sharp";

import { prepareDemoProject } from "../tests/e2e/utils/demoProject";

interface SwitchFrameSample {
  frame: number;
  timestamp: number;
  containsTargetMarker: boolean;
  containsSourceMarker: boolean;
  messageWindowTop: number | null;
  messageWindowHeight: number | null;
  scrollTop: number | null;
  chatInputHeight: number | null;
  imagePath: string;
  png: Buffer;
}

interface OpenTransitionFrameSample {
  frame: number;
  timestamp: number;
  hasInput: boolean;
  chatInputHeight: number | null;
  hasMessageWindow: boolean;
  messageWindowHeight: number | null;
  containsTargetMarker: boolean;
  loadingWorkspace: boolean;
  loadingTranscript: boolean;
}

function buildMarker(label: string): string {
  return `[[workspace-switch-tear:${label}]]`;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve free port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.unref();
  });
}

async function waitForHttpReady(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok || response.status === 404) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function readTrunkBranch(projectPath: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: projectPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to detect trunk branch: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

async function createWorkspaceViaOrpc(args: {
  page: Page;
  projectPath: string;
  branchName: string;
  trunkBranch: string;
}): Promise<{ workspaceId: string }> {
  return await args.page.evaluate(
    async ({ projectPath, branchName, trunkBranch }) => {
      const client = window.__ORPC_CLIENT__;
      if (!client) throw new Error("ORPC client not initialized");
      await client.projects.setTrust({ projectPath, trusted: true });
      const createResult = await client.workspace.create({ projectPath, branchName, trunkBranch });
      if (!createResult.success) throw new Error(createResult.error);
      return { workspaceId: createResult.metadata.id };
    },
    {
      projectPath: args.projectPath,
      branchName: args.branchName,
      trunkBranch: args.trunkBranch,
    }
  );
}

async function waitForProjectPage(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__ORPC_CLIENT__), { timeout: 60_000 });
  await page.waitForSelector("[data-project-path]", { timeout: 60_000 });

  // Browser dev-server boots onto the project page with a first-launch provider walkthrough.
  // Close it so workspace-row clicks are not intercepted during the repro.
  for (const label of ["Close", "Skip"] as const) {
    const button = page.getByRole("button", { name: label }).last();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      break;
    }
  }
}

async function ensureProjectExpanded(page: Page): Promise<void> {
  const projectRow = page.locator("[data-project-path]").first();
  await projectRow.waitFor({ state: "visible", timeout: 60_000 });
  const expandButton = projectRow.locator('[aria-label*="Expand project"]');
  if (await expandButton.isVisible().catch(() => false)) {
    await expandButton.click();
  }
}

async function openWorkspace(
  page: Page,
  workspaceId: string,
  expectedMarker: string
): Promise<void> {
  const row = page.locator(`[data-workspace-id="${workspaceId}"][data-workspace-path]`);
  await row.waitFor({ state: "visible", timeout: 60_000 });
  await row.scrollIntoViewIfNeeded();
  await row.dispatchEvent("click");
  if (expectedMarker.length > 0) {
    await page.waitForFunction(
      (marker: string) => document.body.textContent?.includes(marker) ?? false,
      expectedMarker,
      { timeout: 60_000 }
    );
  }
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByRole("textbox", {
    name: /Message Claude|Edit your last message/,
  });
  await input.waitFor({ state: "visible", timeout: 60_000 });
  await input.fill(text);
  await page.keyboard.press("Enter");
}

// Wait for the completed assistant row, not just the first visible mock prefix.
// The earlier repro only waited for text to start appearing, which exercised an
// in-flight mock-stream resume gap rather than a completed-chat switch.
async function waitForMockResponse(page: Page, marker: string): Promise<void> {
  await page.waitForFunction(
    (marker: string) => {
      const messages = document.querySelectorAll("[data-message-block]");
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const lastMessageText = lastMessage?.textContent ?? "";
      const actionButtonCount =
        lastMessage?.querySelectorAll("[data-message-meta-actions] button").length ?? 0;
      return lastMessageText.includes(`Mock response: ${marker}`) && actionButtonCount > 1;
    },
    marker,
    { timeout: 60_000 }
  );
}

async function captureOpenTransition(args: {
  page: Page;
  clickWorkspaceId: string;
  targetMarker: string;
}): Promise<OpenTransitionFrameSample[]> {
  const row = args.page.locator(
    `[data-workspace-id="${args.clickWorkspaceId}"][data-workspace-path]`
  );
  await row.waitFor({ state: "visible", timeout: 60_000 });
  await row.scrollIntoViewIfNeeded();
  await args.page.evaluate((targetMarker: string) => {
    (
      window as Window & {
        __muxOpenTransitionFramesPromise?: Promise<OpenTransitionFrameSample[]>;
      }
    ).__muxOpenTransitionFramesPromise = new Promise((resolve) => {
      const frames: OpenTransitionFrameSample[] = [];
      let frame = 0;
      const step = () => {
        const inputSection = document.querySelector(
          '[data-component="ChatInputSection"]'
        ) as HTMLElement | null;
        const messageWindow = document.querySelector(
          '[data-testid="message-window"]'
        ) as HTMLElement | null;
        const bodyText = document.body.textContent ?? "";
        frames.push({
          frame,
          timestamp: performance.now(),
          hasInput: inputSection !== null,
          chatInputHeight: inputSection?.getBoundingClientRect().height ?? null,
          hasMessageWindow: messageWindow !== null,
          messageWindowHeight: messageWindow?.getBoundingClientRect().height ?? null,
          containsTargetMarker: bodyText.includes(targetMarker),
          loadingWorkspace: bodyText.includes("Loading workspace..."),
          loadingTranscript: bodyText.includes("Loading transcript..."),
        });
        frame += 1;
        if (frame < 20) {
          requestAnimationFrame(step);
        } else {
          resolve(frames);
        }
      };
      requestAnimationFrame(step);
    });
  }, args.targetMarker);
  await row.dispatchEvent("click");
  return await args.page.evaluate(() => {
    return (
      (
        window as Window & {
          __muxOpenTransitionFramesPromise?: Promise<OpenTransitionFrameSample[]>;
        }
      ).__muxOpenTransitionFramesPromise ?? Promise.resolve([])
    );
  });
}

async function captureSwitch(args: {
  page: Page;
  sourceMarker: string;
  targetMarker: string;
  clickWorkspaceId: string;
  outputDir: string;
  framePrefix: string;
}): Promise<SwitchFrameSample[]> {
  const row = args.page.locator(
    `[data-workspace-id="${args.clickWorkspaceId}"][data-workspace-path]`
  );
  await row.waitFor({ state: "visible", timeout: 60_000 });
  await row.scrollIntoViewIfNeeded();
  await row.dispatchEvent("click");

  const messageWindow = args.page.locator('[data-testid="message-window"]');
  const frames: SwitchFrameSample[] = [];
  for (let frame = 0; frame < 12; frame++) {
    if (frame > 0) await args.page.waitForTimeout(40);
    await messageWindow.waitFor({ state: "visible", timeout: 60_000 });
    const imagePath = path.join(
      args.outputDir,
      `${args.framePrefix}-${String(frame).padStart(2, "0")}.png`
    );
    const [snapshot, png] = await Promise.all([
      args.page.evaluate(
        ({ sourceMarker, targetMarker, frame }) => {
          const messageWindow = document.querySelector('[data-testid="message-window"]');
          const chatInputSection = document.querySelector(
            '[data-component="ChatInputSection"]'
          ) as HTMLElement | null;
          const rect = messageWindow?.getBoundingClientRect();
          const text = messageWindow?.textContent ?? "";
          return {
            frame,
            timestamp: performance.now(),
            containsTargetMarker: text.includes(targetMarker),
            containsSourceMarker: text.includes(sourceMarker),
            messageWindowTop: rect?.top ?? null,
            messageWindowHeight: rect?.height ?? null,
            scrollTop: messageWindow instanceof HTMLDivElement ? messageWindow.scrollTop : null,
            chatInputHeight: chatInputSection?.getBoundingClientRect().height ?? null,
          };
        },
        { sourceMarker: args.sourceMarker, targetMarker: args.targetMarker, frame }
      ),
      messageWindow.screenshot({ path: imagePath }),
    ]);
    frames.push({ ...snapshot, imagePath, png });
  }
  return frames;
}

function detectInputDisappearances(frames: OpenTransitionFrameSample[]) {
  const disappearances = [] as Array<{
    frame: number;
    loadingWorkspace: boolean;
    loadingTranscript: boolean;
  }>;
  let sawInput = false;
  for (const frame of frames) {
    if (frame.hasInput) {
      sawInput = true;
      continue;
    }
    if (!sawInput) {
      continue;
    }
    disappearances.push({
      frame: frame.frame,
      loadingWorkspace: frame.loadingWorkspace,
      loadingTranscript: frame.loadingTranscript,
    });
  }
  return disappearances;
}

function detectGeometryShift(frames: SwitchFrameSample[]) {
  const anchorIndex = frames.findIndex((frame) => frame.containsTargetMarker);
  if (anchorIndex === -1) return [];
  const anchor = frames[anchorIndex];
  const props: Array<
    keyof Pick<
      SwitchFrameSample,
      "messageWindowTop" | "messageWindowHeight" | "scrollTop" | "chatInputHeight"
    >
  > = ["messageWindowTop", "messageWindowHeight", "scrollTop", "chatInputHeight"];
  const shifts = [] as Array<{ frame: number; property: string; delta: number }>;
  for (const frame of frames.slice(anchorIndex + 1)) {
    if (!frame.containsTargetMarker) continue;
    for (const prop of props) {
      const a = anchor[prop];
      const b = frame[prop];
      if (a == null || b == null) continue;
      const delta = b - a;
      if (Math.abs(delta) > 1) shifts.push({ frame: frame.frame, property: prop, delta });
    }
  }
  return shifts;
}

async function computeDiffRatio(leftPng: Buffer, rightPng: Buffer): Promise<number> {
  const [left, right] = await Promise.all([
    sharp(leftPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(rightPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) return 1;
  let differentPixels = 0;
  const totalPixels = left.info.width * left.info.height;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const delta =
      Math.abs(left.data[offset] - right.data[offset]) +
      Math.abs(left.data[offset + 1] - right.data[offset + 1]) +
      Math.abs(left.data[offset + 2] - right.data[offset + 2]);
    if (delta > 30) differentPixels += 1;
  }
  return differentPixels / totalPixels;
}

async function detectVisualInstability(frames: SwitchFrameSample[]) {
  const anchorIndex = frames.findIndex((frame) => frame.containsTargetMarker);
  if (anchorIndex === -1) return [];
  const diffs = [] as Array<{ fromFrame: number; toFrame: number; ratio: number }>;
  for (let index = anchorIndex; index < frames.length - 1; index++) {
    const current = frames[index];
    const next = frames[index + 1];
    if (!current.containsTargetMarker || !next.containsTargetMarker) continue;
    diffs.push({
      fromFrame: current.frame,
      toFrame: next.frame,
      ratio: await computeDiffRatio(current.png, next.png),
    });
  }
  return diffs.filter((diff) => diff.ratio > 0.01);
}

function stripPng(frames: SwitchFrameSample[]) {
  return frames.map(({ png, ...rest }) => rest);
}

async function main() {
  const muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mux-web-repro-"));
  const demoProject = prepareDemoProject(muxRoot);
  const backendPort = await getFreePort();
  let vitePort = await getFreePort();
  while (vitePort === backendPort) vitePort = await getFreePort();
  const child = spawn("make", ["dev-server"], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      MUX_ROOT: muxRoot,
      MUX_MOCK_AI: "1",
      BACKEND_PORT: String(backendPort),
      VITE_PORT: String(vitePort),
      MUX_ENABLE_TUTORIALS_IN_SANDBOX: "0",
      VITE_ALLOWED_HOSTS: "all",
      NODE_ENV: "development",
    },
  });
  const terminateServer = () => {
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, terminateServer);
  }

  try {
    await waitForHttpReady(`http://127.0.0.1:${vitePort}`);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
      await page.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        localStorage.setItem(
          "tutorialState",
          JSON.stringify({
            disabled: false,
            completed: { settings: true, creation: true, workspace: true },
          })
        );
      });
      await page.reload({ waitUntil: "domcontentloaded" });

      await waitForProjectPage(page);
      const trunkBranch = readTrunkBranch(demoProject.projectPath);
      const workspaceA = await createWorkspaceViaOrpc({
        page,
        projectPath: demoProject.projectPath,
        branchName: `switch-tear-a-${Date.now()}`,
        trunkBranch,
      });
      const workspaceB = await createWorkspaceViaOrpc({
        page,
        projectPath: demoProject.projectPath,
        branchName: `switch-tear-b-${Date.now()}`,
        trunkBranch,
      });
      await ensureProjectExpanded(page);
      const markerA = buildMarker("workspace-a-live");
      const markerB = buildMarker("workspace-b-live");
      const promptA = `${markerA} ${"workspace A live chat reproduction. ".repeat(80)}`;
      const promptB = `${markerB} ${"workspace B live chat reproduction. ".repeat(80)}`;
      const workspaceSeedA = { workspaceId: workspaceA.workspaceId, marker: markerA };
      const workspaceSeedB = { workspaceId: workspaceB.workspaceId, marker: markerB };

      await openWorkspace(page, workspaceA.workspaceId, "");
      await sendMessage(page, promptA);
      await waitForMockResponse(page, markerA);

      await openWorkspace(page, workspaceB.workspaceId, "");
      await sendMessage(page, promptB);
      await waitForMockResponse(page, markerB);

      await openWorkspace(page, workspaceA.workspaceId, markerA);

      const outputDir = path.join(muxRoot, "repro-artifacts");
      await fs.mkdir(outputDir, { recursive: true });
      const firstDirectionFrames = await captureSwitch({
        page,
        sourceMarker: workspaceSeedA.marker,
        targetMarker: workspaceSeedB.marker,
        clickWorkspaceId: workspaceB.workspaceId,
        outputDir,
        framePrefix: "web-first",
      });
      await page.waitForFunction(
        (marker: string) => document.body.textContent?.includes(marker) ?? false,
        workspaceSeedB.marker,
        { timeout: 60_000 }
      );
      const secondDirectionFrames = await captureSwitch({
        page,
        sourceMarker: workspaceSeedB.marker,
        targetMarker: workspaceSeedA.marker,
        clickWorkspaceId: workspaceA.workspaceId,
        outputDir,
        framePrefix: "web-second",
      });
      await page.waitForFunction(
        (marker: string) => document.body.textContent?.includes(marker) ?? false,
        workspaceSeedA.marker,
        { timeout: 60_000 }
      );

      await page.goto(
        `http://127.0.0.1:${vitePort}/project/${encodeURIComponent(demoProject.projectPath)}`,
        {
          waitUntil: "domcontentloaded",
        }
      );
      await waitForProjectPage(page);
      await ensureProjectExpanded(page);

      const firstOpenAfterReloadFrames = await captureOpenTransition({
        page,
        clickWorkspaceId: workspaceA.workspaceId,
        targetMarker: workspaceSeedA.marker,
      });
      await page.waitForFunction(
        (marker: string) => document.body.textContent?.includes(marker) ?? false,
        workspaceSeedA.marker,
        { timeout: 60_000 }
      );
      const firstSwitchToUnseenAfterReloadFrames = await captureOpenTransition({
        page,
        clickWorkspaceId: workspaceB.workspaceId,
        targetMarker: workspaceSeedB.marker,
      });
      await page.waitForFunction(
        (marker: string) => document.body.textContent?.includes(marker) ?? false,
        workspaceSeedB.marker,
        { timeout: 60_000 }
      );

      const result = {
        muxRoot,
        outputDir,
        firstDirection: {
          geometryShifts: detectGeometryShift(firstDirectionFrames),
          unstableVisualDiffs: await detectVisualInstability(firstDirectionFrames),
          frames: stripPng(firstDirectionFrames),
        },
        secondDirection: {
          geometryShifts: detectGeometryShift(secondDirectionFrames),
          unstableVisualDiffs: await detectVisualInstability(secondDirectionFrames),
          frames: stripPng(secondDirectionFrames),
        },
        firstOpenAfterReload: {
          inputDisappearances: detectInputDisappearances(firstOpenAfterReloadFrames),
          frames: firstOpenAfterReloadFrames,
        },
        firstSwitchToUnseenAfterReload: {
          inputDisappearances: detectInputDisappearances(firstSwitchToUnseenAfterReloadFrames),
          frames: firstSwitchToUnseenAfterReloadFrames,
        },
      };
      const diagnosticsPath = path.join(outputDir, "workspace-switch-tear-web-diagnostics.json");
      await fs.writeFile(diagnosticsPath, JSON.stringify(result, null, 2));

      const reproduced =
        result.firstDirection.geometryShifts.length > 0 ||
        result.firstDirection.unstableVisualDiffs.length > 0 ||
        result.secondDirection.geometryShifts.length > 0 ||
        result.secondDirection.unstableVisualDiffs.length > 0 ||
        result.firstOpenAfterReload.inputDisappearances.length > 0 ||
        result.firstSwitchToUnseenAfterReload.inputDisappearances.length > 0;

      console.log(
        JSON.stringify(
          {
            reproduced,
            diagnosticsPath,
            muxRoot,
            outputDir,
            firstDirection: {
              geometryShifts: result.firstDirection.geometryShifts,
              unstableVisualDiffs: result.firstDirection.unstableVisualDiffs,
            },
            secondDirection: {
              geometryShifts: result.secondDirection.geometryShifts,
              unstableVisualDiffs: result.secondDirection.unstableVisualDiffs,
            },
            firstOpenAfterReload: {
              inputDisappearances: result.firstOpenAfterReload.inputDisappearances,
            },
            firstSwitchToUnseenAfterReload: {
              inputDisappearances: result.firstSwitchToUnseenAfterReload.inputDisappearances,
            },
          },
          null,
          2
        )
      );

      process.exitCode = reproduced ? 1 : 0;
    } finally {
      await browser.close();
    }
  } finally {
    terminateServer();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
