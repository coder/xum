import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launch, ownerState, recover } from "./launch";
import { groupState, readImageLock, Refusal, Session, Stopped } from "./runner";

// Each test runs the real build.sh in a throwaway git repo and a fake `docker` on PATH. The
// runner gives docker a stripped env, so the fake reads its answers from bin/fake.env.
const SANDBOX = "tests/bugbash/sandbox";
const DIGEST = `sha256:${"61".repeat(32)}`;
const REF = `ghcr.io/coder/xum-bugbash-sandbox@${DIGEST}`;
const FAKE = `#!/bin/sh
bin=$(dirname "$0"); . "$bin/fake.env"
unregister() { awk -v id="$1" '$1!=id' "$bin/containers" > "$bin/c.tmp"; mv "$bin/c.tmp" "$bin/containers"; }
echo "$* [home=\${HOME-} cfg=\${DOCKER_CONFIG-}]" >> "$bin/calls.log"
case "$1" in
  context) if [ "\${CONTEXT-}" = hang ]; then trap '' TERM; exec sleep 30; fi; echo "$HOST" ;;
  info) echo "$INFO" ;;
  images) [ "$IMAGES_RC" = 0 ] || { echo "daemon down" >&2; exit 1; }; echo "$IMAGES" ;;
  pull)
    if [ "$PULL" = hang ]; then trap '' TERM; exec sleep 30; fi
    # A grandchild that holds no pipe: only a signal to the whole group reaches it.
    # The leader ends on SIGTERM, but its grandchild ignores it and holds no pipe (#5878 review).
    if [ "$PULL" = orphan ]; then (trap '' TERM; exec sleep 60) >/dev/null 2>&1 & echo $! > "$bin/grandchild.pid"; sleep 30; fi
    if [ "$PULL" = group ]; then sleep 60 >/dev/null 2>&1 & echo $! > "$bin/grandchild.pid"; trap '' TERM; wait $!; fi
    if [ "$PULL" = swap ]; then rm -r "$SWAP"; ln -s / "$SWAP"; fi
    if [ "$PULL" = fail ]; then echo "pull failed" >&2; exit 1; fi
    # Exits at once and leaves a member in its group (cleanup item 7).
    if [ "$PULL" = leave ]; then (trap '' TERM; exec sleep 60) >/dev/null 2>&1 & echo $! > "$bin/grandchild.pid"; fi ;;
  image) echo "{\\"org.xum.bugbash.inputs\\":\\"$LABEL\\"}" ;;
  # Lines of bin/containers: id name owner checkout. ps prints the ids that match every filter.
  ps) [ "$PS_RC" = 0 ] || exit 1
    n=""; o=""; c=""
    for a in "$@"; do case "$a" in
      name=*) n=\${a#name=^/}; n=\${n%"$"} ;;
      label=xum.bugbash.owner=*) o=\${a#label=xum.bugbash.owner=} ;;
      label=xum.bugbash.checkout=*) c=\${a#label=xum.bugbash.checkout=} ;;
    esac; done
    awk -v n="$n" -v o="$o" -v c="$c" '(n=="" || $2==n) && (o=="" || $3==o) && (c=="" || $4==c) {print $1}' "$bin/containers" ;;
  # Like \`docker run --rm --cidfile\`: the create registers the container and writes its ID,
  # and the container ends on stdin EOF (the lifeline). Modes that keep the registry line model
  # a container the daemon has not removed yet, so only cleanup removes it.
  run) p=""; for a in "$@"; do case "$p" in --name) n=$a ;; --label) l="\${l-} \${a#*=}" ;; --cidfile) cid=$a ;; esac; p=$a; done
    id=$(printf '%064x' $$)
    if [ "$RUN" = die ]; then echo "create failed" >&2; exit 125; fi
    if [ "$RUN" = slowcreate ]; then sleep 1; fi
    if [ "$RUN" = swap ]; then echo "$id xbb-other other:pid abc" >> "$bin/containers"; else echo "$id $n$l" >> "$bin/containers"; fi
    echo "$id" > "$cid"; echo "created $id" >> "$bin/calls.log"
    case "$RUN" in
      stuck) trap '' TERM; exec sleep 30 ;;
      slowcreate|swap) cat >/dev/null; exit 0 ;;
      hang) cat >/dev/null; echo "stdin closed" >> "$bin/calls.log"; unregister "$id"; exit 0 ;;
      badframe) printf 'not a frame\n'; cat >/dev/null; unregister "$id"; exit 0 ;;
    esac
    printf '{"p":"app.log","n":2}\nok'; [ "$RUN" = cut ] || printf '{"end":true}\n'
    [ "$RUN" = linger ] || unregister "$id"; exit 7 ;;
  # container inspect --format <name|owner|checkout> <id>
  container) [ "$INSPECT_RC" = 0 ] || { echo "daemon down" >&2; exit 1; }
    for id in "$@"; do :; done
    awk -v id="$id" '$1==id {print "/" $2 "|" $3 "|" $4; f=1} END {exit !f}' "$bin/containers" ||
      { echo "Error response from daemon: No such container: $id" >&2; exit 1; } ;;
  rm) shift 2; [ "\${RM-}" = slow ] && sleep 1; [ "\${RM-}" = noop ] && exit 0; for id in "$@"; do unregister "$id"; done ;;
  *) exit 9 ;;
esac
`;

