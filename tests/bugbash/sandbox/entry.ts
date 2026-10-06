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
job.on("exit", (code, signal) => done(code ?? (signal != null ? 143 : 1)));

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
