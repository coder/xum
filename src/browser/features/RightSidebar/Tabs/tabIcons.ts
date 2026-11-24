import {
  AppWindow,
  Brain,
  BugPlay,
  ChartColumn,
  FileText,
  GitCompare,
  Globe,
  ListTree,
  Monitor,
  ScrollText,
  Target,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { BaseTabType } from "./tabConfig";

/**
 * One icon per tool. The tab labels, the New tab launcher and the phone workspace menu all read
 * this map, so a tool shows the same icon everywhere. Kept apart from `tabConfig.ts`, which must
 * stay free of React components, and from `tabRegistry.tsx`, which imports the tab labels.
 */
export const TAB_ICONS: Record<BaseTabType, LucideIcon> = {
  costs: ChartColumn,
  review: GitCompare,
  instructions: FileText,
  goal: Target,
  workflows: Workflow,
  timeline: ListTree,
  artifacts: AppWindow,
  memory: Brain,
  desktop: Monitor,
  browser: Globe,
  output: ScrollText,
  debug: BugPlay,
};
