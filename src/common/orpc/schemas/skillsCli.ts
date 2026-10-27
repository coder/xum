import { z } from "zod";

/**
 * The "Skills CLI" install method: Xum shows the command of the pinned `skills` CLI
 * (vercel-labs/skills) with fixed flags, for the user to run in a terminal. The skills then land
 * in ~/.agents/skills, which Xum already reads. Xum does not run the CLI, and it does not review,
 * update or remove those skills.
 */

export const SkillsCliCommandInputSchema = z.object({
  /** A git URL or owner/repo shorthand, as typed in the Add panel. */
  source: z.string(),
  /** Skill names (directory names) to install; at least one. */
  skills: z.array(z.string()),
});

export const SkillsCliCommandSchema = z.object({
  /** The exact command to copy. Every argument is shell-safe without quoting. */
  command: z.string(),
});
