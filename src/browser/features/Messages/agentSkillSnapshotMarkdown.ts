import { formatFrontmatterBlock } from "@/common/utils/markdownFrontmatter";
import type { DisplayedUserMessage, InlineSkillSnapshotForDisplay } from "@/common/types/message";

type SlashAgentSkillSnapshot = NonNullable<
  NonNullable<DisplayedUserMessage["agentSkill"]>["snapshot"]
>;
type InlineAgentSkillSnapshot = InlineSkillSnapshotForDisplay["snapshot"];

export type AgentSkillSnapshotContent = SlashAgentSkillSnapshot | InlineAgentSkillSnapshot;

export function buildAgentSkillSnapshotMarkdown(
  snapshot: AgentSkillSnapshotContent | undefined
): string | null {
  if (!snapshot) return null;

  const frontmatterYaml =
    typeof snapshot.frontmatterYaml === "string" && snapshot.frontmatterYaml.trim().length > 0
      ? snapshot.frontmatterYaml.trimEnd()
      : undefined;
  const body = typeof snapshot.body === "string" ? snapshot.body : undefined;

  if (!frontmatterYaml && !body) {
    return null;
  }

  const yamlBlock = frontmatterYaml ? `${formatFrontmatterBlock(frontmatterYaml)}\n\n` : "";

  return `${yamlBlock}${body ?? ""}`;
}
