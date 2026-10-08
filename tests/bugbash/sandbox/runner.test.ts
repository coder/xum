import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readImageLock, Refusal, Session, Stopped } from "./runner";

// Each test runs the real build.sh in a throwaway git repo and a fake `docker` on PATH. The
// runner gives docker a stripped env, so the fake reads its answers from bin/fake.env.
const SANDBOX = "tests/bugbash/sandbox";
const DIGEST = `sha256:${"61".repeat(32)}`;
const REF = `ghcr.io/coder/xum-bugbash-sandbox@${DIGEST}`;
const FAKE = `#!/bin/sh
bin=$(dirname "$0"); . "$bin/fake.env"
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
    if [ "$PULL" = group ]; then sleep 60 >/dev/null 2>&1 & echo $! > "$bin/grandchild.pid"; trap '' TERM; wait $!; fi ;;
  image) echo "{\\"org.xum.bugbash.inputs\\":\\"$LABEL\\"}" ;;
  # Lines of bin/containers: id name owner checkout. ps prints the ids that match every filter.
  ps) [ "$PS_RC" = 0 ] || exit 1
    n=""; o=""; c=""
    for a in "$@"; do case "$a" in
      name=*) n=\${a#name=^/}; n=\${n%"$"} ;;
      label=xum.bugbash.owner=*) o=\${a#label=xum.bugbash.owner=} ;;
      label=xum.bugbash.checkout=*) c=\${a#label=xum.bugbash.checkout=} ;;
    esac; done
    awk -v n="$n" -v o="$o" -v c="$c" '$2==n && $3==o && $4==c {print $1}' "$bin/containers" ;;
  rm) shift 2; for id in "$@"; do awk -v id="$id" '$1!=id' "$bin/containers" > "$bin/c.tmp"; mv "$bin/c.tmp" "$bin/containers"; done ;;
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
const session = (stop = new AbortController()) => {
  const s = new Session(stop.signal, { root });
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
