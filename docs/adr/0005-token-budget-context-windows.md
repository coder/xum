---
title: Token-Budget Context Windows
description: An opt-in automatic reset policy with bounded retrieval and a manual-reset privacy floor
---

# 0005. Automatic Rollover Can Retrieve Earlier Context Windows

## Status

Accepted. Amends only consequence 2 of [ADR 0003](./0003-context-boundaries-for-compaction-and-reset.md) for automatic token-budget rollover.

## Context

Repeated automatic summaries lose detail and consume inference tokens. An opt-in policy can instead start a fresh Active Conversation Context while retaining Transcript History for explicit, bounded retrieval. Manual resets must keep their privacy semantics.

## Decision

Automatic rollover uses a provider-invisible Context Reset Boundary followed by a provider-visible synthetic lead-in. The lead-in identifies the new window and offers `session_history` retrieval; it does not summarize old messages. Earlier windows are retrievable only while the experiment is enabled and never across the newest manual reset. Manual `/clear --soft` remains provider-invisible, adds no lead-in, and establishes that privacy floor.

Manual `/compact`, idle compaction, continuous compaction, and effective RLM retain their existing behavior and take precedence over rollover. Existing edited-file carryover is unchanged. With automatic handling disabled, no rollover or flush warning is emitted, but hard assembled-request preflight still blocks oversized requests. Disabling `session_history` explicitly blocks at the rollover threshold rather than falling back to lossy summaries.

A once-per-window warning offers a settled tool step to write the conventional `workspace/context-notes.md` file (up to 8 KiB, if writable). Its reserved hot-set slot still requires both Memory and Memory Hot Set. Rollover waits for a settled tool step, preserves tool call/result pairs, and allows only one pending rollover to be handled on the next send. Restart stays paused: it does not resurrect a queued continuation; the next message derives context pressure from persisted history.

The reset, lead-in, and triggering message or continuation are written in one append operation before continuation. This is not a filesystem transaction: a crash can leave a complete prefix. Request assembly must tolerate that prefix without duplicating rollover or resurrecting queued work. A payload that cannot fit even in a fresh window is rejected before a provider request.

## Consequences

- `session_history` list/search/read is bounded: 16 KiB per tool result, 2 MiB scanned, 500 rows, and a 1 MiB per-line cap. Retrieval is scoped to the calling workspace and the manual-reset privacy floor.
- Old windows remain on disk and in transcript display/export. The lead-in stays hidden in normal transcript display; warnings render as machine messages, not human prompts.
- Opting out disables retrieval, not retention. ADR 0003's remaining decisions and consequences are unchanged.
