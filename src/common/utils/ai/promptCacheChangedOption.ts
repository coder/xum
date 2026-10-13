/**
 * A prompt-cache request option that changed between two requests (see
 * comparePromptCachePrefix in src/node/services/promptCachePrefix.ts). Shared
 * by the detector's description and the timeline row.
 */

/**
 * An option value as a break reports it: a short JSON string for an object
 * value such as `thinking` or `toolChoice`. Never prompt text.
 */
export type PromptCacheOptionValue = string | number | boolean | null;

export interface PromptCacheChangedOption {
  key: string;
  /**
   * Both absent for options whose value can hold arguments or schemas
   * (`serverTools`, `format`): the break then names only the key.
   */
  previous?: PromptCacheOptionValue;
  next?: PromptCacheOptionValue;
}

/** "effort xhigh -> high", or only the key when no values were recorded. */
export function describeChangedOption(option: PromptCacheChangedOption): string {
  if (option.previous === undefined && option.next === undefined) return option.key;
  return `${option.key} ${String(option.previous ?? null)} -> ${String(option.next ?? null)}`;
}
