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

/**
 * The Electron story target's control file (tests/stories/e2e.electron.config.ts): `startApp.ts
 * --electron` seeds XUM_ROOT, writes this file, then serves the built renderer on its port. The
 * browser provider (tests/stories/electronProvider.ts) starts Xum Electron on that root and port.
 * One name, not one per port: the provider never learns the port that e2e picked, and the
 * Electron config runs one target with one worker in its own sandbox container.
 */
export interface ElectronAppControl {
  /** startApp.ts, the process that serves the renderer. */
  pid: number;
  /** The renderer's loopback port: the target's app URL and XUM_DEVSERVER_PORT. */
  port: number;
  /** The seeded XUM_ROOT. */
  root: string;
  /** The mode and kill-switch env that startApp.ts gave the seed server (appSwitches). */
  switches: Record<string, string>;
  ready: true;
}

/** `tmpdir`: the TMPDIR of the reader's env (the provider gets no process.env). */
export function electronControlPath(tmpdir = os.tmpdir()): string {
  return path.join(tmpdir, "xum-bugbash-electron.json");
}

export function writeElectronControl(control: ElectronAppControl): void {
  const file = electronControlPath();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(control));
  fs.renameSync(temp, file);
}

/** The Electron control file, or null while it is missing. */
export function readElectronControl(tmpdir?: string): ElectronAppControl | null {
  const file = electronControlPath(tmpdir);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const control = JSON.parse(text) as ElectronAppControl;
  if (
    !Number.isInteger(control.pid) ||
    !Number.isInteger(control.port) ||
    typeof control.root !== "string" ||
    !path.isAbsolute(control.root) ||
    control.switches == null ||
    typeof control.switches !== "object"
  ) {
    throw new Error(`malformed Electron control file ${file}: ${text}`);
  }
  return control;
}
