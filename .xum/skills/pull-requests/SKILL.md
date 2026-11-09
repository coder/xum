---
name: pull-requests
description: Guidelines for creating and managing Pull Requests in this repo
---

# Pull Request Guidelines

## Attribution Footer

Public work (issues/PRs/commits) must use 🤖 in the title and include this footer in the body:

```md
---

_Generated with `xum` • Model: `<modelString>` • Thinking: `<thinkingLevel>` • Cost: `$<costs>`_

<!-- mux-attribution: model=<modelString> thinking=<thinkingLevel> costs=<costs> -->
```

Always check `$XUM_MODEL_STRING`, `$XUM_THINKING_LEVEL`, and `$XUM_COSTS_USD` via bash before creating or updating PRs—include them in the footer if set.

Scheduled automation (non-AI) commits and PRs from GitHub Actions workflows use this footer instead, since model/thinking/cost do not apply:

```md
---

_Automated by the `<workflow-name>` workflow (GitHub Actions)._

<!-- xum-attribution: workflow=<workflow-name> -->
```

## Lifecycle Rules

- Before submitting a PR, ensure the branch name reflects the work and the base branch is correct.
  - PRs are always squash-merged into `main`.
  - Often, work begins from another PR's merged state; rebase onto `main` before submitting a new PR.
- Reuse existing PRs; never close or recreate without instruction.
- Force-push minor PR updates; otherwise add a new commit to preserve the change timeline.
- If a PR is already open for your change, keep it up to date with the latest commits; don't leave it stale.
- When updating a PR, ensure the title and body describe the **entire** diff against the base branch—not just the most recent commit or push.
- Never enable auto-merge or merge into `main` yourself. The user must explicitly merge PRs.
- Open a PR ready for review when it is meant to land, not as a draft. `pr.yml` runs on `ready_for_review`, so `gh pr ready` reruns every PR job plus the story lane that skips drafts, and Codex reviews the head again.

## CI & Validation

- Prefer local validation first (e.g., `make static-check` or a targeted test subset) because CI waiting can take 10+ minutes.
- Before the first push of a fix, find every other code path that reads the same input or makes the same decision. Search for the function, the constant, the file name and the error text. Make each one agree with the fix and cover it with a test, or say in the PR body why it does not need the change. For a CI path filter, list every file that the job reads (configs, `Makefile`, `package.json`, `bun.lock`, the workflow file) and check that a change to each one triggers the job.
- Use `./scripts/wait_pr_ready.sh <pr_number>` as the default last-step helper when there's no more useful local work left.
- `wait_pr_ready.sh` polls the Codex, CI checks, and (when requested) `coder-agents-review` gates together and fails fast on the first terminal failure.
- Use `./scripts/wait_pr_checks.sh <pr_number>` and `./scripts/wait_pr_codex.sh <pr_number>` directly only when you need to debug a specific gate. They print counts: `wait_pr_checks.sh <pr_number> --once --details` lists the failing checks, and `./scripts/check_codex_comments.sh <pr_number>` lists the Codex findings.
- If asked to fix an issue in CI, first replicate it locally, get it to pass locally, then use `wait_pr_ready.sh`.
- When a required gate fails while the signal it checks is green (Codex approved, the tests pass), run `git fetch origin` and then `git log origin/main -- <the gate's scripts>` first, and read the gate at `origin/main`, not in your checkout. A rerun of the job replays the old merge commit, so it cannot pick up a gate fix on main. A new `pull_request` event (a push, or merging `origin/main` into the branch) runs on a fresh merge ref and does.

### Landing a stack through the merge queue

- `gh stack merge <stack#> --yes` only adds the stack to the queue. "All or nothing" covers that step, not the landing. The queue merges in groups: a failed group removes its PR (`RemovedFromMergeQueueEvent.reason` reads `failed_checks`) and every PR above it (`stack_invalidated`), while the PRs below stay merged.
- After the enqueue, watch every member until it is merged or removed. `gh pr view --json` has no merge-queue field, so read `mergeQueueEntry{state}` and the removal event through `gh api graphql`, and treat a failed query as an error, not as "still queued".
- Read each removed member's `state`, head and base before you touch the stack. A member whose base branch was deleted can be closed instead of rebased: reopen it and retarget it to `main` before you push anything above it.
- When a lower PR merged, GitHub rebases the removed PRs onto `main`: wait for `Required` and a new Codex review on their new heads. When the bottom PR failed, the heads do not change: fix the failure, or confirm it is a flake. Then run `gh stack merge` again. It re-adds only the PRs that did not merge.
- An enqueue that exits 4 with `Required status check "Required" is expected` added nothing: one member's head has no `Required` run yet.

## Status Decoding

| Field              | Value         | Meaning             |
| ------------------ | ------------- | ------------------- |
| `mergeable`        | `MERGEABLE`   | Clean, no conflicts |
| `mergeable`        | `CONFLICTING` | Needs resolution    |
| `mergeStateStatus` | `CLEAN`       | Ready to merge      |
| `mergeStateStatus` | `BLOCKED`     | Waiting for CI      |
| `mergeStateStatus` | `BEHIND`      | Needs rebase        |
| `mergeStateStatus` | `DIRTY`       | Has conflicts       |

