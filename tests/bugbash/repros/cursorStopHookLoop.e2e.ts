// Cursor plugin RFC PR 8, CUJ 3 (Verification Plan step 4): a copy of Cursor's ralph-loop
// (ralph-loop-cursor, tests/bugbash/pluginHookFixtures.ts) continues a turn with its stop hook
// until the reply holds its <promise> tag, then stops. A user Stop ends the current turn with no
// continuation, the loop stays active in `.cursor/ralph/`, and cancel-ralph ends it.
//
// The mock model runs no tool, so the test does the ralph-loop and cancel-ralph skills' file steps
// itself (their SKILL.md): it writes `.cursor/ralph/scratchpad.md` and later deletes the folder.
// The hooks need jq and perl on the app's PATH, as in Cursor.
import { test } from "@e2e-dev/web";
import type { Browser } from "@e2e-dev/web";
import type { Screen } from "e2e";
import { expect } from "e2e";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import * as fs from "fs";
import * as path from "path";
import type { AppRouter } from "../../../src/node/orpc/router";
import { WORKSPACE_TITLE, openPlayground, sendMessage } from "./helpers";

/** The name in ralph-loop-cursor's .cursor-plugin/plugin.json, which the seed installs. */
const PLUGIN = "ralph-loop";
const HOOK_EVENTS = ["afterAgentResponse", "stop"] as const;
const PROMISE = "DONE";
/** The mock streams its reply to this marker for about 18 s (mockAiRouter.ts): time to act. */
const LONG_TURN = "[mock:long-stream]";
const TASK = "Fix the failing test.";
/** How ralph's stop hook starts each followup_message (hooks/stop-hook.sh). */
const CONTINUATION = "[Ralph loop iteration ";

interface App {
  baseUrl: string | undefined;
}

function client(app: App): RouterClient<AppRouter> {
  if (app.baseUrl === undefined) throw new Error("The bug-bash target declares no app URL");
  return createORPCClient(new RPCLink({ origin: new URL(app.baseUrl).origin, url: "/orpc" }));
}

async function playground(app: App): Promise<{ id: string; root: string }> {
  const found = (await client(app).workspace.list()).filter(
    (workspace) => workspace.title === WORKSPACE_TITLE
  );
  if (found.length !== 1) throw new Error(`expected one '${WORKSPACE_TITLE}' workspace`);
  return { id: found[0].id, root: found[0].namedWorkspacePath };
}

/** The continuation rows the stop hook added to the chat, from the server's history. */
async function continuations(app: App): Promise<number> {
  const { id } = await playground(app);
  const replay = await client(app).workspace.getFullReplay({ workspaceId: id });
  return replay.filter(
    (row) =>
      row.type === "message" &&
      row.role === "user" &&
      row.parts.some((part) => part.type === "text" && part.text.startsWith(CONTINUATION))
  ).length;
}

const ralphDir = (root: string) => path.join(root, ".cursor", "ralph");
const scratchpad = (root: string) => path.join(ralphDir(root), "scratchpad.md");

/** The ralph-loop skill's state file, in its exact format; max_iterations is a safety net. */
function startLoop(root: string, prompt: string): void {
  fs.mkdirSync(ralphDir(root), { recursive: true });
  fs.writeFileSync(
    scratchpad(root),
    `---\niteration: 1\nmax_iterations: 5\ncompletion_promise: "${PROMISE}"\n---\n\n${prompt}\n`
  );
}

/** The loop's iteration from the state file; null when no loop is active. */
function iteration(root: string): number | null {
  if (!fs.existsSync(scratchpad(root))) return null;
  const match = /^iteration: (\d+)$/m.exec(fs.readFileSync(scratchpad(root), "utf8"));
  return match == null ? null : Number(match[1]);
}

async function trustRalphHooks(screen: Screen, browser: Browser): Promise<void> {
  await browser.locator('[data-testid="settings-button"]').tap();
  const settings = screen.getByRole("dialog", "Settings");
  await expect(settings).toBeVisible({ timeout: 15_000 });
  await settings.getByRole("button", "Plugins").tap();
  await settings.getByRole("button", `Review hooks for ${PLUGIN}`).tap({ timeout: 30_000 });
  for (const event of HOOK_EVENTS) {
    const trust = settings.getByRole("button", new RegExp(`^Trust ${event} hook `));
    await trust.tap({ timeout: 15_000 });
    await expect(trust).toHaveCount(0, { timeout: 15_000 });
  }
  await browser.keyboard.press("Escape");
  await expect(settings).toBeHidden();
}

