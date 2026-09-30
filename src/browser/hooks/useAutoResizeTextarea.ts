import { useLayoutEffect, useRef, type RefObject } from "react";

function preservesPreviousValueAsInsertion(previousValue: string, nextValue: string): boolean {
  if (nextValue.length <= previousValue.length) {
    return false;
  }

  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < previousValue.length &&
    previousValue[sharedPrefixLength] === nextValue[sharedPrefixLength]
  ) {
    sharedPrefixLength += 1;
  }

  let sharedSuffixLength = 0;
  while (
    sharedSuffixLength < previousValue.length - sharedPrefixLength &&
    previousValue[previousValue.length - 1 - sharedSuffixLength] ===
      nextValue[nextValue.length - 1 - sharedSuffixLength]
  ) {
    sharedSuffixLength += 1;
  }

  return sharedPrefixLength + sharedSuffixLength === previousValue.length;
}

// Read the textarea's current inline `height` style as a finite px number, or null when the
// style is empty / non-px / non-finite. Centralizing the parseFloat + isFinite pair keeps the
// canOnlyGrow first-render fallback and the post-resize verification (which guards against a
// stale cache after `auto` writes or external clears) from drifting on what counts as a
// usable inline height.
function readInlineHeightPx(el: HTMLTextAreaElement): number | null {
  const value = Number.parseFloat(el.style.height);
  return Number.isFinite(value) ? value : null;
}

/**
 * Auto-resize a textarea to fit its content.
 * Uses useLayoutEffect to measure and set height synchronously before paint.
 *
 * `sizingKey` is any value whose change can move the element's CSS height floor (the composer
 * lowers its `min-height` on phone viewports). Without it the cached inline height pins the old
 * floor until the draft itself changes.
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightVh = 30,
  sizingKey?: string
): void {
  const previousValueRef = useRef<string | null>(null);
  const previousMaxRef = useRef<number | null>(null);
  const appliedHeightRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const max = window.innerHeight * (maxHeightVh / 100);

    // Fast path: an empty textarea needs no inline height at all — consumers size the
    // empty state via CSS (rows={1} + min-height). Measuring it through the
    // `auto` + scrollHeight dance below forces a synchronous reflow of every dirty
    // node, and this effect runs inside React's commit phase. On workspace switch the
    // entire transcript has just mounted, so that reflow lays out the whole document
    // (~50k nodes in large chats) before first paint — profiled as the single hottest
    // frame during chat switching. Drafts are empty in the common case, so skip
    // measurement entirely and clear any stale inline height (e.g. after send).
    if (value === "") {
      if (el.style.height !== "") {
        el.style.height = "";
      }
      appliedHeightRef.current = null;
      previousValueRef.current = value;
      previousMaxRef.current = max;
      return;
    }

    const previousValue = previousValueRef.current;
    const previousMax = previousMaxRef.current;
    const canOnlyGrow =
      previousValue !== null &&
      previousMax === max &&
      preservesPreviousValueAsInsertion(previousValue, value);

    let nextHeight: number;
    if (canOnlyGrow) {
      // User typing in a large transcript should not reset the textarea to "auto" on
      // every key. That temporary height mutation forces the surrounding flex column
      // (including all chat rows) through layout even when the composer height is
      // unchanged. For pure insertions we only need to grow if scrollHeight exceeds
      // the currently applied height; shrinking paths still use the full reset below.
      const appliedHeight = appliedHeightRef.current ?? readInlineHeightPx(el);
      const scrollHeight = Math.min(el.scrollHeight, max);
      nextHeight = appliedHeight !== null ? Math.max(appliedHeight, scrollHeight) : scrollHeight;
    } else {
      // Deletions, same-length replacements, viewport changes, and first render may
      // shrink the textarea, so measure from its intrinsic content height.
      el.style.height = "auto";
      nextHeight = Math.min(el.scrollHeight, max);
    }

    // The cached height can match even after this effect temporarily set `auto`, or
    // after callers cleared the inline style. Verify the DOM still has the px height
    // before skipping the write; otherwise large drafts collapse to the CSS min-height.
    const currentInlineHeight = readInlineHeightPx(el);
    const inlineHeightMatches =
      currentInlineHeight !== null && Math.abs(currentInlineHeight - nextHeight) < 0.5;

    if (appliedHeightRef.current !== nextHeight || !inlineHeightMatches) {
      el.style.height = `${nextHeight}px`;
      appliedHeightRef.current = nextHeight;
    }

    previousValueRef.current = value;
    previousMaxRef.current = max;
  }, [ref, value, maxHeightVh, sizingKey]);
}