let root = "";
let bin = "";
let key = "";
const savedPath = process.env.PATH;
const savedTmp = process.env.TMPDIR;
let tmp = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-runner-"));
  fs.mkdirSync(path.join(root, SANDBOX), { recursive: true });
  for (const name of ["build.sh", "Dockerfile"])
    fs.copyFileSync(path.join(import.meta.dir, name), path.join(root, SANDBOX, name));
  fs.writeFileSync(
    path.join(root, "bun.lock"),
    '"@e2e-dev/web/playwright-core": ["playwright-core@1.63.0", ""],\n'
  );
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"],
  ])
    expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
  key = spawnSync(path.join(root, SANDBOX, "build.sh"), ["--key"], {
    encoding: "utf8",
  }).stdout.trim();
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  lock(key);
  bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "containers"), "");
  fake();
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  // The private client folders of this test go here, so a leak shows.
  tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp);
  process.env.TMPDIR = tmp;
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.cleanup()));
  process.env.PATH = savedPath;
  process.env.TMPDIR = savedTmp;
  fs.rmSync(root, { recursive: true, force: true });
});

function lock(inputsKey: string, digest = DIGEST) {
  const record = {
    image: "ghcr.io/coder/xum-bugbash-sandbox",
    digest,
    inputsKey,
    playwrightCore: "1.63.0",
    publishedFrom: "7".repeat(40),
  };
  fs.writeFileSync(path.join(root, SANDBOX, "image.json"), JSON.stringify(record));
}
function fake(over: Record<string, string> = {}) {
  const vars = {
    HOST: "unix:///var/run/docker.sock",
    INFO: '{"OSType":"linux","OperatingSystem":"Ubuntu 22.04","SecurityOptions":["name=seccomp"]}',
    IMAGES_RC: "0",
    IMAGES: "",
    PULL: "ok",
    LABEL: key,
    PS_RC: "0",
    INSPECT_RC: "0",
    RUN: "ok",
    ...over,
  };
  fs.writeFileSync(
    path.join(bin, "fake.env"),
    Object.entries(vars)
      .map(([k, v]) => `${k}='${v}'\n`)
      .join("")
  );
}
const calls = () =>
  fs.existsSync(path.join(bin, "calls.log"))
    ? fs.readFileSync(path.join(bin, "calls.log"), "utf8")
    : "";
/** The error a promise rejects with (`expect().rejects` is not typed as awaitable here). */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => () => undefined,
    (e: unknown) => () => {
      throw e;
    }
  );
// Every session gets cleaned up, so no private client folder stays behind.
const sessions: Session[] = [];
const session = (stop = new AbortController(), graceMs?: number) => {
  const s = new Session(stop.signal, { root, graceMs, log: () => undefined });
  sessions.push(s);
  return s;
};

test("the committed image.json is a valid lock, and a malformed one refuses", () => {
  expect(readImageLock().digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  lock(key, "sha256:short");
  expect(() => readImageLock(root)).toThrow(Refusal);
});

test("a stale inputs key refuses before any docker command", async () => {
  lock("0".repeat(64));
  expect(await failure(session().ensureImage())).toThrow(/stale image/);
  await Bun.sleep(0);
  expect(calls()).toBe("");
});

test("a missing image is pulled by digest, with a private client config", async () => {
  const s = session();
  expect(await s.ensureImage()).toBe(REF);
  const lines = calls().trim().split("\n");
  expect(lines.map((l) => l.split(" ")[0])).toEqual(["context", "info", "images", "pull", "image"]);
  expect(lines[3]).toStartWith(`pull --quiet ${REF} `);
  // After `context inspect`, docker gets no HOME and an empty config folder that cleanup removes.
  const cfg = /cfg=(\S+)\]/.exec(lines[2])![1];
  expect(lines[2]).toContain("[home= ");
  expect(fs.readdirSync(cfg)).toEqual([]);
  expect(await s.cleanup()).toBe("none");
  expect(fs.existsSync(cfg)).toBe(false);
});

test("a present image is not pulled", async () => {
  fake({ IMAGES: "sha256:abc" });
  expect(await session().ensureImage()).toBe(REF);
  expect(calls()).not.toContain("pull");
});

