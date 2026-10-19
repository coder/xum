/**
 * The story suite's `test`: `@e2e-dev/web`'s, plus an `xum` fixture for what e2e cannot do.
 *
 * `xum.restartServer()` restarts the app's `xum server` on the same port and XUM_ROOT. e2e's
 * `app.restart()` only opens a new page; it does not restart the target's `command`. So the
 * fixture sends SIGUSR2 to startApp.ts (the target's command, in the same container and with the
 * same uid as this worker) and waits for the control file (../bugbash/appControl.ts) to name the
 * next server. Open the app again afterwards: the old page lost its server.
 */
import { test as base } from "@e2e-dev/web";
import { readAppControl, type AppControl } from "../bugbash/appControl";

export interface XumControl {
  restartServer(): Promise<void>;
}

const RESTART_TIMEOUT_MS = 60_000;

async function poll<T>(what: string, deadline: number, probe: () => Promise<T | null>): Promise<T> {
  for (;;) {
    const value = await probe();
    if (value != null) return value;
    if (Date.now() > deadline) throw new Error(`xum.restartServer: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function restartServer(baseUrl: string): Promise<void> {
  const port = Number(new URL(baseUrl).port);
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  // e2e can find the port open a moment before startApp.ts's own probe writes the file.
  const before = await poll<AppControl>("the control file", deadline, () =>
    Promise.resolve(readAppControl(port))
  );
  process.kill(before.pid, "SIGUSR2");
  await poll(`server generation ${before.generation + 1}`, deadline, () => {
    const control = readAppControl(port);
    return Promise.resolve(
      control?.generation === before.generation + 1 && control.ready ? control : null
    );
  });
  await poll("/health", deadline, async () => {
    try {
      const response = await fetch(new URL("/health", baseUrl), {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok ? true : null;
    } catch {
      return null;
    }
  });
}

export const test = base.extend<{ xum: XumControl }>({
  xum: async ({ app }, use) => {
    const baseUrl = app.baseUrl;
    if (baseUrl === undefined) throw new Error("The story target declares no app URL");
    await use({ restartServer: () => restartServer(baseUrl) });
  },
});
