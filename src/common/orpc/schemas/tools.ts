import { z } from "zod";

const ToolOutputUiOnlySchema = z.object({
  ask_user_question: z
    .object({
      questions: z.array(z.unknown()),
      answers: z.record(z.string(), z.string()),
    })
    .optional(),
  file_edit: z
    .object({
      diff: z.string(),
    })
    .optional(),
  notify: z
    .object({
      notifiedVia: z.enum(["electron", "browser"]),
      workspaceId: z.string().optional(),
    })
    .optional(),
});

const ToolOutputUiOnlyFieldSchema = {
  ui_only: ToolOutputUiOnlySchema.optional(),
};

export const BashToolResultSchema = z.discriminatedUnion("success", [
  z
    .object({
      success: z.literal(true),
      wall_duration_ms: z.number(),
      output: z.string(),
      exitCode: z.literal(0),
      note: z.string().optional(),
      /**
       * Set when the output was cut at a limit: `output` is partial. With the truncate policy
       * (IPC executeBash), a command still running at the file limit is stopped by the tool, and
       * `exitCode` 0 is then the tool's status, not the command's (#6732). Callers must read
       * completeness from this field, never from `exitCode`; no caller needs to tell "stopped
       * at the limit" apart from "exited 0 with more output than the limit" (#6873).
       */
      truncated: z
        .object({
          reason: z.string(),
          totalLines: z.number(),
        })
        .optional(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
  z
    .object({
      success: z.literal(false),
      wall_duration_ms: z.number(),
      output: z.string().optional(),
      exitCode: z.number(),
      error: z.string(),
      note: z.string().optional(),
      truncated: z
        .object({
          reason: z.string(),
          totalLines: z.number(),
        })
        .optional(),
    })
    .extend(ToolOutputUiOnlyFieldSchema),
]);

export const FileTreeNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  get children() {
    return z.array(FileTreeNodeSchema);
  },
  /** Whether this file/directory is gitignored */
  ignored: z.boolean().optional(),
  stats: z
    .object({
      filePath: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .optional(),
  totalStats: z
    .object({
      filePath: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .optional(),
});
