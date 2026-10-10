/**
 * `make bug-bash-sandbox-check` (#5714, plan PR D2): proves the bug-bash sandbox on this host at
 * no cost. It starts a fake upstream (fakeUpstream.ts), then three sandbox jobs through the
 * real launcher (launch.ts `self-check`):
 *
 * 1. The self-check (selfCheck.ts) in the container: identity, privileges, read-only mounts, no
 *    network, no host paths or credentials, the app's kill switches, one allowed proxy call and
 *    the P1 to P5 refusals. Then, here, for every job: the fake upstream saw exactly its allowed
 *    call, and none of the forbidden ones (a refusal response alone does not prove that).
 * 2. and 3. Export fixtures: the container sends a path out of its folder, then a size past the
 *    export cap. The host receiver must refuse each with its own reason, write nothing outside
 *    the output folder, and still remove the container.
 *
 * Prints one line per check and exits 0 only when all pass, 2 when the launcher refuses, and 3
 * when a container's state is unknown after cleanup (that outranks a stop, as in exitFor()).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFakeUpstream } from "./fakeUpstream";
import { type JobOutcome, launchJob } from "./launch";
import { Refusal, Stopped } from "./runner";

const ROOT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."));
const DIR = path.join(ROOT, "tests/bugbash");

/** A job whose container state is unknown after cleanup: the run ends at once with exit 3. */
class UnknownCleanup extends Error {}

/**
 * Every check selfCheck.ts makes, by name. A container that reports fewer (it stopped early, or a
 * check was dropped) or other names fails: a partial report must never pass. Add a new check in
 * selfCheck.ts here too.
 */
export const CONTAINER_CHECKS = [
  "uid is the launcher's and not root",
  "no capabilities",
  "no new privileges",
  "seccomp filter",
  "same kernel as the launcher",
  "read-only /",
  "read-only /repo/src",
  "read-only /repo/node_modules",
  "read-only /repo/dist",
  "empty writable home",
  "no host home under /home",
  "no /var/run/docker.sock",
  "no /run/docker.sock",
  "no /root/.docker",
  "the proxy is a unix socket",
  "the proxy mount is read-only",
  "loopback only",
  "no IPv4 route",
  "closed loopback port refuses",
  "no route to the Docker bridge",
  "no route to the internet",
  "no DNS",
  "no credential env names",
  "allowed call passes",
  "refuses P1 another route",
  "refuses P2 an unknown beta",
  "refuses P3 another model",
  "refuses P4 a server tool",
  "refuses P4 mcp_servers",
  "refuses P5 a URL image",
  "the app server has every kill switch",
];

/** The expected names that are missing, and the names that are unexpected or repeated. */
export function checkSet(names: string[], expected: readonly string[] = CONTAINER_CHECKS) {
  const seen = new Set<string>();
  const unexpected: string[] = [];
  for (const name of names) {
    if (expected.includes(name) && !seen.has(name)) seen.add(name);
    else unexpected.push(name);
  }
  return { missing: expected.filter((n) => !seen.has(n)), unexpected };
}

