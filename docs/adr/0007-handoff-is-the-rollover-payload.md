---
title: The Handoff Is the Rollover Payload
description: The agent writes its handoff through new_context, Xum carries it and the active request into the next window, and a final step guarantees a last chance
---

# 0007. The Handoff Is the Rollover Payload

## Status

Accepted. Supersedes the notes-file handoff of [ADR 0005](./0005-token-budget-context-windows.md) and the "no last-chance notes step" limitation of [ADR 0006](./0006-agent-led-context-handoff.md). The handoff target, forced rollover at the usable limit, retrieval, admission, receipts, and privacy floors are unchanged.

## Context

ADR 0005 and ADR 0006 asked the agent to write `workspace/context-notes.md` through the memory tool, confirm the write, and then call `new_context` in a later step. This design had three problems:

1. Read-only agents (for example Explore) cannot write memory, so they could not hand off at all.
2. Sub-agents share their parent's workspace notebook, so parallel children could overwrite each other's notes.
3. ADR 0006 removed the final flush. An agent that ignored the handoff request reached the forced rollover with no handoff and no last chance.

The next window also did not see the request that owned the turn, so the agent had to find it again in `session_history`.

## Decision

- `new_context` takes a required `handoff` argument (up to 8 KiB). The handoff states the goal, decisions, progress, next steps, and the paths and IDs needed to resume. The handoff is part of the session, so it needs no memory access and cannot collide with another agent's handoff.
- Xum persists the handoff in the RESET boundary's rollover metadata. It also persists the request that owns the turn: the latest real user row in the window, cut to 8 KiB, with its item and window IDs. Both fields are optional in the schema, so old boundary rows still parse as rollovers.
- The next window's lead-in shows the request first, then the handoff. If this window has no new handoff, Xum carries the previous boundary's handoff forward and says that it comes from an earlier window.
- The ladder is **handoff request → final handoff step → forced rollover**. The advance warning is removed.
- The final handoff step runs once per window, after a settled step, when the next request is close to the usable limit and still has headroom. It is one provider step with a bounded output, and the tool policy enables only `new_context`. If the agent calls `new_context`, its handoff seals the window. If it does not, Xum seals the window with the carried-forward handoff.
- Memory is no longer part of the rollover. Xum does not preload `context-notes.md`, pin memory writes, or narrow memory context for the final step. Memory keeps its original job: durable facts across sessions.

## Consequences

- Every agent that can call `new_context` can hand off, including read-only agents and parallel sub-agents.
- A single tool call writes the handoff and requests the rollover, so no "confirm, then call in a later step" sequence exists, and a failed side write cannot split them.
- The persisted `contextBudgetFlush` key and the `final: true` warning row stay. A pending legacy flush turn restores as a final handoff step; if the model does not call `new_context`, carry-forward seals it.
- Old histories still render: legacy warn rows show as **Context budget warning**, and old RESET rows have no payload, so their lead-in has no handoff.
- Existing `context-notes.md` files stay as ordinary memory files. They follow the normal hot-set rules.

## Accepted limitations

- The handoff is only as good as the agent writes it. The transcript stays retrievable through `session_history`.
- The final step is skipped when the window is too small, the queue has input, `new_context` or `session_history` is not allowed, or a single step jumps past the final zone. The forced rollover then seals with carry-forward.
- A handoff or request longer than its limit is cut. The lead-in points to the full request row in `session_history`.
