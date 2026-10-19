/**
 * The control file of one startApp.ts run: `os.tmpdir()/xum-bugbash-app-<port>.json`.
 *
 * e2e's `app.restart()` only opens a new page; it does not restart the target's `command`. So a
 * story that must see the app after a server restart (tests/stories/fixtures.ts) sends SIGUSR2 to
 * startApp.ts, which serves the same XUM_ROOT again on the same port. startApp.ts rewrites this
 * file each time a server is healthy, so the story knows whom to signal and when the new server
 * is up. A module of its own: the story worker imports it without startApp.ts's seed imports.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface AppControl {
  /** startApp.ts, the process that takes SIGUSR2. */
  pid: number;
  /** 1 for the first server on the port, plus one per restart. */
  generation: number;
  ready: true;
}

export function appControlPath(port: number): string {
  return path.join(os.tmpdir(), `xum-bugbash-app-${port}.json`);
}

/** Atomic: a reader sees the old file or the new one, never half of one. */
export function writeAppControl(port: number, control: AppControl): void {
  const file = appControlPath(port);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(control));
  fs.renameSync(temp, file);
}

/** The control file, or null while it is missing. */
export function readAppControl(port: number): AppControl | null {
  let text: string;
  try {
    text = fs.readFileSync(appControlPath(port), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const control = JSON.parse(text) as AppControl;
  if (!Number.isInteger(control.pid) || !Number.isInteger(control.generation)) {
    throw new Error(`malformed app control file ${appControlPath(port)}: ${text}`);
  }
  return control;
}