test.each([
  [
    "a label for other inputs",
    { IMAGES: "sha256:abc", LABEL: "f".repeat(64) },
    /label org.xum.bugbash.inputs/,
  ],
  ["an image query failure (not 'absent')", { IMAGES_RC: "1" }, /docker images: daemon down/],
  ["a remote endpoint", { HOST: "tcp://10.0.0.1:2375" }, /not a local socket/],
  ["no daemon", { INFO: '{"OSType":""}' }, /no daemon answered/],
  [
    "Docker Desktop",
    { INFO: '{"OSType":"linux","OperatingSystem":"Docker Desktop"}' },
    /Docker Desktop/,
  ],
  [
    "rootless Docker",
    { INFO: '{"OSType":"linux","SecurityOptions":["name=rootless"]}' },
    /rootless/,
  ],
])("%s refuses, and nothing is pulled", async (_name, over, message) => {
  fake(over);
  expect(await failure(session().ensureImage())).toThrow(message);
  await Bun.sleep(50);
  expect(calls()).not.toContain("pull");
});

const JOB = { name: "xbb-1", owner: "boot:pid", checkout: "abc" };
const FOREIGN = ["c2 xbb-1 other:pid abc", "c3 xbb-1 boot:pid other", "c4 xbb-2 boot:pid abc"];

test("a stop ends a running pull; cleanup removes only the owned container, no image", async () => {
  fake({ PULL: "hang" });
  fs.writeFileSync(
    path.join(bin, "containers"),
    ["c1 xbb-1 boot:pid abc", ...FOREIGN].join("\n") + "\n"
  );
  const stop = new AbortController();
  const s = session(stop);
  const pending = s.ensureImage();
  while (!calls().includes("pull ")) await Bun.sleep(20);
  s.own(JOB);
  const stoppedAt = Date.now();
  stop.abort("SIGTERM");
  // The fake pull ignores SIGTERM, so it ends only by SIGKILL after the grace period.
  expect(await pending.catch((e: unknown) => e)).toEqual(new Stopped("SIGTERM"));
  expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(4_500);
  expect(await failure(s.ensureImage())).toThrow(Stopped);
  expect(await s.cleanup()).toBe("removed");
  expect(fs.readFileSync(path.join(bin, "containers"), "utf8").trim().split("\n")).toEqual(FOREIGN);
  expect(calls()).not.toMatch(/^(rmi|image rm|image prune|system prune)/m);
  expect(fs.readdirSync(tmp)).toEqual([]);
}, 15_000);

