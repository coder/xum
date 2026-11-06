import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// verify-xum's launch must refuse a sandbox that a checkout's .env file (Bun loads it into
// scripts/dev-server-sandbox.ts) opened beyond loopback: extra allowed Host headers, Vite or the
// backend listening on every interface, or a backend without an auth token. Each test runs the
// real verify-xum.sh in a throwaway git repo. A stub `make` stands in for `make
// dev-server-sandbox`: it prints the sandbox's banner and serves a fake backend and Vite, so
// launch gets as far as the checks under test.
const SKILL_SCRIPT = ".xum/skills/verify-xum/scripts/verify-xum.sh";
const isLinux = process.platform === "linux";

interface Fake {
  allowedHosts: string;
  viteHost: string;
  backendHost: string;
  // The token the fake backend records in server.lock. Empty: none, as with
  // XUM_DEV_SERVER_NO_AUTH=1.
  token: string;
  // Acts out a nodemon restart right after readiness. At the first /health the old backend dies:
  // its port and socket close, and its lock stays and names a dead pid. 4 s later the next backend
  // listens again and writes its own lock over it (ServerLockfile.read never deletes a stale lock).
  restartAfterFirstHealth?: boolean;
  // Arms the `ss` stub of swapLockSs at the first /health.
  swapLockDuringCheck?: boolean;
  // Deletes server.lock as soon as launch has written the run's token copy, before the seed.
  dropLockBeforeSeed?: boolean;
  // The pid that server.lock names. Default: the fake backend's own.
  lockPid?: number;
  // The mode of the socket's folder. Default: 0700, as the Makefile makes it.
  socketDirMode?: number;
}

// Runs as `make -C <checkout> dev-server-sandbox ...` in the launch's own process group, so its
// command line names dev-server-sandbox and cleanup signals it. It reads its settings from the
// file next to it (launch runs it under `env -i`) and exits on its own after 60 s at the latest.
// Like the Makefile, it serves the backend on a TCP port and on a Unix socket in a private folder,
// and prints the socket in the banner.
const FAKE_MAKE = `#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawnSync } = require("child_process");
const fake = JSON.parse(fs.readFileSync(path.join(__dirname, "fake.json"), "utf8"));
const checkout = process.argv[process.argv.indexOf("-C") + 1];
setTimeout(() => process.exit(0), 60_000);
const root = fs.mkdtempSync(path.join(process.env.TMPDIR, "mux-dev-server-"));
// mkdtemp makes the folder 0700, as the Makefile's socket folder is.
const socketDir = fs.mkdtempSync(path.join(process.env.TMPDIR, "sock-"));
if (fake.socketDirMode !== undefined) fs.chmodSync(socketDir, fake.socketDirMode);
const socketPath = path.join(socketDir, "b.sock");
const lockPath = path.join(root, "server.lock");
const writeLock = (pid, startedAt) => {
  const lock = { pid, startedAt: startedAt.toISOString() };
  if (fake.token) lock.token = fake.token;
  fs.writeFileSync(lockPath + ".tmp", JSON.stringify(lock));
  fs.renameSync(lockPath + ".tmp", lockPath);
};
// Like the real backend, the fake answers /health without the token (the real one also answers
// /version and /auth/server-login/* without it). The fake has no API, so a request with the token
// gets 404. Every request that carries a token on the TCP port is logged: the skill must send the
// token only over the socket.
let onFirstHealth = () => {};
const handler = (overTcp) => (req, res) => {
  if (overTcp && req.headers.authorization !== undefined) {
    const log = path.join(__dirname, "tcp-token-requests.log");
    fs.appendFileSync(log, req.method + " " + req.url + "\\n");
  }
  if (overTcp && req.url === "/health") {
    onFirstHealth();
    onFirstHealth = () => {};
  }
  const authorized = fake.token !== "" && req.headers.authorization === "Bearer " + fake.token;
  res.statusCode = req.url === "/health" ? 200 : authorized ? 404 : 401;
  res.end();
};
const tcp = http.createServer(handler(true));
const unix = http.createServer(handler(false));
const listen = (server, ...args) => new Promise((resolve) => server.listen(...args, resolve));
(async () => {
  await listen(tcp, 0, fake.backendHost);
  const backendPort = tcp.address().port;
  await listen(unix, socketPath);
  const vite = http.createServer((_req, res) => res.end("ok"));
  await listen(vite, 0, fake.viteHost);
  const stamp = Date.now();
  fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "dist/.main-build-complete"), String(stamp));
  writeLock(fake.lockPid ?? process.pid, new Date(stamp + 1));
  fs.writeFileSync(path.join(__dirname, "state.json"), JSON.stringify({ backendPort, lockPath }));
  onFirstHealth = () => {
    if (fake.swapLockDuringCheck) fs.writeFileSync(path.join(__dirname, "swap-armed"), "");
    if (!fake.restartAfterFirstHealth) return;
    tcp.close();
    unix.close();
    writeLock(spawnSync("true").pid, new Date(stamp + 1));
    setTimeout(async () => {
      fs.rmSync(socketPath, { force: true });
      await listen(tcp, backendPort, fake.backendHost);
      await listen(unix, socketPath);
      writeLock(process.pid, new Date());
    }, 4000);
  };
  if (fake.dropLockBeforeSeed) {
    const copy = path.join(fake.home, process.env.VERIFY_XUM_SERVER_OF, "token");
    const poll = setInterval(() => {
      if (!fs.existsSync(copy)) return;
      clearInterval(poll);
      fs.rmSync(lockPath);
    }, 2);
  }
  console.log("  XUM_ROOT:       " + root);
  console.log("  Seed config:     (none)");
  console.log("  Backend:         http://127.0.0.1:" + backendPort);
  console.log("  Frontend:        http://localhost:" + vite.address().port);
  console.log("  Allowed hosts:   " + fake.allowedHosts);
  console.log("  Vite -> backend:         Unix socket " + socketPath);
})();
`;

