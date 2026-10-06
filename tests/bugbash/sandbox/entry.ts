/**
 * The job process of a bug-bash sandbox container (#5714), under docker-init (`--init`).
 * Usage: bun sandbox/entry.ts --export <output folder> -- <command...>
 *
 * The job's stdout and stderr go to this process's stderr, so its stdout carries only the export
 * stream (exportStream.ts). Its stdin is the lifeline: sandbox/launch.ts holds the other end, so
 * EOF means that the launcher is gone, and the container stops.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { writeExport } from "./exportStream";

assertInSandbox(); // first: on a host, kill(-1) below hits every process of this user

const args = process.argv.slice(2);
if (args[0] !== "--export" || args[2] !== "--" || args.length < 4) {
  console.error("usage: entry.ts --export <output folder> -- <command...>");
  process.exit(2);
}
const exportDir = args[1];
const [command, ...commandArgs] = args.slice(3);

/** Linux skips PID 1 and the caller. When this process exits, docker-init exits too. */
function killAllOthers(): void {
  try {
    process.kill(-1, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** SIGKILL is not instant: wait until docker-init has reaped every other process. */
async function othersGone(): Promise<void> {
  const others = () =>
    fs
      .readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name) && name !== "1" && name !== String(process.pid));
  for (let i = 0; i < 100 && others().length > 0; i++) await Bun.sleep(50);
  const left = others();
  if (left.length > 0) throw new Error(`processes ${left.join(" ")} still run after SIGKILL`);
}

process.stdin.on("end", () => {
  console.error("sandbox entry: the launcher is gone, so the job stops");
  killAllOthers();
  process.exit(137);
});
process.stdin.resume();

let finished = false;
async function finish(code: number): Promise<void> {
  if (finished) return;
  finished = true;
  killAllOthers(); // the app and Chromium too: nothing writes to the output after this
  await othersGone();
  const sent = await writeExport(process.stdout, exportDir);
  if (sent.skipped.length > 0)
    console.error(`sandbox entry: not exported: ${sent.skipped.join(", ")}`);
  process.exit(code);
}

// A failed export exits nonzero. The launcher then reports the evidence as incomplete.
const done = (code: number): void => {
  finish(code).catch((error: unknown) => {
    console.error(`sandbox entry: export failed: ${String(error)}`);
    process.exit(1);
  });
};
const job = spawn(command, commandArgs, { stdio: ["ignore", 2, 2] });
job.on("error", (error) => {
  console.error(`sandbox entry: ${command}: ${error.message}`);
  done(127);
});
// The shell convention, as the launcher's exitCode(): 128 + the signal number.
job.on("exit", (code, signal) =>
  done(code ?? (signal != null ? 128 + os.constants.signals[signal] : 1))
);

function assertInSandbox(): void {
  const init = fs.readFileSync("/proc/1/cmdline", "utf8");
  const ok =
    process.env.BUGBASH_CONTAINER === "1" &&
    init.startsWith("/sbin/docker-init\0") &&
    fs.readdirSync("/sys/class/net").join() === "lo";
  if (!ok) {
    console.error("sandbox entry: not in the bug-bash sandbox, so it refuses to run");
    process.exit(2);
  }
}
