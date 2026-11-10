import { createContext, type ReactNode } from "react";

export interface InlineSkillPreviewContextValue {
  /**
   * `fallbackSkillName` is the bare `$tdd` of a qualified `$tdd:notes` token: the
   * send path loads it when no `tdd:notes` skill exists.
   */
  renderInlineSkillPreview: (
    skillName: string,
    label: string,
    fallbackSkillName?: string
  ) => ReactNode;
}

export const InlineSkillPreviewContext = createContext<InlineSkillPreviewContextValue>({
  renderInlineSkillPreview: (_skillName, label) => label,
});
