"use strict";

// Runs a command while holding a per-user lock, so only one copy runs at a time across every
// worktree and checkout on the machine.
//
// Usage: node scripts/lib/run_exclusive.js <lock-name> -- <command> [args...]
//
// scripts/lint.sh uses it for full ESLint runs: each one peaks at ~7.6 GiB, and five agents
// starting one together needed ~37 GiB. Waiting for the running one costs minutes; running them
// together can OOM-kill the whole workspace.
//
// The lock is a directory (mkdir is atomic on every platform we support, unlike flock, which macOS
// lacks) holding owner.json with the holder's pid. A lock whose holder died is reclaimed. Two
// waiters reclaiming the same stale lock can race and both run, which is no worse than no lock.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const POLL_MS = 500;
// A crash between creating the lock directory and writing owner.json leaves a lock with no owner.
// Writing the file takes microseconds, so an ownerless lock this old is abandoned.
const OWNERLESS_STALE_MS = 10_000;

function lockPathFor(name, env = process.env) {
  return path.join(env.XUM_LOCK_DIR || os.tmpdir(), `xum-${name}.lock`);
}

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

function tryCreate(lockPath, owner) {
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner));
  return true;
}

function isStale(lockPath, owner, now) {
  if (owner !== null) {
    return !isAlive(owner.pid);
  }
  try {
    return now - fs.statSync(lockPath).mtimeMs > OWNERLESS_STALE_MS;
  } catch {
    return false; // Released meanwhile; the next attempt will take it.
  }
}

// Moves the lock aside before deleting it, so a waiter never deletes a lock someone else
// created after it judged the old one stale (unless that happens between the two calls).
function removeStale(lockPath, staleOwner) {
  if (readOwner(lockPath)?.pid !== staleOwner?.pid) {
    return;
  }
  const aside = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return;
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

async function acquire(lockPath, onWait) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const self = { pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() };
  let waited = false;
  for (;;) {
    if (tryCreate(lockPath, self)) {
      return;
    }
    const owner = readOwner(lockPath);
    if (isStale(lockPath, owner, Date.now())) {
      removeStale(lockPath, owner);
      continue;
    }
    if (!waited) {
      onWait(owner);
      waited = true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function release(lockPath) {
  if (readOwner(lockPath)?.pid === process.pid) {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf("--");
  const name = argv[0];
  const command = argv.slice(separator + 1);
  if (separator !== 1 || !/^[a-z0-9-]+$/.test(name) || command.length === 0) {
    process.stderr.write("usage: run_exclusive.js <lock-name> -- <command> [args...]\n");
    process.exit(2);
  }

  const lockPath = lockPathFor(name);
  await acquire(lockPath, (owner) => {
    const holder = owner ? `pid ${owner.pid} in ${owner.cwd}` : "another process";
    process.stderr.write(`Waiting for ${holder} to finish its ${name} (lock: ${lockPath})...\n`);
  });

  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  // Keep the lock until the child exits: forward termination signals instead of dying first.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    release(lockPath);
    process.stderr.write(`run_exclusive: ${command[0]}: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    release(lockPath);
    process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
  });
}

module.exports = { lockPathFor, acquire, release };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `run_exclusive: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
