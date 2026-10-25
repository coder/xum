---
title: Agent-Led Context Handoff
description: The token-budget slider is a handoff target for the agent; only the usable limit forces a rollover
---

# 0006. The Token-Budget Slider Is an Agent Handoff Target

## Status

Accepted. Amends [ADR 0005](./0005-token-budget-context-windows.md): the slider-derived forced rollover point and the final-flush consequence are replaced; retrieval, admission, receipt, and privacy-floor decisions are unchanged.

## Context

ADR 0005 forced a rollover five percentage points past the slider and offered a single memory-only "final flush" step before sealing the window. Rollover therefore interrupted the agent mid-task at a point unrelated to its work, and the flush was a housekeeping exception with its own restricted toolset. The `new_context` tool already let an agent seal its own window once sibling tools settled, but nothing asked it to.

## Decision

- The slider value is the **handoff target**: `floor(limit × threshold)`, with no downward clamp beyond the effective minimum of 10% that both backend callers already apply. The UI labels, marks, and counts down to that effective value.
- At the target Xum delivers one **handoff request** per window: finish the current small unit of work, checkpoint `workspace/context-notes.md`, confirm the write, then call `new_context` in a later step; if the task is complete, finish the reply instead. The wording is capability-aware: it is conditional when `new_context` may be hidden by deferred tools or middleware, and degraded when tool policy forbids it or history recovery is unavailable.
- The advance warning keeps its formula, re-anchored to the handoff target. A handoff request supersedes an undelivered warning and suppresses later warnings in the same window; a delivered warning never consumes the handoff.
- Advisories are best-effort and evaluated at dispatch: they require headroom under the usable limit, an active mode, threshold below 100%, and no prior claim in the window. A stage without headroom is skipped, never pulled earlier. Claims derive from durably published rows, not from settlement-time state.
- Forced rollover happens only at the model's **usable limit** (the existing output-reserve ceiling), independent of the slider. Off (100%) still blocks at that ceiling and never emits advisories or offers `new_context`.
- New windows no longer offer a final flush. Persisted legacy flush rows keep their execution and recovery path so older histories still resume; removing that path is a separate compatibility decision.
- Work after a handoff request is ordinary work: normal toolset, permissions, costs, goal accounting, queued input, and Stop. No turn is queued to extract a `new_context` call.

## Consequences

- The slider is a target, not a spending cap or a bound on context growth; usage past it is expected while the agent finishes a unit of work. Hard guards bound provider request size under Xum's counting estimates, not agreement with every provider's accounting; goal and cost controls remain authoritative for spending.
- Row metadata grows only by optional fields (`handoff`, `handoffTokens`), so downgraded builds display handoff rows as ordinary warnings. `budgetTokens` now always means the forced point, the usable limit.
- Outward stream contracts are unchanged: a handoff stop is reported through the existing `warn` decision.

## Accepted limitations

- Agents may defer or ignore the request; the transcript remains retrievable through `session_history`, but no last-chance notes step exists for new windows.
- Very small context windows may receive no advisories at all.
- A failed checkpoint in the same parallel tool batch as a successful `new_context` call still rolls the window over; the next window must repair its notes from history. Confirming the checkpoint before calling `new_context` in a later step avoids this.
- Restarts between stages are covered by durable claims, but a request assembled after admission can still overflow; the existing emergency rollover or safe pause handles it, never an oversized dispatch.
