import { useSyncExternalStore } from "react";
import assert from "@/common/utils/assert";
import { isDynamicToolPart } from "@/common/types/toolParts";
import type { getToolComponent } from "./getToolComponent";
import type { ProposePlanToolCall } from "../ProposePlanToolCall";

// The tool cards (getToolComponent's registry, ~150 KB brotli with markdown-it and framer-motion)
// are off the workspace page's first load (T3, #5971): a chat without tool calls never fetches
// them. The lazy chunk (toolCardsLoader) publishes them here, and each tool row re-renders in
// place: rows never suspend, because a Suspense swap replaces every DOM node of its subtree.
// This module has no UI imports, so WorkspaceStore can request the chunk from event code.
export interface ToolCards {
  getToolComponent: typeof getToolComponent;
  ProposePlanToolCall: typeof ProposePlanToolCall;
}

let cards: ToolCards | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const notify = () => {
  for (const listener of listeners) listener();
};

const waiters = new Set<() => void>();

export function publishToolCards(next: ToolCards): void {
  // The chunk evaluates once per page; a second, different registry would be a bundling bug.
  assert(cards === null || cards.getToolComponent === next.getToolComponent, "tool cards differ");
  if (cards !== null) return;
  cards = next;
  notify();
  for (const waiter of [...waiters]) waiter();
}

/**
 * Runs `callback` once the cards publish, or after `timeoutMs` (a failed or slow chunk must not
 * hold the caller forever). Check toolCardsLoaded() first: the cards publish only once.
 */
export function afterToolCardsLoad(timeoutMs: number, callback: () => void): void {
  const done = () => {
    if (!waiters.delete(done)) return;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(done, timeoutMs);
  waiters.add(done);
}

export function toolCardsLoaded(): boolean {
  return cards !== null;
}

/**
 * Starts the cards' chunk download before a tool row mounts (history rows with tool calls, a
 * live stream). Idempotent: only the first call after page load notifies.
 */
export function requestToolCards(): void {
  if (requested || cards !== null) return;
  requested = true;
  notify();
}

/** Requests the cards when one of these history rows holds a tool call. */
export function requestToolCardsForRows(rows: ReadonlyArray<{ parts: readonly unknown[] }>): void {
  if (rowsHaveToolCalls(rows)) requestToolCards();
}

export function rowsHaveToolCalls(rows: ReadonlyArray<{ parts: readonly unknown[] }>): boolean {
  return rows.some((row) => row.parts.some(isDynamicToolPart));
}

/** The loaded cards, or null until the lazy chunk has evaluated. */
export function useToolCards(): ToolCards | null {
  return useSyncExternalStore(subscribe, () => cards);
}

/** True once something asked for the cards and they are not loaded yet. */
export function useToolCardsPending(): boolean {
  return useSyncExternalStore(subscribe, () => requested && cards === null);
}
