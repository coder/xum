import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config, ProvidersConfigStore } from "@/node/config";
import { AIService } from "./aiService";
import { HistoryService } from "./historyService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { DisposableTempDir } from "./tempDir";
import { buildWorkspaceStatusPrompt, generateWorkspaceStatus } from "./workspaceStatusGenerator";

describe("buildWorkspaceStatusPrompt", () => {
  test("contains the transcript inside delimited markers", () => {
    const prompt = buildWorkspaceStatusPrompt("User: please run tests\nAssistant: running");

    // The transcript block needs explicit delimiters so the model can tell
    // where the transcript ends and the requirements begin. If we ever drop
    // these delimiters, the model is more likely to follow trailing
    // instructions baked into the transcript itself (a real prompt-injection
    // risk for arbitrary chat history).
    expect(prompt).toContain("<transcript>");
    expect(prompt).toContain("</transcript>");
    expect(prompt).toContain("User: please run tests");
    expect(prompt).toContain("Assistant: running");
  });

  test("falls back to a sentinel when transcript is empty", () => {
    const prompt = buildWorkspaceStatusPrompt("");

    // Empty transcripts must still produce a syntactically-valid prompt; the
    // sentinel keeps the small model from inheriting system-prompt context
    // from a previous workspace.
    expect(prompt).toContain("(no recent transcript)");
  });

  test("switches the liveness hint based on the streaming flag", () => {
    // The streaming bit is the highest-signal input for the
    // in-progress-vs-completed distinction the small model historically got
    // wrong. The prompt must visibly switch between "actively streaming" and
    // "finished streaming" guidance so behavior actually differs on each
    // branch — not just receive the option silently.
    const live = buildWorkspaceStatusPrompt("Assistant: Deploying now", { streaming: true });
    const done = buildWorkspaceStatusPrompt("Assistant: Deploying now", { streaming: false });

    expect(live).toContain("actively streaming");
    expect(done).toContain("finished streaming");
    // The streaming branch must rule out past tense; the non-streaming
    // branch must explicitly warn that "finished streaming" ≠ activity
    // complete. Both behaviors are part of the tense-correctness fix and
    // would silently regress if the branches collapsed.
    expect(live).not.toContain("finished streaming");
    expect(done).not.toContain("actively streaming");
  });

  test("documents tool-call lifecycle markers so the model can read them", () => {
    // formatMessageForTranscript emits [tool <name> running|done] markers;
    // the prompt must teach the model what those mean. If this guidance is
    // dropped, the markers become noise and the tense rule falls back to
    // guessing from prose — the exact failure mode this fix addresses.
    const prompt = buildWorkspaceStatusPrompt("Assistant: working\n[tool bash running]");
    expect(prompt).toContain("[tool <name> running]");
    expect(prompt).toContain("[tool <name> done]");
  });
});

describe("generateWorkspaceStatus error paths", () => {
  test("returns a configuration error when no candidates are provided", async () => {
    const fakeAiService = {
      // Asserting this never gets called is the real point of this test —
      // the empty-candidates short-circuit prevents wasteful provider calls
      // for misconfigured workspaces.
      createModel: () => {
        throw new Error("createModel must not be called when no candidates exist");
      },
    } as unknown as Parameters<typeof generateWorkspaceStatus>[2];

    const result = await generateWorkspaceStatus("hello", [], fakeAiService);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error.type).toBe("unknown");
      expect(result.error.error.raw).toContain("No model candidates");
      // No candidates means we never even attempted createModel, so the
      // failure has nothing to do with the transcript — caller must keep
      // retrying so a future config change recovers without a new message.
      expect(result.error.reachedProvider).toBe(false);
    }
  });
});

describe("generateWorkspaceStatus thinking", () => {
  let tempDir: DisposableTempDir;
  let server: http.Server;
  let bodies: Array<Record<string, unknown>>;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = new DisposableTempDir("workspace-status-thinking");
    bodies = [];
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        // Non-retryable, so each candidate sends exactly one request.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "loopback", type: "invalid_request_error" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    tempDir[Symbol.dispose]();
  });

  function createService(): AIService {
    const config = new Config(tempDir.path);
    const providersConfigStore = new ProvidersConfigStore(config.rootDir);
    providersConfigStore.saveProvidersConfig({
      omlx: { providerType: "openai-compatible", baseUrl, apiKey: "test-key" },
      openai: { apiKey: "test-openai-key", baseUrl },
    } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
    return new AIService(
      config,
      new HistoryService(config),
      new InitStateManager(config),
      new ProviderService(config, providersConfigStore),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providersConfigStore
    );
  }

  // Without explicit options a provider runs its own default effort; GLM's
  // chat template renders an absent reasoning_effort as Max.
  test("sends the lowest effort the model allows instead of the provider default", async () => {
    const service = createService();

    await generateWorkspaceStatus(
      "user: fix the login bug",
      ["omlx:GLM-5.3-Flash-oQ4e-mtp"],
      service
    );
    await generateWorkspaceStatus("user: fix the login bug", ["openai:gpt-6.1-sol"], service);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].reasoning_effort).toBe("low");
    expect((bodies[1].reasoning as { effort?: unknown } | undefined)?.effort).toBe("low");
  });
});