export async function runSelfCheck(
  stop: AbortSignal,
  say: (line: string) => void,
  launch: typeof launchJob = launchJob
): Promise<number> {
  const upstream = await startFakeUpstream();
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    say(`self-check ${ok ? "pass" : "FAIL"}: ${name} (${detail})`);
  };
  try {
    const env = {
      BUGBASH_AI: "mock",
      BUGBASH_BUDGET_USD: "1",
      // The fake upstream: no key or provider leaves this host.
      ANTHROPIC_API_KEY: "selfcheck-fake-key",
      ANTHROPIC_BASE_URL: `${upstream.baseUrl}/v1`,
      BUGBASH_MODEL: "anthropic:claude-haiku-4-5",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    const stamp = `${Date.now()}-${process.pid}`;
    const job = async (extra: string[], name: string) => {
      const output = `.e2e/self-check-${stamp}-${name}`;
      const lines: string[] = [];
      const before = upstream.requests.length;
      const outcome: JobOutcome = await launch(["self-check", ...extra, "--output", output], {
        root: ROOT,
        cwd: DIR,
        env,
        stop,
        log: (line) => {
          lines.push(line);
          say(`sandbox ${line}`);
        },
      });
      // exitFor()'s rule: an unknown cleanup (exit 3) outranks a stop (130 or 143). Either one
      // ends the run here, so no further job starts.
      if (outcome.cleanup.startsWith("unknown"))
        throw new UnknownCleanup(`${name}: ${outcome.cleanup}`);
      if (outcome.stopped != null) throw new Stopped(outcome.stopped);
      // A Refusal (root, rootless Docker, Docker Desktop: Session refuses after the preflight)
      // or another launcher error ends the run as it ends any job: exit 2 for a Refusal.
      if ("error" in outcome) throw outcome.error;
      // Every job runs the whole selfCheck.ts (the fixtures swap only its export), so each one
      // makes one allowed call and the P1 to P5 probes: check the upstream per job.
      const bodies = upstream.requests.slice(before).map((r) => r.body);
      const allowed = bodies.filter((b) => b.includes("selfcheck-allowed")).length;
      const forbidden = bodies.filter((b) => b.includes("selfcheck-forbidden")).length;
      check(`${name}: the upstream saw the allowed call once`, allowed === 1, `${allowed}`);
      check(`${name}: the upstream saw no forbidden call`, forbidden === 0, `${forbidden}`);
      check(
        `${name}: the upstream saw nothing else`,
        bodies.length === allowed,
        `${bodies.length} requests`
      );
      check(
        `${name}: the provider key never reached the upstream request body`,
        bodies.every((b) => !b.includes("selfcheck-fake-key")),
        "body scan"
      );
      return { outcome, lines: lines.join("\n"), dest: path.join(DIR, output) };
    };

    // 1. The self-check itself.
    const main = await job([], "main");
    check(
      "cleanup removed the container",
      main.outcome.cleanup === "removed",
      main.outcome.cleanup
    );
    check("self-check exited 0", main.outcome.code === 0, `code ${main.outcome.code}`);
    const file = path.join(main.dest, "checks.jsonl");
    const inner = fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { name: string; ok: boolean; detail: string })
      : [];
    const { missing, unexpected } = checkSet(inner.map((c) => c.name));
    check(
      "the container reported every check",
      missing.length === 0 && unexpected.length === 0,
      `${inner.length} of ${CONTAINER_CHECKS.length}` +
        (missing.length ? `, missing: ${missing.join("; ")}` : "") +
        (unexpected.length ? `, unexpected: ${unexpected.join("; ")}` : "")
    );
    for (const c of inner) check(`container: ${c.name}`, c.ok, c.detail);

    // 2. and 3. The export fixtures.
    for (const [fixture, reason] of [
      ["traversal", "a path that is not plain"],
      ["oversize", "more than 1073741824 bytes"],
    ] as const) {
      const bad = await job(["--export-fixture", fixture], fixture);
      // Its own reason, not just any failure.
      check(`${fixture}: the host refused the frame`, bad.lines.includes(reason), reason);
      check(
        `${fixture}: evidence reported incomplete (exit 4)`,
        bad.outcome.code === 4,
        `code ${bad.outcome.code}`
      );
      check(
        `${fixture}: cleanup removed the container`,
        bad.outcome.cleanup === "removed",
        bad.outcome.cleanup
      );
      check(
        `${fixture}: nothing written outside the output folder`,
        !fs.existsSync(path.join(path.dirname(bad.dest), "escape")),
        "no escape file"
      );
    }
  } catch (error) {
    if (!(error instanceof UnknownCleanup)) throw error;
    say(`self-check: a container's state is unknown after cleanup (${error.message})`);
    return 3;
  } finally {
    await upstream.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  say(`self-check: ${results.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

/** The target's exit code: runSelfCheck's, 130 or 143 on a stop, 2 on a refusal, else 1. */
export async function selfCheckExit(
  stop: AbortSignal,
  say: (line: string) => void,
  launch: typeof launchJob = launchJob
): Promise<number> {
  try {
    return await runSelfCheck(stop, say, launch);
  } catch (error) {
    if (error instanceof Stopped) return error.reason === "SIGINT" ? 130 : 143;
    say(`self-check refused: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof Refusal ? 2 : 1;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => controller.abort(signal));
  selfCheckExit(controller.signal, (line) => console.error(line)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // selfCheckExit maps every error to a code; this is only a last resort (fail closed).
      console.error(`self-check failed: ${String(error)}`);
      process.exit(1);
    }
  );
}
