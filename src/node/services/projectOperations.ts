import type { ORPCContext } from "@/node/orpc/context";
import { Ok } from "@/common/types/result";

export async function removeProject(
  context: ORPCContext,
  input: { projectPath: string; force?: boolean | null }
) {
  const result = await context.projectService.remove(input.projectPath, input.force ?? false);
  if (!result.success) {
    return result;
  }
  // Removal cascades, so every removed path must lose its retained trust.
  for (const removedPath of result.data.removedProjectPaths) {
    context.mcpServerManager.forgetProjectTrust(removedPath);
  }
  return Ok(undefined);
}