/** Ends any loop and clears both trust decisions: one app serves every test of both targets. */
async function cleanUp(app: App): Promise<void> {
  fs.rmSync(ralphDir((await playground(app)).root), { recursive: true, force: true });
  const hooks = await client(app).agentPlugins.getHooks({ name: PLUGIN });
  if (!hooks.success) return;
  for (const hook of hooks.data.hooks) {
    await client(app).agentPlugins.setHookTrust({
      name: PLUGIN,
      key: hook.key,
      hash: hook.hash,
      state: null,
    });
  }
}

const notice = (screen: Screen, n: number) =>
  screen.getByText(new RegExp(`plugin continued turn ${n} of 50`));

async function waitUntilIdle(screen: Screen): Promise<void> {
  await expect(screen.getByRole("button", "Stop streaming")).toBeHidden({ timeout: 30_000 });
}

test(
  "ralph's stop hook continues the turn until the reply holds its promise",
  { tags: ["bugbash", "cursor-stop-loop", "mock-only"], timeout: 180_000 },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    try {
      await openPlayground(app, screen, browser);
      await trustRalphHooks(screen, browser);
      const { root } = await playground(app);
      const before = await continuations(app);

      startLoop(root, `${LONG_TURN} ${TASK}`);
      await sendMessage(screen, `${TASK} (${Date.now()})`);
      // The first reply holds no promise: the stop hook bumps the iteration and continues.
      await expect.poll(() => iteration(root), { timeout: 30_000 }).toBe(2);
      await expect(notice(screen, 1)).toBeVisible({ timeout: 10_000 });
      // Ralph feeds the state file's prompt back on every turn. Without the marker, the mock
      // echoes the third turn's prompt, whose loop header holds <promise>DONE</promise>.
      fs.writeFileSync(
        scratchpad(root),
        fs.readFileSync(scratchpad(root), "utf8").replace(`${LONG_TURN} `, "")
      );
      await expect(notice(screen, 2)).toBeVisible({ timeout: 60_000 });
      // afterAgentResponse saw the promise and stop ended the loop, before max_iterations.
      await expect.poll(() => iteration(root), { timeout: 30_000 }).toBeNull();
      await waitUntilIdle(screen);
      expect(await continuations(app)).toBe(before + 2);
      await expect(notice(screen, 3)).toHaveCount(0);
    } finally {
      await cleanUp(app);
    }
  }
);

test(
  "a Stop ends ralph's continued turn without a continuation, and cancel-ralph ends the loop",
  { tags: ["bugbash", "cursor-stop-loop", "mock-only"], timeout: 180_000 },
  async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 1440, height: 900 });
    try {
      await openPlayground(app, screen, browser);
      await trustRalphHooks(screen, browser);
      const { root } = await playground(app);
      const before = await continuations(app);

      startLoop(root, `${LONG_TURN} ${TASK}`);
      await sendMessage(screen, `${TASK} (${Date.now()})`);
      await expect.poll(() => iteration(root), { timeout: 30_000 }).toBe(2);
      await expect(notice(screen, 1)).toBeVisible({ timeout: 10_000 });
      await screen.getByRole("button", "Stop streaming").tap({ timeout: 15_000 });
      await waitUntilIdle(screen);
      expect(await continuations(app)).toBe(before + 1);
      await expect(notice(screen, 2)).toHaveCount(0);
      // The stop hook never started after the Stop, and the loop stays active.
      expect(iteration(root)).toBe(2);

      // cancel-ralph's workflow: the state file exists, so delete the loop's folder.
      fs.rmSync(ralphDir(root), { recursive: true });
      const next = `Anything left? (${Date.now()})`;
      await sendMessage(screen, next);
      await expect(screen.getByText(`Mock response: ${next}`)).toBeVisible({ timeout: 30_000 });
      await waitUntilIdle(screen);
      expect(await continuations(app)).toBe(before + 1);
      expect(iteration(root)).toBeNull();
    } finally {
      await cleanUp(app);
    }
  }
);
