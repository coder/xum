/**
 * The Electron stories' `test`: `@e2e-dev/web`'s, plus an `xum` fixture for what e2e cannot do.
 *
 * `xum.openDeepLink(url)` launches Xum Electron a second time with `url` in its argv, as the
 * desktop opens a `xum://` link on Linux. That process gets the same allowlisted env as the
 * provider's (electronProvider.ts, so no XUM_ALLOW_MULTIPLE_INSTANCES): it finds the
 * single-instance lock of the running app, hands its argv over (`second-instance`,
 * src/desktop/main.ts) and quits. The fixture waits for that exit and requires code 0.
 */
import { test as base } from "@e2e-dev/web";
import { killGroup, spawnElectron } from "../electronProvider";

export interface XumElectronControl {
  openDeepLink(url: string): Promise<void>;
}

const SECOND_INSTANCE_TIMEOUT_MS = 30_000;

async function openDeepLink(url: string): Promise<void> {
  if (!url.startsWith("xum://")) throw new Error(`xum.openDeepLink: not a xum:// link: ${url}`);
  // The worker's env is the run's env, which the provider gets as `request.env`.
  const child = spawnElectron(process.env, [url]);
  const pid = child.pid;
  if (pid == null) throw new Error("xum.openDeepLink: the second Xum Electron did not start");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<number | string | null>((resolve) =>
    child.once("exit", (code, signal) => resolve(code ?? signal))
  );
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SECOND_INSTANCE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([exited, timedOut]);
    // A second instance that stays up took the lock: the running app never saw the link.
    if (result === "timeout")
      throw new Error("xum.openDeepLink: the second Xum Electron did not exit within 30 s");
    if (result !== 0) throw new Error(`xum.openDeepLink: the second Xum Electron exited ${result}`);
  } finally {
    clearTimeout(timer);
    await killGroup(pid); // its helper processes, if any outlived it
  }
}

export const test = base.extend<{ xum: XumElectronControl }>({
  // eslint-disable-next-line no-empty-pattern -- e2e fixtures take their dependencies first
  xum: async ({}, use) => {
    await use({ openDeepLink });
  },
});
