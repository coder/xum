import React from "react";
import { Cpu, Server } from "lucide-react";
import AnthropicIcon from "@/browser/assets/icons/anthropic.svg?react";
import OpenAIIcon from "@/browser/assets/icons/openai.svg?react";
import GoogleIcon from "@/browser/assets/icons/google.svg?react";
import XAIIcon from "@/browser/assets/icons/xai.svg?react";
import MetaIcon from "@/browser/assets/icons/meta.svg?react";
import OpenRouterIcon from "@/browser/assets/icons/openrouter.svg?react";
import OllamaIcon from "@/browser/assets/icons/ollama.svg?react";
import DeepSeekIcon from "@/browser/assets/icons/deepseek.svg?react";
import MoonshotAIIcon from "@/browser/assets/icons/moonshotai.svg?react";
import ZaiIcon from "@/browser/assets/icons/zai.svg?react";
import AWSIcon from "@/browser/assets/icons/aws.svg?react";
import GitHubIcon from "@/browser/assets/icons/github.svg?react";
import CoderIcon from "@/browser/assets/icons/coder.svg?react";
import OMLXIcon from "@/browser/assets/icons/omlx.svg?react";
import LMStudioIcon from "@/browser/assets/icons/lmstudio.svg?react";
import LlamaCppIcon from "@/browser/assets/icons/llamacpp.svg?react";
import VLLMIcon from "@/browser/assets/icons/vllm.svg?react";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";
import { cn } from "@/common/lib/utils";
import {
  isBrandIconKey,
  resolveProviderIconKey,
  type BrandIconKey,
  type ProviderIconConfig,
} from "./providerIconKey";

/**
 * Brand icons for built-in providers and recognized local runtimes.
 * When adding a new provider, add its icon import above and entry here.
 */
const PROVIDER_ICONS: Record<BrandIconKey, React.FC> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: GoogleIcon,
  "google-vertex": GoogleIcon,
  xai: XAIIcon,
  meta: MetaIcon,
  deepseek: DeepSeekIcon,
  moonshotai: MoonshotAIIcon,
  zai: ZaiIcon,
  openrouter: OpenRouterIcon,
  bedrock: AWSIcon,
  ollama: OllamaIcon,
  "github-copilot": GitHubIcon,
  coder: CoderIcon,
  omlx: OMLXIcon,
  lmstudio: LMStudioIcon,
  llamacpp: LlamaCppIcon,
  vllm: VLLMIcon,
};

/**
 * Check if a provider has a brand icon (built-in or recognized local runtime).
 * The generic local and custom fallback icons do not count.
 */
export function hasProviderIcon(provider: string, config?: ProviderIconConfig | null): boolean {
  return isBrandIconKey(resolveProviderIconKey(provider, config));
}

export interface ProviderIconProps {
  provider: string;
  className?: string;
}

/**
 * Renders a provider's icon. Custom providers that point at a known local runtime get its
 * logo; other local-network endpoints get a generic machine icon, the rest a neutral server.
 * Icons are sized to 1em by default to match surrounding text.
 */
export function ProviderIcon(props: ProviderIconProps) {
  const { config } = useProvidersConfig();
  const iconKey = resolveProviderIconKey(props.provider, config?.[props.provider]);
  const IconComponent = isBrandIconKey(iconKey) ? PROVIDER_ICONS[iconKey] : null;
  const FallbackIcon = iconKey === "local" ? Cpu : Server;

  return (
    <span
      className={cn(
        "inline-block h-[1em] w-[1em] align-[-0.125em] [&_svg]:block [&_svg]:h-full [&_svg]:w-full",
        // The lucide fallbacks are stroke based; provider SVGs use fill.
        IconComponent == null
          ? "[&_svg]:stroke-current [&_svg]:fill-none"
          : "[&_svg]:fill-current [&_svg_.st0]:fill-current",
        props.className
      )}
    >
      {IconComponent ? <IconComponent /> : <FallbackIcon />}
    </span>
  );
}

export interface ProviderWithIconProps {
  provider: string;
  className?: string;
  iconClassName?: string;
  /** Show display name instead of raw provider key */
  displayName?: boolean;
}

/**
 * Renders a provider name with its icon.
 * Custom providers use the neutral fallback icon.
 */
export function ProviderWithIcon(props: ProviderWithIconProps) {
  const name = props.displayName
    ? (PROVIDER_DISPLAY_NAMES[props.provider as ProviderName] ?? props.provider)
    : props.provider;

  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", props.className)}>
      <ProviderIcon provider={props.provider} className={props.iconClassName} />
      <span>{name}</span>
    </span>
  );
}
