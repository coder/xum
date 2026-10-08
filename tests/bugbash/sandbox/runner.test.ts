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
  context) echo "$HOST" ;;
  info) echo "$INFO" ;;
  images) [ "$IMAGES_RC" = 0 ] || { echo "daemon down" >&2; exit 1; }; echo "$IMAGES" ;;
  pull) if [ "$PULL" = hang ]; then trap '' TERM; exec sleep 30; fi ;;
  image) echo "{\\"org.xum.bugbash.inputs\\":\\"$LABEL\\"}" ;;
  ps) [ "$PS_RC" = 0 ] || exit 1; cat "$bin/containers" ;;
  rm) : > "$bin/containers" ;;
  *) exit 9 ;;
esac
`;

let root = "";
let bin = "";
let key = "";
const savedPath = process.env.PATH;
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
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.cleanup()));
  process.env.PATH = savedPath;
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
  expect(await s.cleanup()).toBe("removed");
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

test("a stop ends a running pull; cleanup still runs and removes only the job's container", async () => {
  fake({ PULL: "hang" });
  fs.writeFileSync(path.join(bin, "containers"), "c1\n");
  const stop = new AbortController();
  const s = session(stop);
  const pending = s.ensureImage();
  while (!calls().includes("pull ")) await Bun.sleep(20);
  const stoppedAt = Date.now();
  stop.abort("SIGTERM");
  // The fake pull ignores SIGTERM, so it ends only by SIGKILL after the grace period.
  expect(await pending.catch((e: unknown) => e)).toEqual(new Stopped("SIGTERM"));
  expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(4_500);
  expect(await failure(s.ensureImage())).toThrow(Stopped);

  const job = { name: "xbb-1", owner: "boot:pid", checkout: "abc" };
  const first = s.cleanup(job);
  expect(s.cleanup(job)).toBe(first);
  expect(await first).toBe("removed");
  const ps = calls()
    .split("\n")
    .find((l) => l.startsWith("ps "))!;
  expect(ps).toContain(
    "--filter name=^/xbb-1$ --filter label=xum.bugbash.owner=boot:pid --filter label=xum.bugbash.checkout=abc"
  );
  expect(calls()).toContain("rm -f c1 ");
}, 15_000);

test("cleanup reports an unknown container state, never success", async () => {
  fake({ IMAGES: "sha256:abc", PS_RC: "1" });
  const s = session();
  await s.ensureImage();
  expect(await s.cleanup({ name: "xbb-1", owner: "o", checkout: "c" })).toStartWith("unknown: ");
});
