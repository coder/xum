import type { SendMessageOptions } from "@/common/orpc/types";

/**
 * Provider options for a request built from a chat's send options. The chat's speed choice
 * travels as the OpenAI tier, which the model factory also maps to Anthropic `speed` and the
 * xAI tier, so it must win over provider-wide defaults on every request the chat makes,
 * including headless ones such as continuous compaction.
 */
export function getSendProviderOptions(
  options: Pick<SendMessageOptions, "providerOptions" | "serviceTier"> | undefined
): SendMessageOptions["providerOptions"] {
  return options?.serviceTier == null
    ? options?.providerOptions
    : {
        ...options.providerOptions,
        openai: { ...options.providerOptions?.openai, serviceTier: options.serviceTier },
      };
}
