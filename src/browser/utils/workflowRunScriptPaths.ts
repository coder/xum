import type { WorkflowScriptDescriptor } from "@/common/types/workflow";

export function getWorkflowScriptDisplayPath(descriptor: WorkflowScriptDescriptor): string {
  return (
    descriptor.requestedScriptPath ??
    descriptor.sourcePath ??
    descriptor.canonicalScriptPath ??
    descriptor.name
  );
}

export function workflowScriptMatchesPath(
  descriptor: WorkflowScriptDescriptor,
  scriptPath: string
): boolean {
  const candidatePaths = [
    descriptor.requestedScriptPath,
    descriptor.sourcePath,
    descriptor.canonicalScriptPath,
  ];
  return candidatePaths.some((candidate) => candidate === scriptPath);
}
