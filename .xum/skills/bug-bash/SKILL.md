---
name: bug-bash
description: Run an agent bug bash of the Xum web UI in the bug-bash sandbox (TesterArmy `e2e explore` charters, each in its own locked-down Docker container with a seeded `xum server`), then verify each finding with a failing repro test. Use when asked to "bug bash" Xum, run e2e explore agents or the MCP Apps suite against the app, or try to break the app with AI explorers.
---

# Bug bash in the sandbox

Each charter is one `e2e explore` run: an AI explorer drives Chromium against its own seeded
`xum server` and reports findings. Every model-driven run happens inside the bug-bash sandbox
(#5714), a Docker container per job. Findings are claims. Report a bug only after a repro test
fails for the reported reason.

The generic method (charters, triage, verify, report) is upstream's guide:
`node_modules/.bin/e2e guide bug-bash` (it needs Node.js 22.22.3+ or 24.8+). This skill adds the
Xum harness. Where the two differ, follow this skill.

## How the sandbox works

- The host pause (`tests/bugbash/hostPause.ts`) refuses every model-driven e2e process on the host
  with exit 2: `e2e explore`, and every command with `e2e.mcpapps.config.ts`. Outside the sandbox
  the agents hold no model, so an `agent.*` step fails with `MODEL_UNAVAILABLE`. No override
  exists. `e2e run` and `e2e list` of exact-step repros still run on the host.
- `make bug-bash` (`tests/bugbash/run.ts`) and `make mcp-apps-e2e` are the launchers. They run
  `tests/bugbash/sandbox/launch.ts`, one container per job.
- The image `ghcr.io/coder/xum-bugbash-sandbox` (about 1.4 GB, linux/amd64) holds only tools:
  Node 22, Bun, git and the Chromium of `@e2e-dev/web`'s playwright-core. The runner pulls it only
  by the digest in `tests/bugbash/sandbox/image.json` and never builds it.
- The inputs key (`make bugbash-sandbox-key`) is a hash of the Dockerfile, `build.sh` and the
  playwright-core version in `bun.lock`. The runner refuses an image whose key differs from the
  checkout. After a change to any of the three, a maintainer runs the manual workflow
  "Bug-bash sandbox image" on main and updates `image.json` in a reviewed PR. An e2e update that
  keeps playwright-core keeps the key, so the image stays valid.
- The container gets `--network none`, `--read-only`, `--cap-drop ALL`, no-new-privileges, a
  non-root user, 4 GB memory and tmpfs scratch folders. It reads copies of the git-listed files,
  plus `dist/` and `node_modules/` read-only. An env allowlist passes no credential.
- One provider proxy per job (`sandbox/proxy.ts`) runs in the launcher on the host and holds the
  API key. The container reaches it only through a read-only unix socket. The proxy allows only
  `POST /anthropic/v1/messages` to the job's models, clamps `max_tokens`, and reserves each call's
  worst-case cost from the run's ledger before it sends the call. It writes one record per call to
  `<output>.proxy.jsonl`.
- The container writes nothing on the host. At the end, `sandbox/entry.ts` sends the output folder
  on stdout as framed files (`sandbox/exportStream.ts`). The host writes only new regular files
  and stops at the first bad frame.
- The container's stdin is the lifeline: when the launcher dies, the container stops.

## 1. Prepare

1. Host: Linux on amd64, not root, with a local rootful Docker socket. Docker Desktop, rootless
   Docker and a remote endpoint refuse (exit 2). The host needs git, make and Bun 1.3.12
   (`bun --version`). It needs no Node.js or Chromium for the sandbox targets. On a fresh
   checkout, run `bun install`.
2. Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` (with or without `/v1`) and
   `BUGBASH_BUDGET_USD`. The runner reads the key only from `ANTHROPIC_API_KEY`: copy a key from
   another variable (for example `ANTHROPIC_AUTH_TOKEN`) there.
3. `BUGBASH_BUDGET_USD` caps the whole run (every job and the app-AI probe) at list price. It is
   not a billing cap: the key's own limit is the backstop.
4. Dry run at $0 with no key: `make bug-bash-sandbox-check` (isolation, proxy and export
   refusals against a fake upstream, about 2 minutes) and `make test-bugbash-repros-sandbox` (the
   repros through the launcher on the mock app AI, about 4 minutes). CI's
   `Test / Bug-bash sandbox` job runs both.

## 2. Plan charters

Edit `tests/bugbash/charters.txt`, one `slug|target|agent|charter` per line. One area and one
persona per charter. For a branch, base the charters on `git diff --stat origin/main...HEAD`, or
pass a branch-specific file with `--charters <file>`.

- Targets (`tests/bugbash/e2e.config.ts`): `web` 1440x900, `phone` 390x844.
- Personas (`--agent`): `newcomer`, `keyboard`, `fuzzer`, `state`, `skeptic`, or e2e's own `default`.
- Name the workspace ("Bug bash playground") and the starting view in the goal.
- Model-driven jobs turn terminals off, so no charter can use a Terminal tab. Settings can still
  add stdio MCP servers and custom editor commands: keep explorers out of those.

## 3. Run

```bash
make bug-bash BUGBASH_BUDGET_USD=9                                  # 6 charters x Sonnet 5.5
make bug-bash BUGBASH_BUDGET_USD=3 BUGBASH_ARGS="--only composer"   # one charter
```

1. The run checks the env, Docker and the image first (about a second once the image is cached),
   then builds, then launches the jobs. The first run pulls the image, which takes minutes.
2. Before any job it prints its estimate and a recommended budget, and refuses a lower budget
   with the number to set. The default needs $9 and takes about 5 minutes after the build.
3. The app AI (`tests/bugbash/aiMode.ts`): `BUGBASH_AI=auto` (default) probes
   `BUGBASH_APP_MODEL` (default `anthropic:claude-haiku-5-5`) once through a proxy. If the probe
   answers, the app uses that model through each job's proxy. If the upstream is busy (429 or
   5xx), the app uses the mock. A rejected key (401 or 403) or an unreachable base URL refuses
   before any job. `real` never falls back, and `mock` never calls a provider. Charters that name
   a `[mock:...]` prompt always use the mock.

Options:

- `BUGBASH_ARGS`: `--only <slug,...>`, `--charters <file>`, `--parallel N` (default 8, all models
  together), `--max-steps N` (1-12, default 6), `--config tests/bugbash/e2e.mcpapps.config.ts`
  (the only other config that runs).
- `BUGBASH_MODELS`: comma-separated `anthropic:<model>`, default Sonnet 5.5. Only models with a
  price in `tests/bugbash/sandbox/proxyPolicy.ts` run (`claude-sonnet-5-5`, `claude-opus-5-5`,
  `claude-haiku-5-5`). Adding Opus finds more distinct bugs and needs about $29.
- `BUGBASH_EFFORT`: low, medium (default), high, xhigh or max. A higher effort raises the
  estimate as a marked guess.
- `make bug-bash` refuses `BUGBASH_MODEL`, which only `make mcp-apps-e2e` reads.

MCP Apps: `make mcp-apps-e2e BUGBASH_BUDGET_USD=5` runs `tests/bugbash/mcpapps/mcp-apps.e2e.ts`
(7 tests on web and phone) with `BUGBASH_MODEL` (default Sonnet 5.5). It pins the mock app AI,
because its seed writes the MCP chat directly. Measured runs spent $0.93 to $1.71 and took 8 to 10
minutes. `MCP_APPS_E2E_ARGS` passes e2e arguments. To explore it, use
`BUGBASH_ARGS="--config tests/bugbash/e2e.mcpapps.config.ts --charters tests/bugbash/mcpapps/charters.txt"`.
Suite tests drive flows with `agent.act` in on-screen words and pin each outcome with an exact
`expect`. Use `agent.assert(..., { vision: "only" })` for "is it on screen": the accessibility
tree also lists off-screen nodes. Prove a new suite test fails on the old `dist/` before the fix
lands.

## 4. Read the results

The run folder is `tests/bugbash/.e2e/bugbash/<run>/` (git-ignored):

- `findings.md`: every charter with its exit code, how it ended, the app AI mode, the cost and
  the findings. Merge findings that two models report about the same defect.
- `<model>/<slug>.log`: the sandbox log. `<model>/<slug>.proxy.jsonl`: one record per model call.
- `<model>/<slug>/`: `summary.md`, `report.json`, `app.log` and `results/` (screenshots, video).

Exit codes of `make bug-bash`:

| Code     | Meaning                                                                            |
| -------- | ---------------------------------------------------------------------------------- |
| 0        | Every charter ran. Read `findings.md`: a charter with issues exits 1 in its table. |
| 1        | A charter ran no step (the Ended column tells this apart from issues).             |
| 2        | Refused. Stderr and the charter log name the reason.                               |
| 3        | A container's state is unknown (see Leftovers).                                    |
| 4        | Incomplete evidence, or an internal error of e2e or the launcher.                  |
| 5        | A proxy fault (a call cost more than its bound, or a record was not written).      |
| 6        | e2e's own infrastructure error.                                                    |
| 130, 143 | Stopped.                                                                           |

A stop or a proxy fault before the jobs start writes no run folder.

Leftovers: every launch lists the job containers of its checkout. `make bug-bash-sandbox-recover`
removes only those whose launcher is provably dead on this boot, and exits 3 when it cannot tell
for one. Check that container's `xum.bugbash.owner` and `xum.bugbash.checkout` labels with
`docker inspect`, then `docker rm -f <id>` it. A SIGKILLed launcher also leaves
`$TMPDIR/xum-bugbash-sandbox/<checkout>/<job>` and a `xum-bugbash-docker-*` folder in `$TMPDIR`:
remove both by hand.

## 5. Triage and verify

Follow the sections "5. Triage", "6. Verify" and "7. Report" of `e2e guide bug-bash`, with these
Xum rules:

- Check `findings.md` for the charter's app AI mode. In mock mode, "Mock response: ..." replies
  and "model calls are disabled in mock AI mode" errors are expected, not bugs.
- Read the source (`src/browser/...`) before keeping a finding. Reject explorer mistakes first.
- A repro goes in `tests/bugbash/repros/<slug>.e2e.ts` (tracked) with exact `screen`, `browser`
  and `expect` steps, never `agent.*`. `tests/bugbash/reproRules.test.ts` fails on a repro that
  takes the `agent` fixture.
- Prove every repro: put the bug back in a scratch edit, rebuild, see `ASSERTION_FAILED` on the
  bug's own assertion, then remove the edit and see it pass.
- Tags: `bugbash` plus the bug ID. Add `mock-only` when the test needs a `[mock:...]` prompt or a
  terminal. Add `known-failure` plus the issue number for an open bug, and remove it in the PR that
  fixes the bug.
- Run repros on the host with `make test-bugbash-repros` (Node 22.22.3+ or 24.8+ as `E2E_NODE`, and
  `node_modules/.bin/e2e-web install chromium` once). One repro:
  `make test-bugbash-repros BUGBASH_REPRO_ARGS="repros/<slug>.e2e.ts"`. With a key set, the
  non-mock repros make paid app-model calls: use `BUGBASH_AI=mock` for none. Run e2e through the
  make targets: `e2e.config.ts` refuses an unresolved app AI mode unless `BUGBASH_AI=mock`.
- After fixing findings, rerun the bug bash on the changed behaviors until a round finds no
  regression, incomplete fix or new defect in changed code. File unrelated older bugs as issues.

Report confirmed bugs first (title, expected vs actual, root cause `file:line`, steps, video path,
repro test), then unverified risks, then rejected findings by reason, then the charters run and
their cost.