test("cleanup reports an unknown container state, never success", async () => {
  fake({ IMAGES: "sha256:abc", PS_RC: "1" });
  const s = session();
  await s.ensureImage();
  s.own(JOB);
  expect(await s.cleanup()).toStartWith("unknown: ");
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.each([
  ["the leader also ignores SIGTERM", "group"],
  ["the leader exits on SIGTERM and leaves an orphan", "orphan"],
])(
  "#5877 item 1: a stop also ends the grandchildren (%s)",
  async (_name, shape) => {
    fake({ PULL: shape });
    const stop = new AbortController();
    const s = session(stop);
    const pending = s.ensureImage();
    const pidFile = path.join(bin, "grandchild.pid");
    while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim() === "")
      await Bun.sleep(20);
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    stop.abort("SIGTERM");
    expect(await failure(pending)).toThrow(Stopped);
    // cleanup() returns only once the whole group is gone.
    expect(await s.cleanup()).toBe("none");
    const survived = alive(grandchild);
    if (survived) process.kill(grandchild, "SIGKILL");
    expect(survived).toBe(false);
  },
  20_000
);

test("#5877 item 2: cleanup handles the owned job exactly once; own() after a stop refuses", async () => {
  fake({ IMAGES: "sha256:abc" });
  fs.writeFileSync(path.join(bin, "containers"), "c1 xbb-1 boot:pid abc\n");
  const s = session();
  await s.ensureImage();
  s.own(JOB);
  expect(() => s.own(JOB)).toThrow("one job only");
  const first = s.cleanup();
  expect(s.cleanup()).toBe(first);
  expect(await first).toBe("removed");
  expect(calls().match(/^rm -f /gm)).toHaveLength(1);

  const late = session();
  await late.ensureImage();
  expect(await late.cleanup()).toBe("none");
  expect(() => late.own(JOB)).toThrow(Stopped);
});

test("own() keeps a copy: a later change to the caller's job object changes nothing", async () => {
  fake({ IMAGES: "sha256:abc" });
  fs.writeFileSync(
    path.join(bin, "containers"),
    ["c1 xbb-1 boot:pid abc", ...FOREIGN].join("\n") + "\n"
  );
  const s = session();
  await s.ensureImage();
  const job = { ...JOB };
  s.own(job);
  job.name = "xbb-2";
  expect(await s.cleanup()).toBe("removed");
  expect(fs.readFileSync(path.join(bin, "containers"), "utf8").trim().split("\n")).toEqual(FOREIGN);
});

test("#5877 items 3 and 5: no owned job is 'none'; a regex-like name refuses", async () => {
  expect(await session().cleanup()).toBe("none");
  fake({ IMAGES: "sha256:abc" });
  const s = session();
  await s.ensureImage();
  expect(() => s.own({ ...JOB, name: "xbb.1" })).toThrow(Refusal);
  expect(() => session().own(JOB)).toThrow("ensureImage() first");
});

test("#5877 item 4: a stop during the endpoint lookup leaves no private client folder", async () => {
  fake({ CONTEXT: "hang" });
  const stop = new AbortController();
  const s = session(stop);
  const pending = s.ensureImage();
  while (!calls().includes("context ")) await Bun.sleep(20);
  stop.abort("SIGINT");
  expect(await failure(pending)).toThrow(Stopped);
  expect(await s.cleanup()).toBe("none");
  expect(fs.readdirSync(tmp)).toEqual([]);
}, 15_000);

// Cleanup of the job container (#5930, plan PR C): the Session API with the fake `docker run`.
const registry = () => fs.readFileSync(path.join(bin, "containers"), "utf8");
const drain = (out: NodeJS.ReadableStream) =>
  new Promise<void>((resolve) => out.on("data", () => undefined).on("end", resolve));
async function jobSession(over: Record<string, string>, graceMs?: number) {
  fake({ IMAGES: "sha256:abc", ...over });
  const stop = new AbortController();
  const s = session(stop, graceMs);
  await s.ensureImage();
  s.own(JOB);
  const job = s.runJob(["--rm", "img"], drain, 60_000);
  job.catch(() => undefined);
  while (!calls().includes("run ")) await Bun.sleep(20);
  return { s, stop, job };
}

test("C1: a stop during the create never signals `docker run`; cleanup removes the ID", async () => {
  const { s, stop, job } = await jobSession({ RUN: "slowcreate" });
  stop.abort("SIGTERM");
  await job;
  const id = /created (\w+)/.exec(calls())![1];
  expect(await s.cleanup()).toBe("removed");
  expect(calls()).toContain(`rm -f ${id}`);
  expect(registry()).not.toContain(id);
});

test("C2: a client that ignores the lifeline is killed after the grace period", async () => {
  const { s, stop, job } = await jobSession({ RUN: "stuck" }, 300);
  while (!calls().includes("created ")) await Bun.sleep(20);
  stop.abort("SIGTERM");
  const started = Date.now();
  await job;
  expect(Date.now() - started).toBeLessThan(4_000); // the grace, not the 5 s TERM-to-KILL
  expect(await s.cleanup()).toBe("removed");
  expect(registry()).toBe("");
});

test.each([
  ["no container", "", "unknown"],
  ["a container with our name and labels", "c1 xbb-1 boot:pid abc\n", "removed"],
  ["a foreign container with our name", "c2 xbb-1 other:pid abc\n", "unknown"],
])("C3: `docker run` dies before the cidfile, %s", async (_name, present, state) => {
  fs.writeFileSync(path.join(bin, "containers"), present);
  const { s, job } = await jobSession({ RUN: "die" });
  expect((await job).code).toBe(125);
  expect(await s.cleanup()).toStartWith(state);
  expect(registry()).toBe(present.startsWith("c1") ? "" : present);
});

test.each([
  ["inspect fails", { RUN: "linger", INSPECT_RC: "1" }],
  ["the cidfile names a container with other labels", { RUN: "swap" }],
])("C5/C6: %s: the container stays, state unknown", async (_name, over) => {
  const { s, stop, job } = await jobSession(over);
  stop.abort("SIGTERM");
  await job;
  const id = /created (\w+)/.exec(calls())![1];
  expect(await s.cleanup()).toStartWith("unknown");
  expect(registry()).toContain(id);
  expect(calls()).not.toContain("rm -f");
});

test("C7: a member that no leader vouched for gets no signal; the state is unknown", async () => {
  fake({ PULL: "leave" });
  const s = session();
  await s.ensureImage();
  s.own(JOB);
  const grandchild = Number(fs.readFileSync(path.join(bin, "grandchild.pid"), "utf8"));
  try {
    expect(alive(grandchild)).toBe(true);
    // Its leader exited before any check saw it, so it may be a stranger in a reused group.
    expect(await s.cleanup()).toStartWith("unknown: process groups");
    expect(alive(grandchild)).toBe(true);
  } finally {
    process.kill(grandchild, "SIGKILL");
  }
});

test("a tracked group whose members all exited is never signalled (its ID can be reused)", async () => {
  fake({ PULL: "leave" });
  const signals: string[] = [];
  const s = new Session(new AbortController().signal, {
    root,
    log: () => undefined,
    signalGroup: (group, signal) => signals.push(`${group} ${signal}`),
  });
  sessions.push(s);
  await s.ensureImage();
  // The group of `pull` is still tracked: its member outlived the leader. Now it exits too.
  const grandchild = Number(fs.readFileSync(path.join(bin, "grandchild.pid"), "utf8"));
  process.kill(grandchild, "SIGKILL");
  while (fs.existsSync(`/proc/${grandchild}`) && !/\) [ZX] /.test(stat(grandchild)))
    await Bun.sleep(10);
  expect(await s.cleanup()).toBe("none");
  expect(signals).toEqual([]);
});
const stat = (pid: number) => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return "";
  }
};

