import { useProviderOptionsContext } from "@/browser/contexts/ProviderOptionsContext";

export function useProviderOptions() {
  const context = useProviderOptionsContext();
  return {
    options: context.options,
    has1MContext: context.has1MContext,
    toggle1MContext: context.toggle1MContext,
  };
}
