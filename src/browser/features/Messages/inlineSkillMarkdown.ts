import type { Link, Parent, PhrasingContent, Root, Text } from "mdast";
import type { Plugin } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { extractInlineSkillReferenceCandidates } from "@/browser/utils/agentSkills/inlineSkillReferences";

export const INTERNAL_INLINE_SKILL_HREF_PREFIX = "mux-inline-skill:";

function assertInlineSkillCandidate(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invalid inline skill candidate: ${message}`);
  }
}

function createTextNode(value: string): Text {
  return { type: "text", value };
}

/**
 * Separates a qualified `$plugin:skill` name from its bare fallback in the href.
 * encodeURIComponent always escapes `/`, so it cannot appear inside either name.
 */
export const INLINE_SKILL_HREF_FALLBACK_SEPARATOR = "/";

function createInlineSkillLink(
  skillName: string,
  visibleText: string,
  fallbackSkillName?: string
): Link {
  const fallback =
    fallbackSkillName != null
      ? `${INLINE_SKILL_HREF_FALLBACK_SEPARATOR}${encodeURIComponent(fallbackSkillName)}`
      : "";
  return {
    type: "link",
    url: `${INTERNAL_INLINE_SKILL_HREF_PREFIX}${encodeURIComponent(skillName)}${fallback}`,
    children: [createTextNode(visibleText)],
  };
}

function buildInlineSkillReplacementNodes(textNode: Text): PhrasingContent[] | null {
  const text = textNode.value;
  const candidates = extractInlineSkillReferenceCandidates(text);
  if (candidates.length === 0) {
    return null;
  }

  const replacements: PhrasingContent[] = [];
  let previousEnd = 0;

  for (const candidate of candidates) {
    assertInlineSkillCandidate(
      Number.isInteger(candidate.startIndex) && Number.isInteger(candidate.endIndex),
      "candidate ranges must be integer offsets"
    );
    assertInlineSkillCandidate(candidate.startIndex >= 0, "candidate start is before text start");
    assertInlineSkillCandidate(
      candidate.endIndex <= text.length,
      "candidate end is after text end"
    );
    assertInlineSkillCandidate(
      candidate.startIndex >= previousEnd,
      "candidate ranges must be monotonic and non-overlapping"
    );
    assertInlineSkillCandidate(
      candidate.startIndex < candidate.endIndex,
      "candidate range is empty"
    );

    const visibleText = text.slice(candidate.startIndex, candidate.endIndex);
    assertInlineSkillCandidate(visibleText.startsWith("$"), "candidate text must start with $");

    if (candidate.startIndex > previousEnd) {
      replacements.push(createTextNode(text.slice(previousEnd, candidate.startIndex)));
    }

    replacements.push(
      createInlineSkillLink(candidate.skillName, visibleText, candidate.fallback?.skillName)
    );
    previousEnd = candidate.endIndex;
  }

  if (previousEnd < text.length) {
    replacements.push(createTextNode(text.slice(previousEnd)));
  }

  return replacements;
}

export const remarkInlineSkillLinks: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (parent?.type === "link" || parent?.type === "linkReference") {
        return SKIP;
      }

      assertInlineSkillCandidate(parent !== undefined, "text node must have a parent");
      assertInlineSkillCandidate(index !== undefined, "text node must have a sibling index");

      const replacementNodes = buildInlineSkillReplacementNodes(node);
      if (!replacementNodes) {
        return undefined;
      }

      parent.children.splice(index, 1, ...replacementNodes);
      return SKIP;
    });
  };
};