test("groupState tells our group from an emptied or reused group ID", () => {
  const proc = path.join(root, "proc");
  // pid (comm) state ppid pgrp, then fields up to the start time (field 22).
  const proc_ = (pid: number, state: string, pgrp: number, start: number) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    const rest = Array.from({ length: 16 }, () => "0").join(" ");
    fs.writeFileSync(
      path.join(proc, String(pid), "stat"),
      `${pid} (a b) ${state} 1 ${pgrp} ${rest} ${start} 0\n`
    );
  };
  fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, "uptime"), "1 1\n"); // not a pid: skipped
  const known = new Set<string>();
  const state = () => groupState(100, "500", known, proc);
  const gone = (pid: number) => fs.rmSync(path.join(proc, String(pid)), { recursive: true });
  expect(state()).toBe("none");
  proc_(101, "S", 100, 600); // a member, but no leader ever vouched for it
  expect(state()).toBe("unproved");
  proc_(100, "S", 100, 500); // our leader, by its start time: its members become known
  expect(state()).toBe("ours");
  expect([...known].sort()).toEqual(["100:500", "101:600"]);
  gone(100); // the leader exited; its known member stays ours
  expect(state()).toBe("ours");
  proc_(102, "S", 100, 700); // a member that no leader vouched for
  expect(state()).toBe("unproved");
  gone(101);
  gone(102);
  proc_(100, "S", 100, 900); // our group emptied, and another process got its ID
  expect(state()).toBe("reused");
  proc_(100, "Z", 100, 900); // that leader exited and waits for its parent; its child stays
  proc_(103, "S", 100, 950);
  expect(state()).toBe("reused");
  gone(100); // that leader is reaped: only the stranger's child is left
  expect(state()).toBe("unproved");
  gone(103);
  proc_(100, "Z", 100, 500); // only our own zombie leader
  expect(state()).toBe("none");
  proc_(104, "S", 100, 960); // our zombie leader still vouches for a live member
  expect(state()).toBe("ours");
});

test.each([
  ["--name", "x"],
  ["--label", "a=b"],
  ["--label-file", "f"],
  ["--cidfile", "f"],
  ["-l", "a=b"],
])("C9: the caller flag %s refuses before `docker run`", async (name, value) => {
  fake({ IMAGES: "sha256:abc" });
  const s = session();
  await s.ensureImage();
  s.own(JOB);
  expect(await failure(s.runJob([name, value, "img"], drain, 1_000))).toThrow(Refusal);
  expect(calls()).not.toContain("run ");
});

test("C11: the stop hooks finish before the lifeline closes", async () => {
  const { s, stop, job } = await jobSession({ RUN: "hang" });
  s.onStop(async () => {
    await Bun.sleep(200);
    fs.appendFileSync(path.join(bin, "calls.log"), "hook done\n");
  });
  stop.abort("SIGTERM");
  await job;
  const log = calls();
  expect(log.indexOf("hook done")).toBeGreaterThan(-1);
  expect(log.indexOf("hook done")).toBeLessThan(log.indexOf("stdin closed"));
  expect(await s.cleanup()).toBe("removed");
});

// launch.ts, with the same fake docker: a checkout with a repro config and both mount sources.
const ARGS = ["run", "--config", "e2e.config.ts", "--output", ".e2e/r"];
const HOST_ENV = { BUGBASH_AI: "mock", ANTHROPIC_API_KEY: "sk-secret", BUGBASH_APP_LOG: "/x.log" };
function launchIn(
  over: Record<string, string> = {},
  stop = new AbortController(),
  env: Record<string, string> = HOST_ENV,
  leftovers: string[] = []
) {
  const real = fs.realpathSync(root);
  fs.mkdirSync(path.join(real, "tests/bugbash"), { recursive: true });
  fs.writeFileSync(path.join(real, "tests/bugbash/e2e.config.ts"), "export default {}");
  for (const dir of ["dist", "node_modules"])
    fs.mkdirSync(path.join(real, dir), { recursive: true });
  fs.writeFileSync(path.join(bin, "containers"), [...FOREIGN, ...leftovers].join("\n") + "\n");
  fake({ IMAGES: "sha256:abc", SWAP: path.join(real, "node_modules"), ...over });
  const cwd = path.join(real, "tests/bugbash");
  return launch(ARGS, { root: real, cwd, env, stop: stop.signal });
}
/** Nothing of a job stays: no container, no job folder, no private client folder, no image rm. */
function expectNothingLeft() {
  expect(fs.readFileSync(path.join(bin, "containers"), "utf8").trim().split("\n")).toEqual(FOREIGN);
  const left = fs.readdirSync(tmp, { recursive: true }).map(String);
  expect(left.filter((p) => /xbb-|xum-bugbash-docker/.test(p))).toEqual([]);
  expect(calls()).not.toMatch(/^(rmi|image rm|image prune|system prune)/m);
}

