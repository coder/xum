import React from "react";

import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";
import { getProjectAvatarColors, getProjectMonogram } from "@/browser/utils/ui/projectAvatarColors";
import { getProjectIcon } from "@/browser/utils/ui/projectIcons";
import { DEFAULT_SECTION_COLOR } from "@/common/constants/ui";
import { AVATAR_RING_STYLE } from "./StatusDot";

/**
 * The flat sidebar's project avatar: the project's chosen lucide icon, or its first letter, on a
 * tint of its color. The glyph is decorative for screen readers because the row's aria-label
 * already names the project; sighted users get the full name from the tooltip.
 */
export function ProjectAvatar(props: {
  name: string;
  color?: string;
  /** Stored lucide icon name; a missing or unknown name shows the monogram. */
  icon?: string;
  testId: string;
  /** Status dot or icon pinned to the bottom-right corner. */
  corner?: React.ReactNode;
}) {
  const { theme } = useTheme();
  const colors = getProjectAvatarColors(
    props.color ?? DEFAULT_SECTION_COLOR,
    isLightThemeMode(theme) ? "light" : "dark"
  );
  const Icon = getProjectIcon(props.icon);
  return (
    <div className="relative h-[22px] w-[22px] shrink-0">
      <TooltipIfPresent tooltip={props.name} side="right">
        <span
          aria-hidden="true"
          data-testid={props.testId}
          className="flex h-full w-full items-center justify-center rounded-md text-[11px] leading-none font-bold"
          style={{ backgroundColor: colors.background, color: colors.foreground }}
        >
          {Icon != null ? <Icon className="h-3.5 w-3.5" /> : getProjectMonogram(props.name)}
        </span>
      </TooltipIfPresent>
      {props.corner != null && (
        // A 9px dot inside a 2px ring sits 3px past the avatar's corner.
        <span className="pointer-events-none absolute right-[-5px] bottom-[-5px] flex">
          {props.corner}
        </span>
      )}
    </div>
  );
}

/** A corner icon (heartbeat, expanded children) on the same row-colored ring as the dot. */
export function AvatarCornerIcon(props: { children: React.ReactNode }) {
  return (
    <span
      className="flex h-[13px] w-[13px] items-center justify-center rounded-full"
      style={AVATAR_RING_STYLE}
    >
      {props.children}
    </span>
  );
}
