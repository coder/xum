import * as path from "path";

import { mergeAdditionalSystemInstructions } from "@/common/utils/additionalSystemInstructions";
import { nodeSessionFiles } from "@/node/services/sessionFiles/nodeSessionFiles";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";
import { isErrnoWithCode } from "@/node/utils/fs";

interface SessionDirProvider {
  sessionsDir: string;
}

export const ADDITIONAL_SYSTEM_CONTEXT_FILENAME = "additional-system-context.md";
/**
 * Sidecar marker indicating the scratchpad is disabled. When this file exists
 * (its contents are irrelevant), the scratchpad's content is preserved on disk
 * but not injected into the system prompt. We use a sidecar marker rather than
 * a JSON envelope so the content file stays plain markdown for grep/diff.
 */
export const ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME = "additional-system-context.disabled";

export interface AdditionalSystemContextRecord {
  content: string;
  enabled: boolean;
}

export function getAdditionalSystemContextPath(
  config: SessionDirProvider,
  workspaceId: string
): string {
  return path.join(config.sessionsDir, workspaceId, ADDITIONAL_SYSTEM_CONTEXT_FILENAME);
}

export function getAdditionalSystemContextDisabledPath(
  config: SessionDirProvider,
  workspaceId: string
): string {
  return path.join(
    path.join(config.sessionsDir, workspaceId),
    ADDITIONAL_SYSTEM_CONTEXT_DISABLED_FILENAME
  );
}

async function readContentFile(
  config: SessionDirProvider,
  workspaceId: string,
  files: SessionFiles
): Promise<string> {
  try {
    return await files.promises.readFile(
      getAdditionalSystemContextPath(config, workspaceId),
      "utf-8"
    );
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function readEnabledFlag(
  config: SessionDirProvider,
  workspaceId: string,
  files: SessionFiles
): Promise<boolean> {
  // Default to enabled when the marker file is absent.
  try {
    await files.promises.access(getAdditionalSystemContextDisabledPath(config, workspaceId));
    return false;
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

export async function readAdditionalSystemContext(
  config: SessionDirProvider,
  workspaceId: string,
  /** The session files of the workspace (phase 5). Absent: the Node layer. */
  files: SessionFiles = nodeSessionFiles
): Promise<AdditionalSystemContextRecord> {
  const [content, enabled] = await Promise.all([
    readContentFile(config, workspaceId, files),
    readEnabledFlag(config, workspaceId, files),
  ]);
  return { content, enabled };
}

export async function writeAdditionalSystemContext(
  config: SessionDirProvider,
  workspaceId: string,
  record: AdditionalSystemContextRecord,
  /** The session files of the workspace (phase 5). Absent: the Node layer. */
  files: SessionFiles = nodeSessionFiles
): Promise<void> {
  const filePath = getAdditionalSystemContextPath(config, workspaceId);
  const disabledPath = getAdditionalSystemContextDisabledPath(config, workspaceId);
  await files.ensurePrivateDir(path.dirname(filePath));

  // Empty scratchpads should behave like missing files so fork/copy and prompt
  // injection don't carry around blank durable state. We also drop the
  // disabled marker so the next non-empty edit defaults to enabled.
  if (record.content.length === 0) {
    await Promise.all([
      files.promises.rm(filePath, { force: true }),
      files.promises.rm(disabledPath, { force: true }),
    ]);
    return;
  }

  await files.promises.writeFile(filePath, record.content, "utf-8");
  if (record.enabled) {
    await files.promises.rm(disabledPath, { force: true });
  } else {
    await files.promises.writeFile(disabledPath, "", "utf-8");
  }
}

/**
 * Effective scratchpad text for prompt injection: the content when enabled,
 * an empty string when disabled. Centralised so callers don't have to remember
 * the toggle.
 */
export function effectiveAdditionalSystemContext(record: AdditionalSystemContextRecord): string {
  return record.enabled ? record.content : "";
}

export { mergeAdditionalSystemInstructions };
