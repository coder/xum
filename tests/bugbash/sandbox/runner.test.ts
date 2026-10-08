import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launch } from "./launch";
import { readImageLock, Refusal, Session, Stopped } from "./runner";

// Each test runs the real build.sh in a throwaway git repo and a fake `docker` on PATH. The
// runner gives docker a stripped env, so the fake reads its answers from bin/fake.env.
const SANDBOX = "tests/bugbash/sandbox";
const DIGEST = `sha256:${"61".repeat(32)}`;
const REF = `ghcr.io/coder/xum-bugbash-sandbox@${DIGEST}`;
const FAKE = `#!/bin/sh
bin=$(dirname "$0"); . "$bin/fake.env"
echo "$* [home=\${HOME-} cfg=\${DOCKER_CONFIG-}]" >> "$bin/calls.log"
# A started container's job: it writes the export stream on stdout.
job() { touch "$bin/started"
    if [ "$RUN" = hang ]; then exec sleep 30; fi
    if [ "$RUN" = early ]; then echo "not a header"; exec sleep 30; fi
    printf '{"p":"app.log","n":2}\nok'; [ "$RUN" = cut ] || printf '{"end":true}\n'; exit 7; }
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
    if [ "$PULL" = swap ]; then rm -r "$SWAP"; ln -s / "$SWAP"; fi ;;
  image) echo "{\\"org.xum.bugbash.inputs\\":\\"$LABEL\\"}" ;;
  # Lines of bin/containers: id name owner checkout.
  # The fake daemon: create and run register "ctr <name> <owner> <checkout>", only rm removes
  # it. CREATE=late: the daemon lands it 0.5 s after the request, outside the CLI's process
  # group, and the CLI answers at 1 s. Killing that CLI does not cancel the daemon's create.
  run|create) p=""; for a in "$@"; do case "$p" in --name) n=$a ;; --label) l="\${l-} \${a#*=}" ;; esac; p=$a; done
    if [ "\${CREATE-}" = die ]; then kill -9 $$; fi
    if [ "\${CREATE-}" = late ]; then setsid sh -c "sleep 0.5; echo 'ctr $n$l' >> '$bin/containers'" </dev/null >/dev/null 2>&1 & sleep 1
    else echo "ctr $n$l" >> "$bin/containers"; fi
    if [ "$1" = create ]; then echo ctr; exit 0; fi
    job ;;
  start) job ;;
  container) [ "\${INSPECT_RC-0}" = 0 ] || { echo "daemon down" >&2; exit 1; }
    if [ "\${INSPECT_SLOW-}" = 1 ]; then sleep 1; fi
    for ref; do :; done
    awk -v r="$ref" '$1==r || $2==r {print $1, "/" $2, $3, $4; f=1} END {exit !f}' "$bin/containers" ||
      { echo "Error response from daemon: No such container: $ref" >&2; exit 1; } ;;
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
// Names are unique on a daemon, so a foreign container never has the job's name.
const FOREIGN = ["c2 xbb-9 other:pid abc", "c3 xbb-8 boot:pid other", "c4 xbb-2 boot:pid abc"];

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
  fake({ IMAGES: "sha256:abc", INSPECT_RC: "1" });
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

// launch.ts, with the same fake docker: a checkout with a repro config and both mount sources.
const ARGS = ["run", "--config", "e2e.config.ts", "--output", ".e2e/r"];
const HOST_ENV = { BUGBASH_AI: "mock", ANTHROPIC_API_KEY: "sk-secret", BUGBASH_APP_LOG: "/x.log" };
function launchIn(
  over: Record<string, string> = {},
  stop = new AbortController(),
  env: Record<string, string> = HOST_ENV
) {
  const real = fs.realpathSync(root);
  fs.mkdirSync(path.join(real, "tests/bugbash"), { recursive: true });
  fs.writeFileSync(path.join(real, "tests/bugbash/e2e.config.ts"), "export default {}");
  for (const dir of ["dist", "node_modules"])
    fs.mkdirSync(path.join(real, dir), { recursive: true });
  fs.writeFileSync(path.join(bin, "containers"), FOREIGN.join("\n") + "\n");
  fake({ IMAGES: "sha256:abc", SWAP: path.join(real, "node_modules"), ...over });
  const cwd = path.join(real, "tests/bugbash");
  return launch(ARGS, { root: real, cwd, env, stop: stop.signal });
}
/** Nothing of a job stays: no container, no job folder, no private client folder, no image rm. */
function expectNothingLeft(survivors = FOREIGN) {
  expect(fs.readFileSync(path.join(bin, "containers"), "utf8").trim().split("\n")).toEqual(
    survivors
  );
  const left = fs.readdirSync(tmp, { recursive: true }).map(String);
  expect(left.filter((p) => /xbb-|xum-bugbash-(docker|sandbox)/.test(p))).toEqual([]);
  expect(calls()).not.toMatch(/^(rmi|image rm|image prune|system prune)/m);
}

test("a repro job runs in the locked-down container; the export comes back; cleanup removes it", async () => {
  expect(await launchIn()).toBe(7);
  expect(fs.readFileSync(path.join(root, "tests/bugbash/.e2e/r/app.log"), "utf8")).toBe("ok");
  const create = calls()
    .split("\n")
    .find((line) => line.startsWith("create "))!;
  for (const flag of ["--network none", "--read-only", "--cap-drop ALL", "-i --init"])
    expect(create).toContain(flag);
  const real = fs.realpathSync(root);
  expect(create).toContain(
    `--mount type=bind,src=${real}/node_modules,dst=/repo/node_modules,readonly`
  );
  // The app log stays in the export folder; no host credential and no host log path pass.
  expect(create).toContain("-e BUGBASH_APP_LOG=.e2e/r/app.log");
  expect(create).toContain("-e BUGBASH_CONTAINER=1");
  expect(create).toContain("-e BUGBASH_AI_RESOLVED=mock");
  expect(create).not.toMatch(/sk-secret|\/x\.log/);
  expectNothingLeft();
});

test("an export without its end frame is incomplete evidence (exit 4)", async () => {
  expect(await launchIn({ RUN: "cut" })).toBe(4);
  expectNothingLeft();
});

test("an unknown container state after cleanup outranks the job's result (exit 3)", async () => {
  expect(await launchIn({ INSPECT_RC: "1" })).toBe(3);
});

test.each([
  ["before the launch", {}, null],
  ["during the endpoint lookup", { CONTEXT: "hang" }, "context "],
  ["during the pull", { IMAGES: "", PULL: "hang" }, "pull "],
  ["while the job runs", { RUN: "hang" }, "start "],
])(
  "a stop %s leaves nothing behind",
  async (_name, over, marker) => {
    const stop = new AbortController();
    if (marker == null) stop.abort("SIGTERM");
    const pending = launchIn(over, stop);
    while (marker != null && !calls().includes(marker)) await Bun.sleep(20);
    stop.abort("SIGTERM");
    expect(await failure(pending)).toThrow(Stopped);
    if (marker !== "start ") expect(calls()).not.toContain("create ");
    expectNothingLeft();
  },
  15_000
);

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
  expect(calls()).not.toContain("create ");
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

test("runJob() refuses caller args that set the name or a label", async () => {
  fake({ IMAGES: "sha256:abc" });
  const s = session();
  await s.ensureImage();
  s.own(JOB);
  for (const arg of ["--name", "--name=x", "--label", "--label=a=b", "-l", "--label-file"])
    expect(await failure(s.runJob([arg, "img"], () => Promise.resolve(0), 1_000))).toThrow(
      /sets the name and labels itself/
    );
  expect(calls()).not.toContain("create ");
});

test("a receiver that gives up ends the job at once, not at the deadline (exit 4)", async () => {
  const started = Date.now();
  expect(await launchIn({ RUN: "early" })).toBe(4);
  expect(Date.now() - started).toBeLessThan(10_000);
  expectNothingLeft();
}, 20_000);

test("a signal during cleanup still ends with Stopped, and cleanup completes", async () => {
  const stop = new AbortController();
  const pending = launchIn({ INSPECT_SLOW: "1" }, stop);
  while (!calls().includes("container inspect ")) await Bun.sleep(20);
  stop.abort("SIGTERM");
  expect(await failure(pending)).toThrow(Stopped);
  expectNothingLeft();
}, 15_000);

// The window of a create: the stop lands while the daemon still creates the container, before
// the CLI has returned its ID. Only a create whose outcome is known may count as removed.
test.each([
  ["while the create request is in flight", "sent"],
  ["after the daemon created it, before its ID came back", "landed"],
])(
  "a stop %s: the job never starts, and cleanup removes it once",
  async (_name, when) => {
    const real = fs.realpathSync(root);
    const checkout = crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
    const sameCheckout = `c5 xbb-7 other:1 ${checkout}`; // same checkout, another owner
    const stop = new AbortController();
    const pending = launchIn({ CREATE: "late" }, stop);
    const containers = path.join(bin, "containers");
    fs.appendFileSync(containers, `${sameCheckout}\n`);
    if (when === "sent") while (!/^(run|create) /m.test(calls())) await Bun.sleep(10);
    else while (!fs.readFileSync(containers, "utf8").includes("ctr ")) await Bun.sleep(10);
    stop.abort("SIGTERM");
    expect(await failure(pending)).toThrow(Stopped);
    await Bun.sleep(700); // a create that the daemon still finishes lands by now
    expect(fs.existsSync(path.join(bin, "started"))).toBe(false);
    expect(calls().match(/^rm -f ctr /gm)).toHaveLength(1);
    expectNothingLeft([...FOREIGN, sameCheckout]);
  },
  20_000
);

test("a container with the job's name but other labels is not removed", async () => {
  fake({ IMAGES: "sha256:abc" });
  fs.writeFileSync(path.join(bin, "containers"), "c9 xbb-1 other:pid abc\n");
  const s = session();
  await s.ensureImage();
  s.own(JOB);
  expect(await s.cleanup()).toStartWith("unknown: xbb-1 is not this job's container");
  expect(calls()).not.toMatch(/^rm /m);
});

test("a create whose CLI died is an unknown outcome when no container has the name", async () => {
  fake({ IMAGES: "sha256:abc", CREATE: "die" });
  const s = session();
  await s.ensureImage();
  s.own(JOB);
  expect(await failure(s.runJob(["img"], () => Promise.resolve(0), 5_000))).toThrow(/create/);
  expect(await s.cleanup()).toBe("unknown: the create's outcome is unknown");
});
