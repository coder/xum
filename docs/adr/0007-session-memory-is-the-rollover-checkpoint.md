---
title: Session Memory Is the Rollover Checkpoint
description: Each agent keeps its own rollover checkpoint in the /memories/session/ scope, a fresh window injects nothing from the old one, and a final prompt gives a last chance to save it
---

# 0007. Session Memory Is the Rollover Checkpoint

## Status

Accepted. Supersedes the `context-notes.md` handoff of [ADR 0005](./0005-token-budget-context-windows.md) and the "no last-chance notes step" limitation of [ADR 0006](./0006-agent-led-context-handoff.md). The handoff target, forced rollover at the usable limit, retrieval, admission, receipts, and privacy floors are unchanged.

## Context

ADR 0005 and ADR 0006 asked the agent to write `workspace/context-notes.md` through the memory tool, confirm the write, and then call `new_context` in a later step. This design had three problems:

1. Read-only agents (for example Explore) cannot write workspace memory, so they could not save a checkpoint.
2. Sub-agents share their parent's workspace notebook, so parallel children could overwrite each other's notes.
3. ADR 0006 removed the final flush. An agent that ignored the handoff request reached the forced rollover with no checkpoint and no last chance.

Xum also special-cased the notes file: a hot-set preload, a pinned write path for the flush turn, and a notes-only memory context.

Codex token-budget mode keeps a living checkpoint in a separate notes tool, injects nothing into the fresh window, and lets the model pull detail back through its history tool. The checkpoint records the window ID and item ID of every relevant user request.

## Decision

- Token budget requires Agent Memory. The mode is active only when both the Token Budget and Agent Memory experiments are on. Settings hides the **Token Budget** option without memory; a saved Token Budget preference stays saved, and the effective strategy is **Summarize**.
- A new memory scope, `/memories/session/`, holds the checkpoint. The memory tool offers it only in token-budget mode. It belongs to the acting workspace, not to the parent notebook, so no other agent reads or overwrites it. Every agent can write it, read-only agents included. It lasts across context windows, is deleted with the workspace, and is excluded from the memory hot set and intuition recall.
- A fresh window injects nothing from the old one. The lead-in tells the agent to read its checkpoint first and then use `session_history`.
- In token-budget mode, the system prompt shows the current and previous context window IDs, and each user row ends with its `session_history` item ID. The guidance asks the agent to record these IDs in its checkpoint.
- `new_context` takes no arguments. It is offered only when `memory` and `session_history` are both allowed.
- The ladder is **handoff request → final prompt → forced rollover**. The final prompt is a row on the ordinary turn, sent once per window when the next request is close to the usable limit and still has headroom. It follows the Codex fallback prompt: do not continue the task, save the checkpoint with `memory`, then call `new_context`, and use no other tools. The restriction is prompt-only. If the agent ignores it, the forced rollover at the usable limit seals the window. The handoff request always comes first: a high usage threshold is clamped below the final zone.
- The old context-notes special cases are removed: no `context-notes.md` preload, no pinned write path, and no notes-only memory context.

## Consequences

- Every agent can save a checkpoint, including read-only agents and parallel sub-agents.
- The checkpoint is only a memory file, so the agent can update it incrementally during the window instead of writing it once at the end.
- Users with Token Budget on and Agent Memory off fall back to automatic summaries.
- The persisted `final: true` warning row stays. Xum no longer reads the `contextBudgetFlush` key: a pending flush turn from an older build resumes as an ordinary continuation with the normal toolset and permissions, and the usable-limit rollover seals the window later.
- Old histories still render: legacy warn rows show as **Context budget warning**.
- Existing `context-notes.md` files stay as ordinary workspace memory. They follow the normal hot-set rules.

## Accepted limitations

- The checkpoint is only as good as the agent writes it. The transcript stays retrievable through `session_history`.
- The final prompt is skipped when the window is too small, `new_context` is not offered, or a single step jumps past the final zone. The forced rollover then seals the window with whatever checkpoint exists.
- The session scope exists only in token-budget mode. With another compaction mode, the memory tool does not list or accept `/memories/session/`, and checkpoints written earlier stay on disk until token-budget mode returns or the workspace is deleted.
