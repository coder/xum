/**
 * ExtensionMetadataService read cost with a ~1.8 MB extensionMetadata.json (2800 workspaces).
 * Run: make bench BENCH=ExtensionMetadata
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bench, summary } from "mitata";
import type { ExtensionMetadata, ExtensionMetadataFile } from "@/node/utils/extensionMetadata";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { DisposableTempDir } from "@/node/services/tempDir";

const WORKSPACE_COUNT = 2800;

const tempDir = new DisposableTempDir("xum-bench-extension-metadata");
process.on("exit", () => tempDir[Symbol.dispose]());
const filePath = path.join(tempDir.path, "extensionMetadata.json");

function makeEntry(index: number): ExtensionMetadata {
  const status = {
    emoji: "🔍",
    message: `Reviewing the change set for feature ${index} and running the targeted tests`,
  };
  return {
    recency: 1_790_000_000_000 + index,
    streaming: false,
    streamingGeneration: index,
    lastModel: "anthropic:claude-opus-5-5",
    lastThinkingLevel: "high",
    agentStatus: status,
    displayStatus: status,
    todoStatus: null,
    hasTodos: index % 2 === 0,
    lastStatusUrl: `https://github.com/coder/xum/pull/${5000 + index}`,
    sidebarStatusInputHash: index.toString(16).padStart(64, "0"),
    writeGeneration: index,
    // Every fourth workspace carries a goal, which the reader validates with zod.
    goal:
      index % 4 === 0
        ? {
            goalId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
            status: "active",
            objective: `Ship feature ${index} with tests and docs`,
            budgetCents: 500,
            costCents: index % 500,
            turnsUsed: 3,
            turnCap: 20,
            startedAtMs: 1_790_000_000_000,
          }
        : null,
  };
}

async function writeMetadataFile(): Promise<ExtensionMetadataService> {
  const data: ExtensionMetadataFile = { version: 1, workspaces: {} };
  for (let i = 0; i < WORKSPACE_COUNT; i++) data.workspaces[`workspace-${i}`] = makeEntry(i);
  await fs.writeFile(filePath, JSON.stringify(data));
  return new ExtensionMetadataService(filePath);
}

summary(() => {
  // Both methods re-read and parse the whole file on every call.
  bench("getAllSnapshots (2800 workspaces)", async function* () {
    const service = await writeMetadataFile();
    yield () => service.getAllSnapshots();
  });
  bench("getSnapshot (one workspace of 2800)", async function* () {
    const service = await writeMetadataFile();
    yield () => service.getSnapshot("workspace-42");
  });
});
