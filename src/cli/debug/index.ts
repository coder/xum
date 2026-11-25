#!/usr/bin/env bun

import { parseArgs } from "util";
import { listWorkspacesCommand } from "./list-workspaces";
import { costsCommand } from "./costs";
import { consolidateMemoryCommand } from "./consolidate-memory";
import { replayVerifyCommand } from "./replay-verify";
import { cacheAuditCommand } from "./cache-audit";
import { pluginsCommand } from "./plugins";
import { refinementsCommand } from "./refinements";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean" },
    rollback: { type: "string" },
    force: { type: "boolean" },
  },
  allowPositionals: true,
});

function requireWorkspaceId(usage: string): string {
  const workspaceId = positionals[1];
  if (!workspaceId) {
    console.error("Error: workspace ID required");
    console.log(`Usage: ${usage}`);
    process.exit(1);
  }
  return workspaceId;
}

const command = positionals[0];

switch (command) {
  case "list-workspaces":
    listWorkspacesCommand();
    break;
  case "costs": {
    const workspaceId = requireWorkspaceId("bun debug costs <workspace-id>");
    console.profile("costs");
    await costsCommand(workspaceId);
    console.profileEnd("costs");
    break;
  }
  case "consolidate-memory": {
    const workspaceId = requireWorkspaceId(
      "bun debug consolidate-memory <workspace-id> [--dry-run]"
    );
    await consolidateMemoryCommand(workspaceId, { dryRun: values["dry-run"] ?? false });
    break;
  }
  case "replay-verify": {
    const workspaceId = requireWorkspaceId("bun debug replay-verify <workspace-id>");
    await replayVerifyCommand(workspaceId);
    break;
  }
  case "cache-audit": {
    const workspaceId = requireWorkspaceId("bun debug cache-audit <workspace-id>");
    await cacheAuditCommand(workspaceId);
    break;
  }
  case "plugins": {
    const workspaceId = requireWorkspaceId("bun debug plugins <workspace-id>");
    await pluginsCommand(workspaceId);
    break;
  }
  case "refinements": {
    const workspaceId = requireWorkspaceId(
      "bun debug refinements <workspace-id> [--rollback <id>] [--force]"
    );
    await refinementsCommand(workspaceId, { rollback: values.rollback, force: values.force });
    break;
  }
  default:
    console.log("Usage:");
    console.log("  bun debug list-workspaces");
    console.log("  bun debug costs <workspace-id>");
    console.log("  bun debug consolidate-memory <workspace-id> [--dry-run]");
    console.log("  bun debug replay-verify <workspace-id>");
    console.log("  bun debug cache-audit <workspace-id>");
    console.log("  bun debug plugins <workspace-id>");
    console.log("  bun debug refinements <workspace-id> [--rollback <id>] [--force]");
    process.exit(1);
}