If behind: `git fetch origin && git rebase origin/main && git push --force-with-lease`.

## Codex Review Workflow

When posting multi-line comments with `gh` (e.g., `@codex review`), **do not** rely on `\n` escapes inside quoted `--body` strings (they will be sent as literal text). Prefer `--body-file -` with a heredoc to preserve real newlines:

```bash
gh pr comment <pr_number> --body-file - <<'EOF'
@codex review

<message>
EOF
```

### Handling Codex Comments

Use these scripts to check, resolve, and wait on Codex review comments:

- `./scripts/check_codex_comments.sh <pr_number>` — Lists unresolved Codex comments (both regular comments and review threads). Outputs thread IDs needed for resolution.
- `./scripts/resolve_pr_comment.sh <thread_id>` — Resolves a review thread by its ID (e.g., `PRRT_abc123`).
- `./scripts/wait_pr_codex.sh <pr_number>` — Waits for Codex-only status (or one-shot status with `--once`).
- `./scripts/wait_pr_ready.sh <pr_number>` — Unified Codex + CI gate poller (preferred for normal PR readiness loops).

The PR readiness definition, the review loop, and its early-stop cases live in the PR Workflow section of AGENTS.md; follow them there.

#### Security review receipts and round cost

- The `Codex Comments` check can wait for a Codex security review receipt that names the PR head. This happens only when the head's security review completed with no findings metadata (both findings flags null) and no clean receipt exists. Automatic reviews on PR open or on a push often end that way, because Codex posts a receipt mainly for a review that a comment asked for. In that state `check_codex_comments.sh` exits 10 with "No Codex security review was requested for <head>: request one".
- `wait_pr_codex.sh` (and so `wait_pr_ready.sh`) posts that request itself, once per head, as `@codex security review`, a blank line, and `Head: <sha>`. It does this only when the PR already has a human `@codex review` comment. On a PR where only the automatic reviews ran, it stops earlier with "No '@codex review' comment found", and a hand-posted security request does not get past that check. Post `@codex review` first, then rerun the helper, so it can post the security request itself.
- A pushed head that reaches this state therefore costs two Codex review rounds: the automatic review and the security review request. Batch every fix for a round into one push.

## Coder Agents Review Workflow

When `/coder-agents-review` is used or the `coder-agents-review` bot has participated:

1. Address each substantive finding.
2. Reply to the bot before resolving threads: either inline on each finding or with a PR comment that explicitly lists the finding IDs and your response.
3. Resolve addressed review threads.
4. Re-request review with `/coder-agents-review`.
5. Run `./scripts/wait_pr_ready.sh <pr_number>`.

Do not silently resolve `coder-agents-review` threads. The bot treats resolved-but-unanswered findings as blocked review rounds.

## PR Title Conventions

- Title prefixes: `perf|refactor|fix|feat|ci|tests|bench`
- Example: `🤖 fix: handle workspace rename edge cases`
- Use `tests:` for test-only changes (test helpers, flaky test fixes, storybook)
- Use `ci:` for CI config changes

## PR Bodies

### Structure

PR bodies should generally follow this structure; omit sections that are N/A or trivially inferable from the code.

- Summary
  - Single-paragraph executive summary of the change
- Background
  - The "why" behind the change
  - What problem this solves
  - Relevant commits, issues, or PRs that capture more context
- Implementation
  - Explain anything novel or unclear about the implementation approach
  - Keep it generally high-level and architectural
- Validation
  - Steps taken to prove the change works as intended
  - Avoid boilerplate like `ran tests`; include this section only for novel, change-specific steps
  - Do not include steps implied by passing PR checks
- Risks
  - PRs that touch intricate logic must include an assessment of regression risk
  - Explain regression risk in terms of severity and affected product areas
- Pains
  - Only include for non-trivial changes that took multiple iteration cycles
  - Explain codebase or environment pains that slowed down planning, implementation, or validation

### Edits

Always use `mktemp` to create a unique temp file for the PR body — never use a
hard-coded path like `/tmp/pr-body.md` (concurrent agents will race):

```bash
PR_BODY=$(mktemp /tmp/pr-XXXXXX.md)
```

Use file edit tools to build the body in `$PR_BODY`, then:

```bash
gh pr edit <num> --body-file "$PR_BODY"
rm -f "$PR_BODY"
```

When updating the PR body, consider condensing information that is no longer important
into a toggle.

## Upkeep

Once the code is pushed to the remote (even if not yet a Pull Request), commit and push all
changes before responding so they are visible to the user. Commits on the working branch
are for yourself to understand the change, they do not have to follow repository conventions as the
PR body and title become the commit subject and body respectively.

Whenever generating a compaction summary, include whether or not a Pull Request was opened
and the general state of the remote (e.g. CI checks, known reviews, divergence).
