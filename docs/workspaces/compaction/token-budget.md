---
title: Token-Budget Context Windows
description: Start fresh context windows without automatic summaries and retrieve earlier work on demand
---

Select **Token Budget** from **Compaction strategy** in **Settings → General** to replace usage-triggered automatic summaries with fresh context windows. The default strategy is **Summarize**.

## Threshold and precedence

Use the existing context-usage slider to choose the per-model **handoff target**. The **Handoff target: N%** label shows the value Xum evaluates: a 70% slider setting targets 70% of the model's context window, and stored values below 10% are evaluated and displayed as 10%. When usage reaches the target, Xum asks the agent to finish its current small unit of work, checkpoint notes, and start the next window itself. Rollover is forced only at the model's **usable limit** (the context window minus a fixed output reserve), independent of the slider. The slider is a target, not a spending cap and not a bound on context growth: usage past the target is expected while the agent finishes a unit of work. Both points are evaluated when sending and after a settled tool step. Rollover starts a fresh window without summarizing earlier messages. The transcript shows a **Context window rollover** divider; earlier messages remain on disk, in the UI, and in exports.

Stages are skipped, never pulled earlier. When the usable limit precedes the warning or handoff target, or an advisory would leave the request without headroom, that stage is omitted and nothing is claimed; very small context windows may receive no advisories at all. The chat-input bar counts down to the handoff target and, past it, states that rollover is forced at the usable limit.

- Manual `/compact` and idle compaction still summarize normally.
- Continuous compaction and effective RLM take precedence over rollover.
- Setting the usage threshold to **100%** disables automatic rollover, its warning, and the handoff request; the `new_context` tool is not offered. Hard request-size checks still apply, including after settled tool steps: the turn can pause without queuing a rollover or discarding completed tool results.
- `session_history` must be allowed by the agent's inherited tool policy and any caller restrictions. Built-in Exec, Plan, and Explore already allow it. Narrow custom agents can add `session_history` or a matching wildcard to `tools.add`. If access is omitted or disabled, rollover pauses before sealing existing context instead of falling back to a lossy summary.

Rollover also pauses when applicable request middleware can change the toolset, before clearing context state or saving a boundary. Context-only integrations, including sandboxed plugin context hooks, remain supported. Xum pins the workspace's applicable hook registrations when admitting a rollover and uses that snapshot throughout the turn and its fallback attempts; later registration changes apply to subsequent requests. Plugin revocation still takes effect. Hooks explicitly scoped to another workspace do not block rollover. Ordinary requests and manual `/compact` retain their existing middleware behavior.

## Keeping useful context

Two machine-authored prompts, each at most once per window, ask the agent to write important context to the conventional `workspace/context-notes.md` file, up to **8 KiB**, if the workspace is writable:

- An **advance warning** (the collapsible **Context budget warning** row) fires ahead of the handoff target and asks the agent to write or update the notes, then continue the task. It fires ten percentage points below the target and, on small context windows, at least **6,144 tokens** before the target, but never earlier than half of the target.
- A **handoff request** (the **Context handoff requested** row) fires when usage reaches the target. It asks the agent to finish its current small unit of work and start no substantial new work in this window, write or update the notes (essential state first), confirm the write succeeded, and then call the `new_context` tool in a later step. If the task is already complete, the agent finishes its reply instead. A handoff request supersedes an undelivered warning and suppresses any later warning in the same window. The wording is capability-aware: if the agent's tool policy does not allow `new_context`, the request says so and asks for notes only; if history recovery is unavailable, it asks the agent to have the user enable it or use `/compact`; if memory is read-only, the notes steps are skipped.

Work after the request is ordinary work: it runs with the agent's normal toolset, permissions, costs, goal caps, queued user input, and Stop. Xum queues no extra turn to extract a `new_context` call; if the agent finishes with text only, the next real message re-evaluates usage and may carry the request. Ignoring the request forces nothing before the usable limit.

New windows no longer offer a **final flush**. Rows of that kind already persisted in older histories (**Context window ending: notes flush**) still resume as before: one bounded, memory-only provider step, then the window seals.

The prompts report usage against the usable limit (the point where Xum forces a rollover), not the model's full context window. Advisories are best-effort: they are sent only while the request still has headroom under Xum's counting estimates, and the final request preflight remains authoritative.

Both prompts are an opportunity to preserve notes, not a guarantee that the agent writes them. While token-budget mode is active, Xum can preload the notes as an **additional ninth memory**, without replacing the normal eight or using their existing byte/token budgets. The extra excerpt is separately bounded to **8 KiB / 2,000 tokens**, including formatting, and is not duplicated if already selected normally. This still requires **Memory** and **Memory Hot Set**; the experiment does not enable either. With token-budget mode inactive, notes follow the ordinary memory-selection rules.

`new_context` is the agent's own rollover request. It is advertised only while automatic rollover is enabled and history recovery is allowed, and it is honored once per window: the current step's sibling tools finish first, then the window seals with the same divider and lead-in as a forced rollover, attributed to the model. Confirm the checkpoint before calling it in a later step: if a checkpoint fails in the same parallel tool batch as a `new_context` call, the window still rolls over, and the notes must be repaired from `session_history` in the next window.

The next window receives a model-only lead-in, not a summary. While the experiment is enabled, the agent can use `session_history` to list windows, search, or read earlier messages in the same workspace. Each call returns one complete result capped at **16 KiB**. Each listed window reports `itemCount`: the number of visible rows before any role or tool filter. A window ID that recurs in repaired history is listed once per contiguous run. Rows over **1 MiB** are skipped. When more matches exist than fit, the result reports `has_more: true` and the agent narrows the query. A cooperative 30-second processing deadline gates new work but cannot interrupt lock waits. If the deadline passes with work remaining, the tool reports `history_timeout` instead of partial data.

The newest manual `/clear --soft` is a privacy floor: the tool cannot retrieve messages before it. Manual reset behavior and edited-file carryover are unchanged. Turning the experiment off removes retrieval access without deleting old windows.

## Pauses and size limits

Rollover stops only after a tool step settles, preserving tool call/result pairs. Only one rollover may be pending; it is handled on the next send. Restart leaves the workspace paused rather than resurrecting a queued continuation, and the next message re-evaluates pressure from history.

The boundary, lead-in, and triggering message or continuation are saved as one atomic, all-or-nothing batch. Recovery also tolerates incomplete batches in legacy or externally modified histories. Requests estimated to exceed a fresh window are blocked before contacting the provider; rollover cannot make oversized attachments or instructions fit. Text guards use real encodings, but provider-family, media, and framing estimates can still differ from the provider's accounting: hard guards prevent dispatches that exceed the known usable limit under Xum's counting, not a guarantee of agreement with every provider, and goal and cost controls remain authoritative for spending. Pasted data URLs and ordinary tool JSON count as text, not as image attachments. With Tool Search, deferred schemas count only when advertised; each provider step rechecks activated tools and transformed messages. A failed step preflight pauses without starting another rollover. Before a rollover clears the current context, the complete pinned future request—including system instructions, memory, and advertised tools—must also fit. If admission fails, the current window stays open. An admitted request is prepared once and reused after the boundary is saved.
