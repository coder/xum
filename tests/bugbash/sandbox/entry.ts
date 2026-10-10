/**
 * The job process of a bug-bash sandbox container (#5714), under docker-init (`--init`).
 * Usage: bun sandbox/entry.ts --export <output folder> -- <command...>
 *
 * The job's stdout and stderr go to this process's stderr, so its stdout carries only the export
 * stream (exportStream.ts). Its stdin is the lifeline: sandbox/launch.ts holds the other end, so
 * EOF means that the launcher is gone, and the container stops.
 *
 * Before the job starts, it checks that the daemon runs on the launcher's host: the same kernel
 * (boot id) and the same files (a nonce that the launcher wrote into the staged copy).
 *
 * A model-driven job (BUGBASH_MODEL_DRIVEN=1) also needs the job's provider proxy socket, and it
 * gets a TCP forwarder to it on 127.0.0.1 (inContainer.ts). The app AI stays the mock.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { writeExport } from "./exportStream";
import { forwardToProxy, inSandbox, modelDrivenSandbox } from "./inContainer";

// First: on a host, kill(-1) below hits every process of this user.
if (!inSandbox()) {
  console.error("sandbox entry: not in the bug-bash sandbox, so it refuses to run");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] !== "--export" || args[2] !== "--" || args.length < 4) {
  console.error("usage: entry.ts --export <output folder> -- <command...>");
  process.exit(2);
}
const exportDir = args[1];
// The launcher sets the mode. No provider key ever enters, so the real app AI runs only in a
// model-driven job, through its proxy (aiMode.ts); the proxy socket is checked below.
const resolvedAi = process.env.BUGBASH_AI_RESOLVED;
const modelDriven = process.env.BUGBASH_MODEL_DRIVEN === "1";
if (resolvedAi !== "mock" && !(resolvedAi === "real" && modelDriven)) {
  console.error(
    "sandbox entry: the real app AI runs only in a model-driven job, so this does not run"
  );
  process.exit(2);
}
const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const nonce = fs.readFileSync("/repo/.sandbox-nonce", "utf8");
if (boot !== process.env.BUGBASH_HOST_BOOT || nonce !== process.env.BUGBASH_HOST_NONCE) {
  console.error("sandbox entry: the Docker daemon runs on another host, so the job does not run");
  process.exit(2);
}
const [command, ...commandArgs] = args.slice(3);
if (modelDriven) {
  if (!modelDrivenSandbox()) {
    console.error("sandbox entry: a model-driven job without its proxy socket does not run");
    process.exit(2);
  }
  await forwardToProxy(); // ends with this process, after the export
}

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
