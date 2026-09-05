---
title: Token-Budget Context Windows
description: Start fresh context windows without automatic summaries and retrieve earlier work on demand
---

Enable **Token-budget context windows** in **Settings → Experiments** to replace usage-triggered automatic summaries with fresh context windows. The experiment is off by default.

## Threshold and precedence

Use the existing context-usage slider to choose the per-model threshold. The **Rolls over by N%** label includes the five-percentage-point force buffer: a 70% slider setting displays **Rolls over by 75%**. Automatic rollover is evaluated when sending and after a settled tool step. The displayed percentage is an upper bound; the hard request ceiling takes precedence if reached first. Rollover starts a fresh window without summarizing earlier messages. The transcript shows a **Context window rollover** divider; earlier messages remain on disk, in the UI, and in exports.

- Manual `/compact` and idle compaction still summarize normally.
- Continuous compaction and effective RLM take precedence over rollover.
- Setting the usage threshold to **100%** disables automatic rollover and its warning. Hard request-size checks still apply.
- Explicitly disabling `session_history` blocks at the rollover threshold instead of falling back to a lossy summary.

## Keeping useful context

Once per window, a machine-authored warning asks the agent to write important context to the conventional `workspace/context-notes.md` file, up to **8 KiB**, if the workspace is writable. This is an opportunity to preserve notes, not a guarantee that the agent writes them. The notes' reserved hot-set slot still requires both **Memory** and **Memory Hot Set**; this experiment does not enable either.

The next window receives a model-only lead-in, not a summary. While the experiment is enabled, the agent can use `session_history` to list windows, search, or read earlier messages in the same workspace. Results are capped at **16 KiB** per call, with scans bounded to **2 MiB**, **500 rows**, and **1 MiB per line**. Large histories may require further bounded calls.

The newest manual `/clear --soft` is a privacy floor: the tool cannot retrieve messages before it. Manual reset behavior and edited-file carryover are unchanged. Turning the experiment off removes retrieval access without deleting old windows.

## Pauses and size limits

Rollover stops only after a tool step settles, preserving tool call/result pairs. Only one rollover may be pending; it is handled on the next send. Restart leaves the workspace paused rather than resurrecting a queued continuation, and the next message re-evaluates pressure from history.

The boundary, lead-in, and triggering message or continuation are saved as one atomic, all-or-nothing batch. Recovery also tolerates incomplete batches in legacy or externally modified histories. Requests too large even for a fresh window are blocked before contacting the provider; rollover cannot make oversized attachments or instructions fit.