// An `ss` that wraps the real one. Once the fake arms it (at the first /health), it answers the
// backend's port with nothing and, in that moment, renames a new backend's lock over server.lock:
// a restart that ends while launch checks the port.
function swapLockSs(): string {
  const realSs = spawnSync("bash", ["-c", "command -v ss"], { encoding: "utf8" }).stdout.trim();
  expect(realSs).not.toBe("");
  return `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const armed = path.join(__dirname, "swap-armed");
const args = process.argv.slice(2);
let state = null;
try {
  state = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8"));
} catch {}
if (state && fs.existsSync(armed) && args.includes("sport = :" + state.backendPort)) {
  fs.rmSync(armed);
  const lock = JSON.parse(fs.readFileSync(state.lockPath, "utf8"));
  lock.startedAt = new Date().toISOString();
  fs.writeFileSync(state.lockPath + ".tmp", JSON.stringify(lock));
  fs.renameSync(state.lockPath + ".tmp", state.lockPath);
  process.exit(0);
}
process.exit(spawnSync(${JSON.stringify(realSs)}, args, { stdio: "inherit" }).status ?? 1);
`;
}

// The requests that reached the fake backend's TCP port with a token.
function tcpTokenRequests(): string[] {
  const log = path.join(tmp, "bin", "tcp-token-requests.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trimEnd().split("\n") : [];
}

let tmp = "";
afterEach(() => {
  // A launch that cleanup did not reach would leave its fake servers running.
  for (const pid of serverPids()) process.kill(pid, "SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function bunVersion(env: NodeJS.ProcessEnv): string {
  const r = spawnSync("bun", ["--version"], { env, encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

// Starts one launch against the fake and returns its result. Each stub is an extra command in
// launch's PATH, ahead of the real one.
function launch(fake: Fake, stubs: Record<string, string> = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vx-launch-"));
  const repo = path.join(tmp, "repo");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(path.join(repo, path.dirname(SKILL_SCRIPT)), { recursive: true, mode: 0o755 });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(import.meta.dir, "..", SKILL_SCRIPT), path.join(repo, SKILL_SCRIPT));
  fs.chmodSync(path.join(repo, SKILL_SCRIPT), 0o755);
  // The checkout's own vite reports the checkout as its workspace root.
  fs.mkdirSync(path.join(repo, "node_modules/vite"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "node_modules/vite/package.json"),
    JSON.stringify({ name: "vite", type: "module", main: "index.js" })
  );
  fs.writeFileSync(
    path.join(repo, "node_modules/vite/index.js"),
    "export function searchForWorkspaceRoot(dir) { return dir; }\n"
  );
  fs.writeFileSync(path.join(bin, "make"), FAKE_MAKE, { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, "fake.json"),
    JSON.stringify({ ...fake, home: path.join(tmp, "home") })
  );
  // `need` requires agent-browser. Cleanup only lists its sessions, and the stub has none.
  fs.writeFileSync(path.join(bin, "agent-browser"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ packageManager: `bun@${bunVersion(env)}` })
  );
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "x",
    ],
  ]) {
    expect(spawnSync("git", args, { cwd: repo }).status).toBe(0);
  }
  // Every command refuses a git dir that group or others can write (a umask 002 checkout).
  fs.chmodSync(path.join(repo, ".git"), 0o755);
  const started = Date.now();
  const r = spawnSync("bash", [path.join(repo, SKILL_SCRIPT), "launch"], {
    cwd: repo,
    env: { ...env, VERIFY_XUM_HOME: path.join(tmp, "home"), VERIFY_XUM_READY_TIMEOUT: "30" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: r.status,
    stderr: r.stderr,
    seconds: (Date.now() - started) / 1000,
    left: serverPids().length,
    // Runs another verify-xum.sh command in the same checkout and home.
    command: (...args: string[]) =>
      spawnSync("bash", [path.join(repo, SKILL_SCRIPT), ...args], {
        cwd: repo,
        env: { ...env, VERIFY_XUM_HOME: path.join(tmp, "home") },
        encoding: "utf8",
        timeout: 60_000,
      }),
  };
}

// Processes that carry the id of a run under this test's home.
function serverPids(): number[] {
  const home = path.join(tmp, "home");
  if (!tmp || !fs.existsSync(home)) return [];
  const ids = fs.readdirSync(home).map((run) => `VERIFY_XUM_SERVER_OF=${run}`);
  const pids: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const vars = fs.readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      if (vars.some((v) => ids.includes(v))) pids.push(Number(entry));
    } catch {
      // The process exited, or it is not ours.
    }
  }
  return pids;
}

const loopback: Fake = {
  allowedHosts: "loopback only",
  viteHost: "127.0.0.1",
  backendHost: "127.0.0.1",
  token: "fake-token",
};

test.skipIf(!isLinux)(
  "launch refuses a sandbox that allows Host headers besides loopback",
  () => {
    const r = launch({ ...loopback, allowedHosts: "probe.example" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "the sandbox allows the Host headers 'probe.example' besides loopback"
    );
    expect(r.left).toBe(0);
  },
  90_000
);

test.skipIf(!isLinux)(
  "launch refuses a Vite or a backend that listens on every interface",
  () => {
    const vite = launch({ ...loopback, viteHost: "0.0.0.0" });
    expect(vite.status).toBe(1);
    expect(vite.stderr).toMatch(/Vite listens on 0\.0\.0\.0:\d+, not only on loopback/);
    expect(vite.left).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });

    const backend = launch({ ...loopback, backendHost: "0.0.0.0" });
    expect(backend.status).toBe(1);
    expect(backend.stderr).toMatch(/the backend listens on 0\.0\.0\.0:\d+, not only on loopback/);
    expect(backend.left).toBe(0);
  },
  180_000
);

