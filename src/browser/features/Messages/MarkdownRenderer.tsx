import React from "react";
import type { InlineSkillSnapshotMap } from "@/common/types/message";
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from "@/browser/components/HoverCard/HoverCard";
import { MarkdownCore } from "./MarkdownCore";
import { cn } from "@/common/lib/utils";
import { AgentSkillBadge } from "./AgentSkillBadge";
import { buildAgentSkillSnapshotMarkdown } from "./agentSkillSnapshotMarkdown";
import {
  InlineSkillPreviewContext,
  type InlineSkillPreviewContextValue,
} from "./InlineSkillPreviewContext";

interface MarkdownRendererProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Preserve single newlines as line breaks (like GitHub-flavored markdown).
   * When true, single newlines in text become <br> elements instead of being
   * collapsed to spaces. Useful for user-authored content where newlines
   * are intentional. Default: false.
   */
  preserveLineBreaks?: boolean;
  inlineSkillSnapshots?: InlineSkillSnapshotMap;
  /** See MarkdownCore. Default: true. */
  renderRawHtml?: boolean;
}

const DISABLED_INLINE_SKILL_PREVIEW_CONTEXT: InlineSkillPreviewContextValue = {
  renderInlineSkillPreview: (_skillName, label) => label,
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className,
  style,
  preserveLineBreaks,
  inlineSkillSnapshots,
  renderRawHtml,
}) => {
  const markdownCore = (
    <MarkdownCore
      content={content}
      preserveLineBreaks={preserveLineBreaks}
      renderRawHtml={renderRawHtml}
    />
  );
  const markdownContent =
    inlineSkillSnapshots === undefined ? (
      markdownCore
    ) : (
      <InlineSkillPreviewContext.Provider
        value={{
          renderInlineSkillPreview: (skillName, label) => {
            const snapshot = inlineSkillSnapshots[skillName];
            if (!snapshot) {
              return label;
            }

            const snapshotMarkdown = buildAgentSkillSnapshotMarkdown(snapshot.snapshot);
            if (!snapshotMarkdown) {
              return label;
            }

            return (
              <HoverCard openDelay={150}>
                <HoverCardTrigger asChild>
                  <AgentSkillBadge className="cursor-help">{label}</AgentSkillBadge>
                </HoverCardTrigger>
                {/* Keep skill preview above chat chrome and fully opaque while hovering. */}
                <HoverCardPortal>
                  <HoverCardContent
                    align="start"
                    side="top"
                    className="border-border-medium bg-modal-bg z-[1600] max-h-[360px] w-[520px] max-w-[80vw] overflow-auto border-2 p-3"
                  >
                    <InlineSkillPreviewContext.Provider
                      value={DISABLED_INLINE_SKILL_PREVIEW_CONTEXT}
                    >
                      <MarkdownRenderer content={snapshotMarkdown} preserveLineBreaks />
                    </InlineSkillPreviewContext.Provider>
                  </HoverCardContent>
                </HoverCardPortal>
              </HoverCard>
            );
          },
        }}
      >
        {markdownCore}
      </InlineSkillPreviewContext.Provider>
    );

  return (
    <div className={cn("markdown-content", className)} style={style}>
      {markdownContent}
    </div>
  );
};

// For plan-specific styling
export const PlanMarkdownContainer: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => {
  return (
    <div
      className={cn("markdown-content", className)}
      style={{
        // Plan-specific overrides
        // @ts-expect-error CSS custom property
        "--code-color": "var(--color-plan-mode-hover)",
      }}
    >
      {children}
    </div>
  );
};
