import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, ProvidersConfigStore } from "@/node/config";
import { VoiceService } from "./voiceService";

async function withTempConfig(
  run: (config: Config, service: VoiceService) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-voice-service-"));
  try {
    const config = new Config(tmpDir);
    const service = new VoiceService(config);
    await run(config, service);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("VoiceService.transcribe", () => {
  // Voice credential resolution consults process.env (config -> file -> env
  // funnel), so pin the env key to keep "unconfigured" scenarios deterministic.
  let savedOpenAiEnvKey: string | undefined;

  beforeEach(() => {
    savedOpenAiEnvKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedOpenAiEnvKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedOpenAiEnvKey;
    }
  });

  it("returns provider-disabled error without calling fetch", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({
          success: false,
          error:
            "OpenAI provider is disabled. Enable it in Settings → Providers to use voice input.",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("calls fetch when OpenAI provider is enabled with an API key", async () => {
    await withTempConfig(async (config, service) => {
      new ProvidersConfigStore(config.rootDir).saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({ success: true, data: "transcribed text" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
        expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(init?.headers).toEqual({
          Authorization: "Bearer sk-test",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  it("returns missing-key error when OpenAI has no API key", async () => {
    await withTempConfig(async (_config, service) => {
      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({
          success: false,
          error: "Voice input requires an OpenAI API key. Configure in Settings → Providers.",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