// A server on one non-loopback address never answers launch's loopback probes. Launch must still
// refuse at once, not after VERIFY_XUM_READY_TIMEOUT (30 s here).
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;

test.skipIf(!isLinux || lanAddress === undefined)(
  "launch refuses a Vite on a non-loopback address before its deadline",
  () => {
    const r = launch({ ...loopback, viteHost: lanAddress ?? "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Vite listens on ${lanAddress}:`);
    expect(r.seconds).toBeLessThan(20);
    expect(r.left).toBe(0);
  },
  90_000
);

test.skipIf(!isLinux || lanAddress === undefined)(
  "launch refuses a backend on a non-loopback address before its deadline",
  () => {
    const r = launch({ ...loopback, backendHost: lanAddress ?? "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`the backend listens on ${lanAddress}:`);
    expect(r.seconds).toBeLessThan(20);
    expect(r.left).toBe(0);
  },
  90_000
);

test.skipIf(!isLinux)(
  "launch names the cause when ss fails",
  () => {
    const r = launch(loopback, { ss: "#!/bin/sh\nexit 1\n" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ss failed, so launch cannot check which addresses Vite listens on");
    expect(r.left).toBe(0);
  },
  90_000
);

// ss can fail to see the sockets (a sandbox that blocks its netlink queries). The listener check
// must then refuse after readiness, not pass on an empty answer.
test.skipIf(!isLinux)(
  "launch refuses when ss shows no listener after readiness",
  () => {
    const r = launch(loopback, { ss: "#!/bin/sh\nexit 0\n" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ss shows nothing listening on Vite's port \d+/);
    expect(r.left).toBe(0);
  },
  90_000
);

test.skipIf(!isLinux)(
  "launch refuses a backend without an auth token",
  () => {
    const r = launch({ ...loopback, token: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "the backend has no auth token, so any local account can control it"
    );
    expect(r.stderr).toContain("XUM_DEV_SERVER_NO_AUTH=1");
    expect(r.left).toBe(0);
  },
  90_000
);

// While server.lock is missing or names a dead backend (a stop, or a nodemon restart), the TCP port
// can be free for another account to bind. The skill sends the token only over the backend's Unix
// socket, which no other account can create, so the seed still runs, over the socket.
test.skipIf(!isLinux)(
  "launch sends the token only over the socket while server.lock names a dead backend",
  () => {
    const dead = spawnSync("true");
    expect(dead.status).toBe(0);
    const r = launch({ ...loopback, lockPid: dead.pid });
    // The fake answers 404 only to a request that carries the token.
    expect(r.stderr).toContain("returned error: 404");
    expect(tcpTokenRequests()).toEqual([]);
    expect(r.left).toBe(0);
  },
  90_000
);

test.skipIf(!isLinux)(
  "launch sends the token only over the socket when server.lock is gone before the seed",
  () => {
    const r = launch({ ...loopback, dropLockBeforeSeed: true });
    expect(r.stderr).toContain("returned error: 404");
    expect(tcpTokenRequests()).toEqual([]);
    expect(r.left).toBe(0);
  },
  90_000
);

// Only a folder that no other account can write keeps the socket's name ours.
test.skipIf(!isLinux)(
  "launch refuses a backend socket in a folder that others can write",
  () => {
    const r = launch({ ...loopback, socketDirMode: 0o777 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/sock-\w+ is writable by group or others \(mode 777\)/);
    expect(r.stderr).not.toContain("returned error: 404");
    expect(tcpTokenRequests()).toEqual([]);
    expect(r.left).toBe(0);
  },
  90_000
);

// A nodemon restart frees the backend's port and leaves a lock that names a dead pid until the
// next backend writes its own (see run_token in verify-xum.sh). Launch must wait for the new
// backend, not refuse its port as unseen or the dead lock's backend as one without a token.
test.skipIf(!isLinux)(
  "launch waits out a restart right after readiness",
  () => {
    const r = launch({ ...loopback, restartAfterFirstHealth: true });
    expect(r.stderr).not.toContain("no auth token");
    expect(r.stderr).not.toContain("ss shows nothing listening");
    expect(r.stderr).toContain("returned error: 404");
    expect(tcpTokenRequests()).toEqual([]);
    expect(r.left).toBe(0);
  },
  90_000
);

// A restart can also end while launch checks the port: ss sees the port free, and by the time
// launch reads server.lock again it names the next backend. Launch must check again.
test.skipIf(!isLinux)(
  "launch checks again when server.lock changes while it checks the backend's port",
  () => {
    const r = launch({ ...loopback, swapLockDuringCheck: true }, { ss: swapLockSs() });
    expect(r.stderr).not.toContain("ss shows nothing listening");
    expect(r.stderr).toContain("returned error: 404");
    expect(r.left).toBe(0);
  },
  90_000
);

// A run that an older verify-xum.sh launched has no VERIFY_XUM_BACKEND_SOCKET in its state.env.
// Doctor must say so, not stop on set -u.
test.skipIf(!isLinux)(
  "doctor names a run without a backend socket",
  () => {
    const r = launch(loopback);
    expect(r.stderr).toContain("returned error: 404");
    const home = path.join(tmp, "home");
    const [run] = fs.readdirSync(home);
    const stateEnv = path.join(home, run, "state.env");
    const lines = fs.readFileSync(stateEnv, "utf8").split("\n");
    expect(lines.some((line) => line.startsWith("export VERIFY_XUM_BACKEND_SOCKET="))).toBe(true);
    fs.writeFileSync(
      stateEnv,
      lines.filter((line) => !line.startsWith("export VERIFY_XUM_BACKEND_SOCKET=")).join("\n")
    );
    const doctor = r.command("doctor", path.join(home, run));
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain("names no Unix socket for the backend");
    expect(doctor.stderr).not.toContain("unbound variable");
  },
  90_000
);

test.skipIf(!isLinux)(
  "a loopback-only sandbox with an auth token passes every check",
  () => {
    // The fake backend has no API, so launch fails later, at the seed's first API call.
    const r = launch(loopback);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("besides loopback");
    expect(r.stderr).not.toContain("not only on loopback");
    expect(r.stderr).not.toContain("no auth token");
    // curl -f's error for the seed's first API call (readiness asked only for /health). 404, not
    // 401: the call carried the run's token, over the socket.
    expect(r.stderr).toContain("returned error: 404");
    expect(tcpTokenRequests()).toEqual([]);
    expect(r.left).toBe(0);
  },
  90_000
);
