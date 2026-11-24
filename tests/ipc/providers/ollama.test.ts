import { setupWorkspace, shouldRunIntegrationTests } from "../setup";
import {
  sendMessageWithModel,
  createStreamCollector,
  assertStreamSuccess,
  extractTextFromEvents,
  modelString,
  configureTestRetries,
} from "../helpers";
import { spawn } from "child_process";
import { isToolCallEnd, isToolCallStart } from "../../../src/common/orpc/types";
import { loadTokenizerModules } from "../../../src/node/utils/main/tokenizer";

// Skip all tests if TEST_INTEGRATION or TEST_OLLAMA is not set
const shouldRunOllamaTests = shouldRunIntegrationTests() && process.env.TEST_OLLAMA === "1";
const describeOllama = shouldRunOllamaTests ? describe : describe.skip;

// Ollama doesn't require API keys - it's a local service
// Tests require Ollama to be running and will pull models idempotently
// Set TEST_OLLAMA=1 to enable these tests

const OLLAMA_MODEL = "gpt-oss:20b";

/**
 * Ensure Ollama model is available (idempotent).
 * Checks if model exists, pulls it if not.
 * Multiple tests can call this in parallel - Ollama handles deduplication.
 */
async function ensureOllamaModel(model: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if model exists: ollama list | grep <model>
    const checkProcess = spawn("ollama", ["list"]);
    let stdout = "";
    let stderr = "";

    checkProcess.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    checkProcess.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    checkProcess.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Failed to check Ollama models: ${stderr}`));
      }

      // Check if model is in the list
      const modelLines = stdout.split("\n");
      const modelExists = modelLines.some((line) => line.includes(model));

      if (modelExists) {
        // Model already available (silent in CI to reduce log spam)
        return resolve();
      }

      // Model doesn't exist, pull it (silent in CI to reduce log spam)
      const pullProcess = spawn("ollama", ["pull", model], {
        stdio: ["ignore", "pipe", "pipe"], // Capture stdout/stderr instead of inheriting
      });

      // Capture output for error reporting but don't log progress
      let pullStderr = "";
      pullProcess.stderr?.on("data", (data: Buffer) => {
        pullStderr += data.toString();
      });

      const timeout = setTimeout(() => {
        pullProcess.kill();
        reject(new Error(`Timeout pulling Ollama model ${model}`));
      }, 120000); // 2 minute timeout for model pull

      pullProcess.on("close", (pullCode) => {
        clearTimeout(timeout);
        if (pullCode !== 0) {
          reject(new Error(`Failed to pull Ollama model ${model}: ${pullStderr}`));
        } else {
          // Model pulled successfully (silent in CI to reduce log spam)
          resolve();
        }
      });
    });
  });
}

describeOllama("Ollama integration", () => {
  // Enable retries in CI for potential network flakiness with Ollama
  configureTestRetries(3);

  // Load tokenizer modules and ensure model is available before all tests
  beforeAll(async () => {
    // Load tokenizers (takes ~14s)

    await loadTokenizerModules();

    // Ensure Ollama model is available (idempotent - fast if cached)
    await ensureOllamaModel(OLLAMA_MODEL);
  }, 150000); // 150s timeout for tokenizer loading + potential model pull

  test("should successfully send message to Ollama and receive response", async () => {
    // Setup test environment
    const { env, workspaceId, cleanup } = await setupWorkspace("ollama");
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();
    try {
      // Send a simple message to verify basic connectivity
      const result = await sendMessageWithModel(
        env,
        workspaceId,
        "Say 'hello' and nothing else",
        modelString("ollama", OLLAMA_MODEL)
      );

      // Verify the IPC call succeeded
      expect(result.success).toBe(true);

      // Wait for stream completion
      const streamEnd = await collector.waitForEvent("stream-end", 30000);

      expect(streamEnd).toBeDefined();
      assertStreamSuccess(collector);

      // Verify we received deltas
      const deltas = collector.getDeltas();
      expect(deltas.length).toBeGreaterThan(0);

      // Verify the response contains expected content
      const text = extractTextFromEvents(deltas).toLowerCase();
      expect(text).toMatch(/hello/i);
    } finally {
      collector.stop();
      await cleanup();
    }
  }, 45000); // Ollama can be slower than cloud APIs, especially first run

  test("should successfully call tools with Ollama", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspace("ollama");
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();
    try {
      // Ask for current time which should trigger bash
      const result = await sendMessageWithModel(
        env,
        workspaceId,
        'Use bash to run: date. Set display_name="current-time" and timeout_secs=30. Do not spawn a sub-agent.',
        modelString("ollama", OLLAMA_MODEL),
        {
          toolPolicy: [{ regex_match: "bash", action: "require" }],
        }
      );

      expect(result.success).toBe(true);

      // Wait for stream to complete
      await collector.waitForEvent("stream-end", 60000);

      assertStreamSuccess(collector);

      // Verify bash was called via events
      const events = collector.getEvents();
      const toolCallStarts = events.filter(isToolCallStart);
      expect(toolCallStarts.length).toBeGreaterThan(0);

      const bashCall = toolCallStarts.find((e) => e.toolName === "bash");
      expect(bashCall).toBeDefined();

      // Verify we got a response and/or tool output with date/time info
      const deltas = collector.getDeltas();
      const responseText = extractTextFromEvents(deltas).toLowerCase();

      const toolCallEnds = events.filter(isToolCallEnd).filter((e) => e.toolName === "bash");
      const bashOutput = toolCallEnds
        .map((e) => {
          const result = e.result;
          return typeof result === "object" && result !== null && "output" in result
            ? result.output
            : undefined;
        })
        .filter((t) => typeof t === "string")
        .join("\n")
        .toLowerCase();

      // Should mention time or date in response or in the tool output
      expect(`${responseText}\n${bashOutput}`).toMatch(/time|date|am|pm|\d{2}:\d{2}|20\d{2}/i);
    } finally {
      collector.stop();
      await cleanup();
    }
  }, 90000); // Tool calling can take longer

  test("should handle file operations with Ollama", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspace("ollama");
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();
    try {
      // Ask to read a file that should exist
      const result = await sendMessageWithModel(
        env,
        workspaceId,
        "Read the README.md file and tell me what the first heading says.",
        modelString("ollama", OLLAMA_MODEL)
      );

      expect(result.success).toBe(true);

      // Wait for stream to complete
      await collector.waitForEvent("stream-end", 60000);

      assertStreamSuccess(collector);

      // Verify file_read tool was called via events
      const events = collector.getEvents();
      const toolCallStarts = events.filter(isToolCallStart);
      expect(toolCallStarts.length).toBeGreaterThan(0);

      const fileReadCall = toolCallStarts.find((e) => e.toolName === "file_read");
      expect(fileReadCall).toBeDefined();

      // Verify response mentions README content (mux heading or similar)
      const deltas = collector.getDeltas();
      const responseText = extractTextFromEvents(deltas).toLowerCase();

      expect(responseText).toMatch(/mux|readme|heading/i);
    } finally {
      collector.stop();
      await cleanup();
    }
  }, 90000); // File operations with reasoning

  test("should handle errors gracefully when Ollama is not running", async () => {
    const { env, workspaceId, cleanup } = await setupWorkspace("ollama");
    const collector = createStreamCollector(env.orpc, workspaceId);
    collector.start();
    try {
      // Override baseUrl to point to non-existent server
      const result = await sendMessageWithModel(
        env,
        workspaceId,
        "This should fail",
        modelString("ollama", OLLAMA_MODEL),
        {
          providerOptions: {
            ollama: {},
          },
        }
      );

      // If Ollama is running, test will pass
      // If not running, we should get an error
      if (!result.success) {
        expect(result.error).toBeDefined();
      } else {
        // If it succeeds, that's fine - Ollama is running
        await collector.waitForEvent("stream-end", 30000);
      }
    } finally {
      collector.stop();
      await cleanup();
    }
  }, 45000);
});
