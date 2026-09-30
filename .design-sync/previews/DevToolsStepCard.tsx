import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { DevToolsStepCard } from "@/browser/features/RightSidebar/DevToolsTab/DevToolsStepCard";
import type { DevToolsStep } from "@/common/types/devtools";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

// A DevTools run step card replayed from a recorded provider request/response.
// Mirrors the story's mock step + toolPolicy. The card renders collapsed by
// default (the story's play step clicks to expand); the collapsed header is the
// representative resting state for the gallery.
const debugStep: DevToolsStep = {
  id: "step-2",
  runId: "run-1",
  stepNumber: 2,
  type: "stream",
  modelId: "gemini-3.5-flash",
  provider: "google.generative-ai",
  startedAt: "2026-06-09T12:00:00.000Z",
  durationMs: 8400,
  input: {
    maxOutputTokens: 65_536,
    toolChoice: "auto",
    providerOptions: {
      google: {
        safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }],
      },
    },
    tools: Array.from({ length: 6 }, (_, index) => ({
      name: `tool_${index + 1}`,
      description: "A tool available to the agent.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    })),
    prompt: [
      { role: "system", content: "You are Mux." },
      { role: "user", content: "Find the latest information about evaluations." },
      { role: "assistant", content: "I will search the web and summarize the results." },
    ],
  },
  output: {
    finishReason: "SAFETY",
    reasoningParts: [
      {
        id: "reasoning-1",
        text: "Summarizing the request and selecting the best follow-up tool call.",
      },
    ],
    toolCalls: [
      {
        toolCallId: "tool-call-1",
        toolName: "server:GOOGLE_SEARCH_WEB",
        args: { query: "site:example.com engineering demystifying evals for ai agents" },
      },
    ],
    textParts: [
      { id: "text-1", text: "The provider blocked this response for safety policy reasons." },
    ],
  },
  usage: {
    inputTokens: 14_450,
    outputTokens: 807,
    totalTokens: 15_257,
    raw: { promptTokenCount: 14_450, candidatesTokenCount: 807 },
  },
  error: null,
  rawRequest: { body: { model: "gemini-3.5-flash", tools: ["server:GOOGLE_SEARCH_WEB"] } },
  requestHeaders: null,
  responseHeaders: null,
  rawResponse: { finishReason: "SAFETY" },
  rawChunks: null,
};

const toolPolicy: ToolPolicy = [
  { regex_match: "server:GOOGLE_SEARCH_WEB", action: "enable" },
  { regex_match: "server:fs_write", action: "disable" },
  { regex_match: "server:bash", action: "require" },
];

export const StepCard = () => (
  <MuxPreviewShell>
    <div className="bg-surface-primary text-foreground p-6">
      {/* DevTools cards live in the narrow right sidebar — constrain width to match. */}
      <div className="w-full max-w-[282px]">
        <DevToolsStepCard step={debugStep} toolPolicy={toolPolicy} />
      </div>
    </div>
  </MuxPreviewShell>
);