test("a repro job runs in the locked-down container; the export comes back; cleanup removes it", async () => {
  expect(await launchIn()).toBe(7);
  expect(fs.readFileSync(path.join(root, "tests/bugbash/.e2e/r/app.log"), "utf8")).toBe("ok");
  const run = calls()
    .split("\n")
    .find((line) => line.startsWith("run "))!;
  for (const flag of ["--network none", "--read-only", "--cap-drop ALL", "--interactive --init"])
    expect(run).toContain(flag);
  const real = fs.realpathSync(root);
  expect(run).toContain(
    `--mount type=bind,src=${real}/node_modules,dst=/repo/node_modules,readonly`
  );
  // The app log stays in the export folder; no host credential and no host log path pass.
  expect(run).toContain("--env BUGBASH_APP_LOG=.e2e/r/app.log");
  expect(run).toContain("--env BUGBASH_CONTAINER=1");
  expect(run).toContain("--env BUGBASH_AI_RESOLVED=mock");
  expect(run).not.toMatch(/sk-secret|\/x\.log/);
  expectNothingLeft();
});

test("an export without its end frame is incomplete evidence (exit 4)", async () => {
  expect(await launchIn({ RUN: "cut" })).toBe(4);
  expectNothingLeft();
});

test("an unknown container state after cleanup outranks the job's result (exit 3)", async () => {
  expect(await launchIn({ RUN: "linger", INSPECT_RC: "1" })).toBe(3);
});

test.each([
  ["before the launch", {}, null],
  ["during the endpoint lookup", { CONTEXT: "hang" }, "context "],
  ["during the pull", { IMAGES: "", PULL: "hang" }, "pull "],
  ["while the job runs", { RUN: "hang" }, "run "],
])(
  "a stop %s leaves nothing behind",
  async (_name, over, marker) => {
    const stop = new AbortController();
    if (marker == null) stop.abort("SIGTERM");
    const pending = launchIn(over, stop);
    while (marker != null && !calls().includes(marker)) await Bun.sleep(20);
    stop.abort("SIGTERM");
    expect(await failure(pending)).toThrow(Stopped);
    if (marker !== "run ") expect(calls()).not.toContain("run ");
    expectNothingLeft();
  },
  15_000
);

test("C4: a refused export frame ends the job at once, not at the deadline", async () => {
  const started = Date.now();
  expect(await launchIn({ RUN: "badframe" })).toBe(4);
  expect(Date.now() - started).toBeLessThan(10_000);
  expectNothingLeft();
});

test("C8: a stop during cleanup does not cut `docker rm`; the stop decides the exit", async () => {
  const stop = new AbortController();
  const pending = launchIn({ RUN: "linger", RM: "slow" }, stop);
  while (!calls().includes("rm -f ")) await Bun.sleep(20);
  stop.abort("SIGTERM");
  expect(await pending.catch((e: unknown) => e)).toEqual(new Stopped("SIGTERM"));
  expectNothingLeft();
}, 15_000);

// Crash leftovers (#5882, plan PR C2). Owner labels are boot ID : PID namespace : PID : start.
const procStart = (pid: number | string) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
const self = () => ({
  boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  pidns: fs.readlinkSync("/proc/self/ns/pid").replace(/\D/g, ""),
});
/** A PID above the kernel's limit, so no process has it. */
const NO_PID = Number(fs.readFileSync("/proc/sys/kernel/pid_max", "utf8")) + 1;
function leftovers() {
  const checkout = crypto
    .createHash("sha256")
    .update(fs.realpathSync(root))
    .digest("hex")
    .slice(0, 12);
  const { boot, pidns } = self();
  const id = (n: number) => n.toString(16).padStart(64, "0");
  const name = (hex: string) => `xbb-${checkout.slice(0, 6)}-${hex}`;
  const live = `${boot}:${pidns}:${process.pid}:${procStart(process.pid)}`;
  const lines = {
    dead: `${id(1)} ${name("aaaaa1")} ${boot}:${pidns}:${NO_PID}:1 ${checkout}`,
    restarted: `${id(2)} ${name("aaaaa2")} ${boot}:${pidns}:${process.pid}:1 ${checkout}`,
    live: `${id(3)} ${name("aaaaa3")} ${live} ${checkout}`,
    otherPidns: `${id(4)} ${name("aaaaa4")} ${boot}:1:${NO_PID}:1 ${checkout}`,
    otherBoot: `${id(5)} ${name("aaaaa5")} other-boot:${pidns}:${NO_PID}:1 ${checkout}`,
    otherName: `${id(6)} xbb-other ${boot}:${pidns}:${NO_PID}:1 ${checkout}`,
    otherCheckout: `${id(7)} ${name("aaaaa7")} ${boot}:${pidns}:${NO_PID}:1 ${"e".repeat(12)}`,
  };
  return { checkout, lines };
}

