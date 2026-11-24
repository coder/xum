import type { Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import { ProvidersConfigStore, type Config } from "@/node/config";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

interface OpenAITranscriptionConfig {
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  enabled?: unknown;
}

/**
 * Voice input service using the OpenAI transcription API.
 */
export class VoiceService {
  private readonly providersConfigStore: ProvidersConfigStore;

  constructor(config: Config, providersConfigStore?: ProvidersConfigStore) {
    this.providersConfigStore = providersConfigStore ?? new ProvidersConfigStore(config.rootDir);
  }

  /**
   * Transcribe audio from base64-encoded data using OpenAI.
   * @param audioBase64 Base64-encoded audio data
   * @returns Transcribed text or error
   */
  async transcribe(audioBase64: string): Promise<Result<string, string>> {
    try {
      const providersConfig = this.providersConfigStore.loadProvidersConfig() ?? {};
      const openaiConfig = providersConfig.openai as OpenAITranscriptionConfig | undefined;

      if (isProviderDisabledInConfig(openaiConfig ?? {})) {
        return {
          success: false,
          error:
            "OpenAI provider is disabled. Enable it in Settings → Providers to use voice input.",
        };
      }

      // Resolve through the shared config -> file -> env funnel so voice honors
      // the same credential fallbacks as chat requests (and ignores legacy
      // op:// references from the removed 1Password integration).
      const openaiApiKey = resolveProviderCredentials(
        "openai",
        providersConfig.openai ?? {}
      ).apiKey;
      if (!openaiApiKey) {
        return {
          success: false,
          error: "Voice input requires an OpenAI API key. Configure in Settings → Providers.",
        };
      }

      return await this.transcribeWithOpenAI(audioBase64, openaiApiKey, openaiConfig);
    } catch (error) {
      const message = getErrorMessage(error);
      return { success: false, error: `Transcription failed: ${message}` };
    }
  }

  private async transcribeWithOpenAI(
    audioBase64: string,
    apiKey: string,
    openaiConfig: OpenAITranscriptionConfig | undefined
  ): Promise<Result<string, string>> {
    const response = await fetch(this.resolveOpenAITranscriptionUrl(openaiConfig), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: this.createTranscriptionFormData(audioBase64),
    });

    if (!response.ok) {
      return { success: false, error: await this.extractErrorMessage(response) };
    }

    const text = await response.text();
    return { success: true, data: text };
  }

  private resolveOpenAITranscriptionUrl(
    openaiConfig: OpenAITranscriptionConfig | undefined
  ): string {
    const baseURL = openaiConfig?.baseUrl ?? openaiConfig?.baseURL;
    if (!baseURL) {
      return OPENAI_TRANSCRIPTION_URL;
    }

    return `${baseURL.replace(/\/+$/, "")}/audio/transcriptions`;
  }

  private createTranscriptionFormData(audioBase64: string): FormData {
    // Decode base64 to binary.
    const binaryString = atob(audioBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const audioBlob = new Blob([bytes], { type: "audio/webm" });
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("response_format", "text");
    return formData;
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    const errorText = await response.text();
    let errorMessage = `Transcription failed: ${response.status}`;

    try {
      const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
      if (errorJson.error?.message) {
        errorMessage = errorJson.error.message;
      }
    } catch {
      if (errorText) {
        errorMessage = errorText;
      }
    }

    return errorMessage;
  }
}
