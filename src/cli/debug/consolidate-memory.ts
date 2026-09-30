import { defaultConfig } from "@/node/config";
import {
  resolveConsolidationProjectPath,
  resolveDreamAgentBody,
  resolveDreamModelString,
} from "@/node/services/memoryConsolidationService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService, type MemoryScopeContext } from "@/node/services/memoryService";
import { runMemoryConsolidation } from "@/node/services/memoryConsolidation";
import { ProviderModelFactory } from "@/node/services/providerModelFactory";
import { ProviderService } from "@/node/services/providerService";

/**
 * Debug command: run a memory-consolidation ("dream") pass for a workspace.
 * Usage: bun debug consolidate-memory <workspace-id> [--dry-run]
 *
 * Consolidates workspace + global scopes, plus project scope for single-project
 * workspaces. All are host-local, so no workspace runtime is required. --dry-run
 * prints the proposed op table without touching disk.
 */
export async function consolidateMemoryCommand(
  workspaceId: string,
  options: { dryRun: boolean }
): Promise<void> {
  const workspace = defaultConfig.findWorkspace(workspaceId);
  if (!workspace) {
    console.error(`❌ Workspace not found: ${workspaceId}`);
    process.exitCode = 1;
    return;
  }

  // Model cascade (PRD #3534: inherit, uniform with other agents) — shared
  // with MemoryConsolidationService so CLI and app runs always agree.
  const modelString = resolveDreamModelString(defaultConfig, workspaceId);

  // Built-in body, shadowed by <muxRoot>/agents/dream.md like any global agent.
  const agentBody = await resolveDreamAgentBody(defaultConfig.rootDir);
  if (agentBody === null) {
    console.error("❌ Dream agent definition is missing");
    process.exitCode = 1;
    return;
  }

  const providerService = new ProviderService(defaultConfig);
  const modelFactory = new ProviderModelFactory(defaultConfig, providerService);
  const modelResult = await modelFactory.createModel(modelString, undefined, {
    agentInitiated: true,
    workspaceId,
  });
  if (!modelResult.success) {
    console.error(`❌ Could not create model ${modelString}: ${modelResult.error.type}`);
    process.exitCode = 1;
    return;
  }

  const metaService = new MemoryMetaService(defaultConfig.rootDir);
  const memoryService = new MemoryService(defaultConfig, metaService);
  const projectPath = resolveConsolidationProjectPath(workspace);
  const ctx: MemoryScopeContext = {
    runtime: null,
    checkoutCwd: "",
    workspaceId,
    projectPath,
  };

  console.log(`\n=== Memory Consolidation (dream) ===\n`);
  console.log(`Workspace: ${workspaceId}`);
  console.log(`Model:     ${modelString}`);
  console.log(`Mode:      ${options.dryRun ? "dry-run (no writes)" : "apply"}\n`);

  const result = await runMemoryConsolidation({
    model: modelResult.data,
    agentBody,
    memoryService,
    metaService,
    ctx,
    dryRun: options.dryRun,
  });

  if (result.ops.length === 0) {
    console.log("No mutations proposed.");
  } else {
    for (const op of result.ops) {
      const status = op.applied ? "applied " : "proposed";
      const rename = op.newPath ? ` -> ${op.newPath}` : "";
      console.log(`  [${status}] ${op.command} ${op.path}${rename}`);
      if (op.note && op.note !== "dry-run") console.log(`             ${op.note}`);
    }
  }
  if (result.budgetExhausted) {
    console.log("\n⚠️  Mutation budget exhausted.");
  }
  if (result.streamError !== undefined) {
    console.error(`\n❌ Stream error (run did not complete): ${result.streamError}`);
    process.exitCode = 1;
  }
  if (result.usage) {
    console.log(`\nUsage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  }
  console.log(`\nSummary: ${result.summary || "(none)"}\n`);
}
