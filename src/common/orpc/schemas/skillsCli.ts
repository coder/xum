import { z } from "zod";

/**
 * The "Skills CLI" install method: Xum runs the pinned `skills` CLI
 * (vercel-labs/skills) with fixed flags, so the skills land in
 * ~/.agents/skills, which Xum already reads. Xum does not review, update or
 * remove those skills.
 */

/** Whether Xum can run the skills CLI on this machine (Node.js on PATH). */
export const SkillsCliStatusSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    /** `node --version` output, like `v22.20.0`. */
    nodeVersion: z.string(),
    /** The pinned npm package spec, like `skills@1.7.4`. */
    package: z.string(),
  }),
  z.object({
    available: z.literal(false),
    /** User-facing reason: no npx, no node, or a Node.js version that is too old. */
    reason: z.string(),
    /** null when Xum found no node or could not read its version. */
    nodeVersion: z.string().nullable(),
    package: z.string(),
  }),
]);

export const SkillsCliInstallInputSchema = z.object({
  /** A git URL or owner/repo shorthand, as typed in the Add panel. */
  source: z.string(),
  /** Skill names (directory names) to install; at least one. */
  skills: z.array(z.string()),
});

export const SkillsCliRunSchema = z.discriminatedUnion("status", [
  z.object({
    /** Xum did not run the CLI; the user can run `command` in a terminal. */
    status: z.literal("unavailable"),
    reason: z.string(),
    /** The exact command, shell-quoted for copying. */
    command: z.string(),
  }),
  z.object({
    status: z.literal("ran"),
    /** True when the CLI exited 0 and every requested skill has a SKILL.md. */
    ok: z.boolean(),
    /** null when the CLI did not exit normally (killed, timed out, or failed to start). */
    exitCode: z.number().nullable(),
    timedOut: z.boolean(),
    /** Combined stdout and stderr without ANSI escapes; only the tail when long. */
    output: z.string(),
    command: z.string(),
    /** Requested skills without ~/.agents/skills/<name>/SKILL.md after an exit 0 (else empty). */
    missingSkills: z.array(z.string()),
    /** User-facing failure summary; null when ok. */
    failure: z.string().nullable(),
  }),
]);

export type SkillsCliStatus = z.infer<typeof SkillsCliStatusSchema>;
export type SkillsCliRun = z.infer<typeof SkillsCliRunSchema>;
