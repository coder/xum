import type { ArtifactInteractionMetadata } from "@/common/types/message";

/**
 * Design C ("hybrid") body of a message sent from an artifact: the plain text the user confirmed,
 * plus the artifact's data as a compact JSON block. Rendered from metadata, never from the
 * model-facing <artifact_interaction> tag.
 */
export function formatArtifactInteractionMarkdown(
  interaction: Pick<ArtifactInteractionMetadata, "text" | "data">
): string {
  if (interaction.data === undefined) return interaction.text;
  const json = JSON.stringify(interaction.data);
  // A fence longer than any backtick run in the JSON, so artifact data cannot close it early.
  const longestRun = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${interaction.text}\n\n${fence}json\n${json}\n${fence}`;
}
