/**
 * `make bug-bash-sandbox-check` (#5714, plan PR D2): proves the bug-bash sandbox on this host at
 * no cost. It starts a fake upstream (fakeUpstream.ts), then three sandbox jobs through the
 * real launcher (launch.ts `self-check`):
 *
 * 1. The self-check (selfCheck.ts) in the container: identity, privileges, read-only mounts, no
 *    network, no host paths or credentials, the app's kill switches, one allowed proxy call and
 *    the P1 to P5 refusals. Then, here: the fake upstream saw exactly the allowed call, and none
 *    of the forbidden ones (a refusal response alone does not prove that).
 * 2. and 3. Export fixtures: the container sends a path out of its folder, then a size past the
 *    export cap. The host receiver must refuse each with its own reason, write nothing outside
 *    the output folder, and still remove the container.
 *
 * Prints one line per check and exits 0 only when all pass, 2 when the launcher refuses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { startFakeUpstream } from "./fakeUpstream";
import { type JobOutcome, launchJob } from "./launch";
import { Refusal, Stopped } from "./runner";

const ROOT = fs.realpathSync(path.resolve(import.meta.dir, "../../.."));
const DIR = path.join(ROOT, "tests/bugbash");

export async function runSelfCheck(
  stop: AbortSignal,
  say: (line: string) => void
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
      const outcome: JobOutcome = await launchJob(["self-check", ...extra, "--output", output], {
        root: ROOT,
        cwd: DIR,
        env,
        stop,
        log: (line) => {
          lines.push(line);
          say(`sandbox ${line}`);
        },
      });
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
    check("the container's checks came back", inner.length > 0, `${inner.length} checks`);
    for (const c of inner) check(`container: ${c.name}`, c.ok, c.detail);
    const bodies = upstream.requests.map((r) => r.body);
    const allowed = bodies.filter((b) => b.includes("selfcheck-allowed")).length;
    const forbidden = bodies.filter((b) => b.includes("selfcheck-forbidden")).length;
    check("the upstream saw the allowed call once", allowed === 1, `${allowed}`);
    check("the upstream saw no forbidden call", forbidden === 0, `${forbidden}`);
    check(
      "the upstream saw nothing else",
      upstream.requests.length === allowed,
      `${upstream.requests.length} requests`
    );
    check(
      "the provider key never reached the upstream request body",
      bodies.every((b) => !b.includes("selfcheck-fake-key")),
      "body scan"
    );

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
  } finally {
    await upstream.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  say(`self-check: ${results.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => controller.abort(signal));
  runSelfCheck(controller.signal, (line) => console.error(line)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof Stopped) process.exit(error.reason === "SIGINT" ? 130 : 143);
      console.error(
        `self-check refused: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(error instanceof Refusal ? 2 : 1);
    }
  );
}
