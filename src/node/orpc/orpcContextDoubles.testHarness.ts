import type { ORPCContext } from "./context";

/**
 * Service doubles for an ORPCContext. Each service is optional and partial, but every method a
 * test supplies is checked against the real service signature, which an `as unknown as` cast
 * would skip. A test supplies only the services and methods its route reaches.
 */
export type OrpcContextDoubles = {
  [K in Exclude<keyof ORPCContext, "effect/context">]?: Partial<ORPCContext[K]>;
} & {
  // An Effect Context holds only the tags a test provides, and its type cannot say "some of
  // AppTags", so this one field stays unchecked.
  "effect/context"?: unknown;
};

/** The context the router and server take, built from doubles (see OrpcContextDoubles). */
export function orpcContextFromDoubles(doubles: OrpcContextDoubles): ORPCContext {
  // A route that reaches a service or method the test did not supply throws a TypeError.
  return doubles as ORPCContext;
}
