import * as React from "react";
import { MuxPreviewShell } from "../preview-harness";
import { SecretsSection } from "@/browser/features/Settings/Sections/SecretsSection";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";

// Global secrets view: the section loads api.secrets.get({}) for the global scope.
// Seed a populated global secret list (mirrors the story's PopulatedGlobalSecrets)
// so the key/value/inject grid renders with real rows.
export const PopulatedGlobalSecrets = () => (
  <MuxPreviewShell
    client={createMockORPCClient({
      globalSecrets: [
        { key: "OPENAI_API_KEY", value: "sk-openai" },
        { key: "ANTHROPIC_API_KEY", value: "sk-anthropic" },
        { key: "GITHUB_TOKEN", value: "ghp_123" },
        { key: "SENTRY_AUTH_TOKEN", value: "sentry" },
      ],
    })}
  >
    <div className="bg-background p-6 max-w-2xl">
      <SecretsSection />
    </div>
  </MuxPreviewShell>
);
