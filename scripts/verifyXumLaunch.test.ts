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
  // Acts out a nodemon restart right after readiness: the first /health deletes server.lock, and
  // a new lock (a later startedAt, the same token) appears 3 s later.
  restartAfterFirstHealth?: boolean;
}

// Runs as `make -C <checkout> dev-server-sandbox ...` in the launch's own process group, so its
// command line names dev-server-sandbox and cleanup signals it. It reads its settings from the
// file next to it (launch runs it under `env -i`) and exits on its own after 60 s at the latest.
const FAKE_MAKE = `#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
const fake = JSON.parse(fs.readFileSync(path.join(__dirname, "fake.json"), "utf8"));
const checkout = process.argv[process.argv.indexOf("-C") + 1];
setTimeout(() => process.exit(0), 60_000);
const listen = (host, handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, host, () => resolve(server.address().port));
  });
let lockPath = "";
const writeLock = (startedAt) => {
  const lock = { startedAt: startedAt.toISOString() };
  if (fake.token) lock.token = fake.token;
  fs.writeFileSync(lockPath, JSON.stringify(lock));
};
let restarted = false;
(async () => {
  // Like the real backend, only /health answers without the token. The fake has no API, so a
  // request with the token gets 404.
  const backendPort = await listen(fake.backendHost, (req, res) => {
    if (req.url === "/health" && fake.restartAfterFirstHealth && !restarted) {
      restarted = true;
      fs.rmSync(lockPath);
      setTimeout(() => writeLock(new Date()), 3000);
    }
    const authorized = fake.token !== "" && req.headers.authorization === "Bearer " + fake.token;
    res.statusCode = req.url === "/health" ? 200 : authorized ? 404 : 401;
    res.end();
  });
  const vitePort = await listen(fake.viteHost, (_req, res) => res.end("ok"));
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, "mux-dev-server-"));
  const stamp = Date.now();
  fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "dist/.main-build-complete"), String(stamp));
  lockPath = path.join(root, "server.lock");
  writeLock(new Date(stamp + 1));
  console.log("  XUM_ROOT:       " + root);
  console.log("  Seed config:     (none)");
  console.log("  Backend:         http://127.0.0.1:" + backendPort);
  console.log("  Frontend:        http://localhost:" + vitePort);
  console.log("  Allowed hosts:   " + fake.allowedHosts);
})();
`;

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
  fs.writeFileSync(path.join(bin, "fake.json"), JSON.stringify(fake));
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

// A nodemon restart deletes server.lock for a moment (see run_token in verify-xum.sh). Launch must
// wait for the new lock, not read the missing one as a backend without a token.
test.skipIf(!isLinux)(
  "launch waits for server.lock when a restart deletes it right after readiness",
  () => {
    const r = launch({ ...loopback, restartAfterFirstHealth: true });
    expect(r.stderr).not.toContain("no auth token");
    expect(r.stderr).toContain("returned error: 404");
    expect(r.left).toBe(0);
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
    // 401: the call carried the run's token.
    expect(r.stderr).toContain("returned error: 404");
    expect(r.left).toBe(0);
  },
  90_000
);
