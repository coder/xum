import type { z } from "zod";
import type {
  AgentSkillDescriptorSchema,
  AgentSkillFrontmatterSchema,
  AgentSkillIssueSchema,
  AgentSkillListResultSchema,
  AgentSkillPackageSchema,
  AgentSkillScopeSchema,
  AgentSkillUnavailableSourceSchema,
  SkillNameSchema,
} from "@/common/orpc/schemas";
import type { SkillLookupNameSchema } from "@/common/orpc/schemas/agentSkill";

export type SkillName = z.infer<typeof SkillNameSchema>;

/** A bare skill name or `<plugin>:<skill>` (see SkillLookupNameSchema). */
export type SkillLookupName = z.infer<typeof SkillLookupNameSchema>;

export type AgentSkillScope = z.infer<typeof AgentSkillScopeSchema>;

export type AgentSkillFrontmatter = z.infer<typeof AgentSkillFrontmatterSchema>;

export type AgentSkillDescriptor = z.infer<typeof AgentSkillDescriptorSchema>;

export type AgentSkillIssue = z.infer<typeof AgentSkillIssueSchema>;

export type AgentSkillUnavailableSource = z.infer<typeof AgentSkillUnavailableSourceSchema>;

export type AgentSkillListResult = z.infer<typeof AgentSkillListResultSchema>;

export type AgentSkillPackage = z.infer<typeof AgentSkillPackageSchema>;

/**
 * A skill as offered on invocation surfaces (model index, slash menu): `name` is
 * the lookup name, qualified (`<plugin>:<skill>`) for a shadowed plugin skill.
 */
export type InvocableSkill = Omit<AgentSkillDescriptor, "name"> & { name: SkillLookupName };
