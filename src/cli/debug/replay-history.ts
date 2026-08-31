#!/usr/bin/env bun
import * as path from "path";

/**
 * Debug script to replay a chat history and send a new message.
 * Useful for reproducing errors with specific conversation contexts.
 *
 * Usage:
 *   bun src/debug/replay-history.ts <history-file.json> <message> [--model <model>]
 *
 * Example:
 *   bun src/debug/replay-history.ts /tmp/chat-broken.json "test message" --model openai:gpt-5-codex
 */

import * as fs from "fs";
import { parseArgs } from "util";
import { defaultConfig } from "@/node/config";
import type { MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { createMuxMessage } from "@/common/types/message";
import { InitStateManager } from "@/node/services/initStateManager";
import { AIService } from "@/node/services/aiService";
import { ProviderService } from "@/node/services/providerService";
import { HistoryService } from "@/node/services/historyService";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string", short: "m" },
    thinking: { type: "string", short: "t" },
  },
  allowPositionals: true,
});

const historyFile = positionals[0];
const messageText = positionals[1];

if (!historyFile || !messageText) {
  console.error(
    "Usage: bun src/debug/replay-history.ts <history-file.json> <message> [--model <model>]"
  );
  console.error(
    "Example: bun src/debug/replay-history.ts /tmp/chat-broken.json 'test' --model openai:gpt-5-codex"
  );
  process.exit(1);
}

if (!fs.existsSync(historyFile)) {
  console.error(`❌ History file not found: ${historyFile}`);
  process.exit(1);
}

async function main() {
  console.log(`\n=== Replay History Debug Tool ===\n`);
  console.log(`History file: ${historyFile}`);
  console.log(`Message: ${messageText}`);
  console.log(`Model: ${values.model ?? "default (openai:gpt-5-codex)"}\n`);

  // Read history
  const historyContent = fs.readFileSync(historyFile, "utf-8");
  let messages: MuxMessage[];

  try {
    // Try parsing as JSON array first
    messages = JSON.parse(historyContent) as MuxMessage[];
    if (!Array.isArray(messages)) {
      messages = [messages];
    }
  } catch {
    // Try parsing as JSONL
    messages = historyContent
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as MuxMessage);
  }

  console.log(`📝 Loaded ${messages.length} messages from history\n`);

  // Display summary
  for (const msg of messages) {
    const preview =
      msg.role === "user"
        ? (msg.parts.find((p) => p.type === "text")?.text?.substring(0, 60) ?? "")
        : `[${msg.parts.length} parts: ${msg.parts.map((p) => p.type).join(", ")}]`;
    const model = msg.metadata?.model ?? "unknown";
    console.log(`  ${msg.role.padEnd(9)} (${model}): ${preview}`);
  }

  // Create a temporary workspace
  const workspaceId = `debug-replay-${Date.now()}`;
  const sessionDir = path.join(defaultConfig.sessionsDir, workspaceId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Create workspace metadata
  const metadataPath = path.join(sessionDir, "metadata.json");
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      id: workspaceId,
      projectName: "debug",
      workspacePath: `/tmp/${workspaceId}`,
    })
  );

  const chatHistoryPath = path.join(sessionDir, "chat.jsonl");

  // Write history to temp workspace
  const historyLines = messages.map((m) => JSON.stringify({ ...m, workspaceId })).join("\n");
  fs.writeFileSync(chatHistoryPath, historyLines + "\n");

  console.log(`\n✓ Created temporary workspace: ${workspaceId}`);

  // Add new user message to the history
  const userMessage = createMuxMessage(
    `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    "user",
    messageText,
    { timestamp: Date.now(), historySequence: messages.length }
  );
  messages.push(userMessage);

  console.log(`\n📤 Sending message: "${messageText}"\n`);

  // Initialize services - AIService creates its own StreamManager
  const config = defaultConfig;
  const historyService = new HistoryService(config);
  const initStateManager = new InitStateManager(config);
  const providerService = new ProviderService(config);
  const aiService = new AIService(config, historyService, initStateManager, providerService);

  const modelString = values.model ?? "openai:gpt-5-codex";
  const thinkingLevel = enforceThinkingPolicy(
    modelString,
    (values.thinking ?? "high") as ThinkingLevel
  );

  try {
    // Stream the message - pass all messages including the new one
    const result = await aiService.streamMessage({
      messages,
      workspaceId,
      modelString,
      thinkingLevel,
    });

    if (!result.success) {
      console.error(`\n❌ Error:`, JSON.stringify(result.error, null, 2));
      process.exit(1);
    }

    console.log(`✓ Stream started`);

    // Wait for stream to complete
    console.log(`\n⏳ Waiting for stream to complete...\n`);

    // Subscribe to stream events
    let hasError = false;
    let errorMessage = "";

    interface StreamEvent {
      workspaceId: string;
      type: string;
      toolName?: string;
      error?: string;
    }

    aiService.on("stream-event", (event: StreamEvent) => {
      if (event.workspaceId !== workspaceId) return;

      if (event.type === "stream-start") {
        console.log(`[${event.type}] Started`);
      } else if (event.type === "reasoning-delta" || event.type === "text-delta") {
        // Don't log every delta, too verbose
      } else if (event.type === "reasoning-end") {
        console.log(`[${event.type}] Reasoning complete`);
      } else if (event.type === "tool-call-start") {
        console.log(`[${event.type}] Tool: ${event.toolName ?? "unknown"}`);
      } else if (event.type === "tool-call-end") {
        console.log(`[${event.type}] Tool complete`);
      } else if (event.type === "stream-end") {
        console.log(`[${event.type}] Stream complete`);
      } else if (event.type === "stream-error") {
        console.error(`\n❌ [${event.type}] ${event.error ?? "unknown error"}`);
        errorMessage = event.error ?? "";
        hasError = true;
      } else {
        console.log(`[${event.type}]`);
      }
    });

    // Wait for completion
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
        const aiServiceInternals = aiService as unknown as {
          streamManager: { workspaceStreams: Map<string, { state: string }> };
        };
        const streamManager = aiServiceInternals.streamManager;
        const stream = streamManager.workspaceStreams.get(workspaceId);
        if (!stream || stream.state === "completed" || stream.state === "error") {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // Timeout after 2 minutes
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 120000);
    });

    if (hasError) {
      console.log(`\n❌ Stream encountered an error:`);
      console.log(errorMessage);

      // Check if it's the web_search_call error
      if (errorMessage.includes("web_search_call") && errorMessage.includes("reasoning")) {
        console.log(`\n🎯 Reproduced the web_search_call + reasoning error!`);
      }

      process.exit(1);
    }

    console.log(`\n✅ Stream completed successfully!`);
  } catch (error) {
    console.error(`\n❌ Exception:`, error);
    process.exit(1);
  } finally {
    // Cleanup
    console.log(`\n🧹 Cleaning up temporary workspace...`);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