test("ownerState: dead, alive, or cannot tell", () => {
  const { boot, pidns } = self();
  expect(ownerState(`${boot}:${pidns}:${process.pid}:${procStart(process.pid)}`)).toBe("alive");
  expect(ownerState(`${boot}:${pidns}:${NO_PID}:1`)).toBe("dead");
  expect(ownerState(`${boot}:${pidns}:${process.pid}:1`)).toBe("dead"); // the PID was reused
  for (const owner of [
    `x:${pidns}:${NO_PID}:1`,
    `${boot}:1:${NO_PID}:1`,
    "garbage",
    `${boot}:${pidns}:-1:1`,
  ])
    expect(ownerState(owner)).toBe("cannot tell");
});

test("C2: a launch lists the leftovers of its checkout and removes nothing", async () => {
  const { lines } = leftovers();
  const all = Object.values(lines);
  const logged: string[] = [];
  const error = spyOn(console, "error").mockImplementation(
    (line: string) => void logged.push(line)
  );
  try {
    expect(await launchIn({}, new AbortController(), HOST_ENV, all)).toBe(7);
  } finally {
    error.mockRestore();
  }
  const listed = logged.filter((line) => line.includes("leftover: "));
  expect(
    listed.map((line) => line.replace(/^sandbox leftover: (\S+) owner (.+?) \(.*$/, "$1 $2"))
  ).toEqual(
    [
      lines.dead,
      lines.restarted,
      lines.live,
      lines.otherPidns,
      lines.otherBoot,
      lines.otherName,
    ].map(
      (line, i) =>
        `${line.split(" ")[1]} ${["dead", "dead", "alive", "cannot tell", "cannot tell", "dead"][i]}`
    )
  );
  expect(registry().trim().split("\n")).toEqual([...FOREIGN, ...all]);
});

test("C2: recover removes only dead owners of this checkout with a job name, by ID", async () => {
  const { lines } = leftovers();
  fs.writeFileSync(path.join(bin, "containers"), Object.values(lines).join("\n") + "\n");
  fake();
  const real = fs.realpathSync(root);
  const logged: string[] = [];
  const o = { root: real, cwd: real, env: {}, stop: new AbortController().signal };
  expect(await recover({ ...o, log: (line) => logged.push(line) })).toBe(0);
  const left = [
    lines.live,
    lines.otherPidns,
    lines.otherBoot,
    lines.otherName,
    lines.otherCheckout,
  ];
  expect(registry().trim().split("\n")).toEqual(left);
  expect(logged[0]).toStartWith("recover: docker endpoint unix:///var/run/docker.sock");
  // Removal is by ID only, after an inspect, and nothing is built or pulled.
  const ids = [1, 2].map((n) => n.toString(16).padStart(64, "0"));
  expect([...(calls().match(/^rm -f \w+/gm) ?? [])]).toEqual(ids.map((id) => `rm -f ${id}`));
  expect(calls()).not.toMatch(/^(images|pull|image |run )/m);
  expect(fs.readdirSync(tmp)).toEqual([]);
});

test("C2: recover reports a removal it cannot prove (exit 3)", async () => {
  const { lines } = leftovers();
  fs.writeFileSync(path.join(bin, "containers"), lines.dead + "\n");
  fake({ RM: "noop" });
  const real = fs.realpathSync(root);
  const o = {
    root: real,
    cwd: real,
    env: {},
    stop: new AbortController().signal,
    log: () => undefined,
  };
  expect(await recover(o)).toBe(3);
});

test("C2: a zombie launcher counts as dead", async () => {
  // `sleep 0` exits at once, and its parent then execs `sleep 30`, which never reaps it.
  const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const pid = Number(
      await new Promise<string>((resolve) =>
        parent.stdout.once("data", (d: Buffer) => resolve(d.toString()))
      )
    );
    while (!stat(pid).includes(") Z ")) await Bun.sleep(10);
    const { boot, pidns } = self();
    expect(ownerState(`${boot}:${pidns}:${pid}:${procStart(pid)}`)).toBe("dead");
  } finally {
    parent.kill("SIGKILL");
  }
});

test("C2: a launch lists the leftovers even when the image pull fails", async () => {
  const { lines } = leftovers();
  const logged: string[] = [];
  const error = spyOn(console, "error").mockImplementation(
    (line: string) => void logged.push(line)
  );
  try {
    const result = await launchIn({ IMAGES: "", PULL: "fail" }, new AbortController(), HOST_ENV, [
      lines.dead,
    ]).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(Refusal);
  } finally {
    error.mockRestore();
  }
  expect(
    logged.some((line) => line.includes(`leftover: ${lines.dead.split(" ")[1]} owner dead`))
  ).toBe(true);
});

test("C2: recover refuses when a listed container cannot be inspected", async () => {
  const { lines } = leftovers();
  fs.writeFileSync(path.join(bin, "containers"), lines.dead + "\n");
  fake({ INSPECT_RC: "1" });
  const real = fs.realpathSync(root);
  const o = {
    root: real,
    cwd: real,
    env: {},
    stop: new AbortController().signal,
    log: () => undefined,
  };
  expect(await failure(recover(o))).toThrow(/docker container inspect: daemon down/);
  expect(registry()).toBe(lines.dead + "\n");
});

