import React, { type ComponentProps } from "react";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";
import {
  StatusIndicator,
  TOOL_NAME_TO_ICON,
  ToolContainer,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./toolUtils";
import { useToolCards, useToolCardsPending, type ToolCards } from "./toolCardsStore";

const ToolCardsLoader = React.lazy(() => import("./toolCardsLoader"));

/** Renders nothing; mounting it loads the cards' chunk, or shows its Reload alert on failure. */
export function LoadToolCards() {
  return (
    <LazyFeature name="Tool cards">
      <ToolCardsLoader />
    </LazyFeature>
  );
}

/**
 * A tool row before the cards' chunk has loaded: the collapsed card header (same primitives,
 * same height), so the row keeps its place. Loading usually finishes before rows mount (see
 * ToolCardsPreloader), and then this never renders.
 */
export function ToolCardFallback(props: { toolName: string; status: ToolStatus }) {
  return (
    <>
      <ToolContainer expanded={false} data-testid="tool-card-fallback">
        <ToolHeader>
          {TOOL_NAME_TO_ICON[props.toolName] && <ToolIcon toolName={props.toolName} />}
          <ToolName>{props.toolName}</ToolName>
          <StatusIndicator status={props.status}>{getStatusDisplay(props.status)}</StatusIndicator>
        </ToolHeader>
      </ToolContainer>
      <LoadToolCards />
    </>
  );
}

/**
 * Loads the cards as soon as WorkspaceStore sees a tool call in history or a stream start. A
 * failed load shows its Reload alert in the rows (React.lazy caches the rejection), not here.
 */
export function ToolCardsPreloader() {
  const pending = useToolCardsPending();
  if (!pending) return null;
  return (
    <div hidden>
      <LoadToolCards />
    </div>
  );
}

/** The /plan preview (plan-display row) appears once the lazy cards load. */
export function LazyProposePlanToolCall(props: ComponentProps<ToolCards["ProposePlanToolCall"]>) {
  const cards = useToolCards();
  return cards ? <cards.ProposePlanToolCall {...props} /> : <LoadToolCards />;
}
