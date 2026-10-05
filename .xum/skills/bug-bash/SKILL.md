---
name: bug-bash
description: Run an agent bug bash of the Xum web UI with TesterArmy e2e (`e2e explore` charters against disposable mock-AI servers), then verify each finding with a failing repro test. Use when asked to "bug bash" Xum, run e2e explore agents against the app, or try to break the app with AI explorers.
---

# Bug bash with e2e explore

Each charter is one `e2e explore` run: an AI explorer drives a real browser against its own
disposable `xum server` and reports findings. Findings are claims. Report a bug only after a repro
test fails for the reported reason.

Files:

- `tests/bugbash/charters.txt`: one `slug|target|agent|charter` per line.
- `tests/bugbash/e2e.config.ts`: targets (`web` 1440x900, `phone` 390x844), personas, model.
- `tests/bugbash/startApp.ts`: starts one seeded server (demo project, workspace "Bug bash
  playground", artifacts, `XUM_MOCK_AI=1`, temp `XUM_ROOT` and `HOME`).
- `tests/bugbash/run.ts`: runs the charters in parallel and writes `findings.md`.

## 1. Prepare

1. Use Node.js 22.22.3+ or 24.8+ for e2e: put it first on PATH or set `E2E_NODE=<path to node>`.
2. Install the browser once: `node_modules/.bin/e2e-web install chromium`.
3. Explorer models: `BUGBASH_MODELS`, comma-separated `<provider>:<model>`, default
   `anthropic:claude-opus-5-5,anthropic:claude-sonnet-5-5`. Every model runs every charter in
   parallel. The two found mostly different bugs in a comparison run, so keep both unless cost
   matters more than coverage (then use Opus alone). `BUGBASH_EFFORT` (low, medium, high, xhigh,
   max; default medium) sets the reasoning level for every model; use `high` before a release.
   Each provider reads its standard variables: `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`
   (include `/v1`), `OPENAI_API_KEY` + `OPENAI_BASE_URL`. If a gateway needs a different token or
   URL, set them on the command line for the run. The app never receives these credentials.
4. CAUTION: Keep explorers out of Terminal tabs. A terminal runs real shell commands as your user on
   the host. The temp `HOME` protects your config, not your files. Charters and the agent context
   forbid terminals, but a prompt is not a security boundary.

## 2. Plan charters

Edit `tests/bugbash/charters.txt`. One area and one posture per charter; for a branch, base the
charters on `git diff --stat origin/main...HEAD`. Personas (`--agent`): `newcomer`, `keyboard`,
`fuzzer`, `state`, `skeptic`, `default`. Name the workspace and the starting view in the goal.

## 3. Run

```bash
make bug-bash BUGBASH_ARGS="--only <slug>,<slug> --max-steps 6"   # all charters without --only
make bug-bash BUGBASH_ARGS="--charters <file>"                     # branch-specific charters
```

`--parallel` (default 8) is the total number of explorers at once across all models. Start with one or two charters and check the logs before running all of them. Each charter costs
model calls; the end of each `<slug>.log` prints cost and duration. Output goes to
`tests/bugbash/.e2e/bugbash/<run>/` (git-ignored): `findings.md` for all models, and per model and
charter `<model>/<slug>.log`, `<model>/<slug>.app.log`, `<model>/<slug>/summary.md` and
`<model>/<slug>/artifacts/` (screenshots, video). Merge findings that two models report about the
same defect before triage.

Exit codes per charter: 0 ran with no issue, 1 issues reported (or no step ran), 2 setup error,
3 infrastructure error. Fix 2 and 3 and rerun that charter alone.

## 4. Triage and verify

Follow `node_modules/.bin/e2e guide bug-bash` (same Node.js as above), steps 4-7, with these
Xum specifics:

- Expected, not bugs: "Mock response: ..." replies, "model calls are disabled in mock AI mode"
  errors, missing provider features, and anything that needs a real model or network service.
- Read the source before keeping a finding (`src/browser/...`). Reject explorer artifacts first.
- Repro tests go in `tests/bugbash/repros/<slug>.e2e.ts` with `{ tags: ['bugbash'] }`. Run one with
  `node_modules/.bin/e2e run repros/<slug>.e2e.ts --config tests/bugbash/e2e.config.ts`. It is
  confirmed only when it fails with `ASSERTION_FAILED` on the bug's assertion.
- Repro tests stay uncommitted unless the user asks: no CI job runs them.

Report confirmed bugs first (title, expected vs actual, root cause `file:line`, steps, video path,
repro test), then unverified production risks, then rejected findings by reason, then the charters
run and their cost.