test("C2: a stop during recover starts no further removal", async () => {
  const { lines } = leftovers();
  const second = lines.dead.replace(/^\w+/, "f".repeat(64)).replace("aaaaa1", "aaaaaf");
  fs.writeFileSync(path.join(bin, "containers"), [lines.dead, second].join("\n") + "\n");
  fake();
  const real = fs.realpathSync(root);
  const stop = new AbortController();
  const log = (line: string) => line.endsWith(" removed") && stop.abort("SIGTERM");
  const o = { root: real, cwd: real, env: {}, stop: stop.signal, log };
  expect(await recover(o).catch((e: unknown) => e)).toEqual(new Stopped("SIGTERM"));
  expect(registry()).toBe(second + "\n"); // the first removal finished, the second never started
});

test("C2: recover reports an unknown cleanup state (exit 3)", async () => {
  fs.writeFileSync(path.join(bin, "containers"), "");
  fake();
  const real = fs.realpathSync(root);
  const cleanup = spyOn(Session.prototype, "cleanup").mockResolvedValue(
    "unknown: process groups 1 still run"
  );
  try {
    const o = {
      root: real,
      cwd: real,
      env: {},
      stop: new AbortController().signal,
      log: () => undefined,
    };
    expect(await recover(o)).toBe(3);
  } finally {
    cleanup.mockRestore();
  }
});

test("a signal during the synchronous staging starts no container", async () => {
  const stop = new AbortController();
  // containerEnv reads BUGBASH_EFFORT right after staging, still synchronously. A real signal
  // there runs its handler at the next turn of the event loop, as this setImmediate does.
  const env = new Proxy(HOST_ENV as Record<string, string>, {
    get(target, key) {
      if (key === "BUGBASH_EFFORT") setImmediate(() => stop.abort("SIGTERM"));
      return target[key as string];
    },
  });
  // A spy, not the fake's log: a SIGTERM can end the fake before it writes its log line.
  const runJob = spyOn(Session.prototype, "runJob"); // calls through
  expect(await failure(launchIn({}, stop, env))).toThrow(Stopped);
  expect(runJob).not.toHaveBeenCalled();
  runJob.mockRestore();
  expectNothingLeft();
});

test("a mount source that becomes a symlink before `docker run` refuses; nothing starts", async () => {
  expect(await failure(launchIn({ IMAGES: "", PULL: "swap" }))).toThrow(/not a symlink/);
  expect(calls()).not.toContain("run ");
  expectNothingLeft();
});

test.each([
  ["`e2e explore`", ["explore", "--config", "e2e.config.ts"], /not `e2e run`/],
  ["an existing output folder", ARGS, /exists: remove it first/],
])("%s refuses before any docker command", async (_name, args, message) => {
  fs.mkdirSync(path.join(root, "tests/bugbash/.e2e/r"), { recursive: true });
  const real = fs.realpathSync(root);
  const o = { root: real, cwd: path.join(real, "tests/bugbash"), env: { BUGBASH_AI: "mock" } };
  fs.writeFileSync(path.join(real, "tests/bugbash/e2e.config.ts"), "export default {}");
  expect(await failure(launch(args, { ...o, stop: new AbortController().signal }))).toThrow(
    message
  );
  expect(calls()).toBe("");
});

// Every non-mock mode refuses before any docker command, so before the container env exists and
// before a job starts. Real mode waits for the provider proxy (#5714): no key enters the sandbox.
const NOT_MOCK = [
  {},
  { BUGBASH_AI: "auto" },
  { BUGBASH_AI: "real" },
  { BUGBASH_AI: "mock", BUGBASH_AI_RESOLVED: "real" },
  { BUGBASH_AI: "real", BUGBASH_AI_RESOLVED: "mock" },
  { BUGBASH_AI_RESOLVED: "real" },
  { BUGBASH_AI_RESOLVED: "" },
];
test.each(NOT_MOCK)("the mode %j refuses before any docker command", async (mode) => {
  const env = { ...HOST_ENV, BUGBASH_AI: "", ...mode } as Record<string, string>;
  if (env.BUGBASH_AI === "") delete env.BUGBASH_AI;
  expect(await failure(launchIn({}, new AbortController(), env))).toThrow(/only the mock app AI/);
  expect(calls()).toBe("");
  expectNothingLeft();
});

test("the command line refuses an ambient BUGBASH_AI_RESOLVED=real before any docker command", () => {
  const dir = path.join(import.meta.dir, "..");
  const output = `.e2e/xbb-test-${process.pid}`;
  const cli = spawnSync(
    process.execPath,
    ["sandbox/launch.ts", "--", ...ARGS.slice(0, 3), "--output", output],
    {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, TMPDIR: tmp, BUGBASH_AI: "mock", BUGBASH_AI_RESOLVED: "real" },
    }
  );
  expect(cli.stderr).toContain("only the mock app AI");
  expect(cli.status).toBe(2);
  expect(calls()).toBe("");
  expect(fs.existsSync(path.join(dir, output))).toBe(false);
});
