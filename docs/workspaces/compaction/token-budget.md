---
title: Token-Budget Context Windows
description: Start fresh context windows without automatic summaries and retrieve earlier work on demand
---

Select **Token Budget** from **Compaction strategy** in **Settings → General** to replace usage-triggered automatic summaries with fresh context windows. The default strategy is **Summarize**.

## Threshold and precedence

Use the existing context-usage slider to choose the per-model **handoff target**. The **Handoff target: N%** label shows the value Xum evaluates: a 70% slider setting targets 70% of the model's context window, and stored values below 10% are evaluated and displayed as 10%. On smaller context windows, a high slider is also clamped below the final prompt zone, and the label shows that clamped target. When usage reaches the target, Xum asks the agent to finish its current small unit of work and start the next window itself with a handoff. Rollover is forced only at the model's **usable limit** (the context window minus a fixed output reserve), independent of the slider. The slider is a target, not a spending cap and not a bound on context growth: usage past the target is expected while the agent finishes a unit of work. Both points are evaluated when sending and after a settled tool step. Rollover starts a fresh window without summarizing earlier messages. The transcript shows a **Context window rollover** divider; earlier messages remain on disk, in the UI, and in exports.

Stages are skipped, never pulled earlier. When the usable limit precedes the handoff target, or a prompt would leave the request without headroom, that stage is omitted and nothing is claimed; very small context windows may receive no prompts at all. The chat-input bar counts down to the handoff target and, past it, states that rollover is forced at the usable limit.

- Manual `/compact` and idle compaction still summarize normally.
- Continuous compaction and effective RLM take precedence over rollover.
- Setting the usage threshold to **100%** disables automatic rollover, the handoff request, and the final handoff step; the `new_context` tool is not offered. Hard request-size checks still apply, including after settled tool steps: the turn can pause without queuing a rollover or discarding completed tool results.
- `session_history` must be allowed by the agent's inherited tool policy and any caller restrictions. Built-in Exec, Plan, and Explore already allow it. Narrow custom agents can add `session_history` or a matching wildcard to `tools.add`. If access is omitted or disabled, rollover pauses before sealing existing context instead of falling back to a lossy summary.

Rollover also pauses when applicable request middleware can change the toolset, before clearing context state or saving a boundary. Context-only integrations, including sandboxed plugin context hooks, remain supported. Xum pins the workspace's applicable hook registrations when admitting a rollover and uses that snapshot throughout the turn and its fallback attempts; later registration changes apply to subsequent requests. Plugin revocation still takes effect. Hooks explicitly scoped to another workspace do not block rollover. Ordinary requests and manual `/compact` retain their existing middleware behavior.

## Keeping useful context

The agent keeps context across windows with a **handoff**: text it passes to the `new_context` tool, up to **8 KiB**. A good handoff states the goal, decisions, progress, next steps, and the exact paths, commands, and IDs needed to resume. The handoff is part of the session, not a memory file, so read-only agents and sub-agents can hand off too.

Two machine-authored prompts, each at most once per window, ask for a handoff:

- A **handoff request** (the **Context handoff requested** row) fires when usage reaches the target. It asks the agent to finish its current small unit of work, save or commit work that must survive, start no substantial new work in this window, and then call `new_context` with a handoff. If the task is already complete, the agent finishes its reply instead. The wording is capability-aware: if the agent's tool policy does not allow `new_context`, the request says so; if history recovery is unavailable, it asks the agent to have the user enable it or use `/compact`.
- A **final handoff step** (the **Context window ending: final handoff** row) runs when a settled step brings the next request close to the usable limit and the request still has headroom. It is one bounded provider step in which only `new_context` is enabled. If the agent calls `new_context`, its handoff seals the window. If it does not, the window seals with the previous handoff carried forward. The step is skipped when user input is queued, when `new_context` or `session_history` is not allowed, or when the window is too small.

New windows no longer offer a **final flush**. A pending flush turn persisted by an older build now resumes as an ordinary continuation: normal toolset and permissions, no one-step limit. The usable-limit rollover still seals the window later.

Older histories can contain **Context budget warning** rows from earlier versions; they still render. Final notes-flush rows from earlier versions render as final handoff rows, and a pending legacy flush turn resumes as a final handoff step.

The prompts report usage against the usable limit (the point where Xum forces a rollover), not the model's full context window. Prompts are best-effort: they are sent only while the request still has headroom under Xum's counting estimates, and the final request preflight remains authoritative.

`new_context` is the agent's own rollover request. It is advertised only while automatic rollover is enabled and history recovery is allowed, and it is honored once per window: the current step's sibling tools finish first, then the window seals with the same divider and lead-in as a forced rollover, attributed to the model.

The next window receives a model-only lead-in, not a summary. The lead-in shows the request that owns the turn (up to **8 KiB**, with a pointer to the full row) and then the agent's handoff. If the closing window has no new handoff, the previous handoff is carried forward and marked as coming from an earlier window. While the experiment is enabled, the agent can use `session_history` to list windows, search, or read earlier messages in the same workspace. Each call returns one complete result capped at **16 KiB**. Each listed window reports `itemCount`: the number of visible rows before any role or tool filter. A window ID that recurs in repaired history is listed once per contiguous run. Rows over **1 MiB** are skipped. When more matches exist than fit, the result reports `has_more: true` and the agent narrows the query. A cooperative 30-second processing deadline gates new work but cannot interrupt lock waits. If the deadline passes with work remaining, the tool reports `history_timeout` instead of partial data.

The newest manual `/clear --soft` is a privacy floor: the tool cannot retrieve messages before it. Manual reset behavior and edited-file carryover are unchanged. Turning the experiment off removes retrieval access without deleting old windows.

## Pauses and size limits

Rollover stops only after a tool step settles, preserving tool call/result pairs. Only one rollover may be pending; it is handled on the next send. Restart leaves the workspace paused rather than resurrecting a queued continuation, and the next message re-evaluates pressure from history.

The boundary, lead-in, and triggering message or continuation are saved as one atomic, all-or-nothing batch. Recovery also tolerates incomplete batches in legacy or externally modified histories. Requests estimated to exceed a fresh window are blocked before contacting the provider; rollover cannot make oversized attachments or instructions fit. Text guards use real encodings, but provider-family, media, and framing estimates can still differ from the provider's accounting: hard guards prevent dispatches that exceed the known usable limit under Xum's counting, not a guarantee of agreement with every provider, and goal and cost controls remain authoritative for spending. Pasted data URLs and ordinary tool JSON count as text, not as image attachments. With Tool Search, deferred schemas count only when advertised; each provider step rechecks activated tools and transformed messages. A failed step preflight pauses without starting another rollover. Before a rollover clears the current context, the complete pinned future request—including system instructions, memory, and advertised tools—must also fit. If admission fails, the current window stays open. An admitted request is prepared once and reused after the boundary is saved.
