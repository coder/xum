/**
 * Snapshot of the process state at the moment the fixture has loaded Radix but not yet the
 * DOM harness. Imported by domIsolation.radixOrder.child.test.tsx between those two imports;
 * a live binding could not record the pre-rebind hook, so the value is copied here.
 */
import { useLayoutEffect } from "@radix-ui/react-use-layout-effect";

export const documentBeforeHarness = typeof globalThis.document;
export const radixLayoutEffectBeforeHarness: unknown = useLayoutEffect;
