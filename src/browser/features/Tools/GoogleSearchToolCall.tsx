import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  LoadingDots,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  unwrapResult,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";

/**
 * Renderer for Google's native search grounding tool (Gemini 3+), which the provider
 * executes server-side and streams back as a dynamic tool named "server:GOOGLE_SEARCH_WEB".
 *
 * args:   { queries: string[] }
 * result: { search_suggestions: "<style>…</style><div class=\"container\">…" } — Google's
 *         pre-rendered "Search Suggestions" HTML (searchEntryPoint.renderedContent): a Google
 *         logo plus one <a class="chip" href="https://www.google.com/search?q=…"> per query.
 */
interface GoogleSearchToolCallProps {
  args: { queries?: string[] };
  result?: unknown;
  status?: ToolStatus;
}

interface SuggestionChip {
  label: string;
  href: string;
}

/**
 * SECURITY AUDIT: the search_suggestions HTML arrives in a tool result persisted to
 * chat.jsonl, so we treat it as attacker-controlled (a tampered transcript can contain
 * anything). We never inject it into the live DOM. DOMParser produces an inert detached
 * document — scripts and styles in it do not execute — and we extract only chip labels and
 * hrefs, keeping a link only when its URL parses to https://www.google.com/search. A hostile
 * payload therefore yields no links rather than XSS. The chips are re-rendered as React
 * elements; Google's HTML/CSS is never used directly.
 */
function parseSearchSuggestions(html: string): SuggestionChip[] {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const chips: SuggestionChip[] = [];
    // Dedupe by href: chips render with key={chip.href}, and a payload repeating a
    // suggestion (duplicate model queries, tampered transcript) must not produce
    // duplicate React keys.
    const seenHrefs = new Set<string>();
    for (const anchor of Array.from(doc.querySelectorAll("a.chip"))) {
      const href = anchor.getAttribute("href");
      const label = anchor.textContent?.trim();
      if (!href || !label || seenHrefs.has(href)) continue;
      try {
        const url = new URL(href);
        if (
          url.protocol === "https:" &&
          url.hostname === "www.google.com" &&
          url.pathname === "/search" &&
          // Reject userinfo/port-bearing URLs: still google.com, but a tampered
          // transcript could smuggle credentials or a dead port into the link.
          url.username === "" &&
          url.password === "" &&
          url.port === ""
        ) {
          seenHrefs.add(href);
          chips.push({ label, href });
        }
      } catch {
        // Unparseable href → drop the chip.
      }
    }
    return chips;
  } catch {
    return [];
  }
}

/** Extract the rendered-suggestions HTML string from the tool result, if present. */
function extractSuggestionsHtml(result: unknown): string | undefined {
  const unwrapped = unwrapResult(result);
  if (
    unwrapped !== null &&
    typeof unwrapped === "object" &&
    "search_suggestions" in unwrapped &&
    typeof (unwrapped as { search_suggestions: unknown }).search_suggestions === "string"
  ) {
    return (unwrapped as { search_suggestions: string }).search_suggestions;
  }
  return undefined;
}

/**
 * Static Google "G" logo authored locally — never extracted from the payload. Fixed brand
 * colors are intentional (logo artwork, not themeable UI); everything else in the chip uses
 * theme variables.
 */
const GoogleLogo: React.FC = () => (
  <svg viewBox="0 0 48 48" className="h-3 w-3 shrink-0" aria-hidden="true">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

export const GoogleSearchToolCall: React.FC<GoogleSearchToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const queries = args.queries ?? [];
  const suggestionsHtml = extractSuggestionsHtml(result);
  const chips = suggestionsHtml ? parseSearchSuggestions(suggestionsHtml) : [];
  // streamManager synthesizes { success: false, error } for tool errors; surface it so a
  // failed call isn't a bare "failed" badge with empty details (regression-guard vs the
  // GenericToolCall fallback, which always dumped the result JSON). Unwrap first: results
  // can arrive inside the { type: "json", value } persistence container.
  const unwrappedResult = unwrapResult(result);
  const failureError =
    status === "failed" && isToolErrorResult(unwrappedResult) ? unwrappedResult.error : undefined;
  const showRawFailureResult = status === "failed" && failureError === undefined && result != null;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="server:GOOGLE_SEARCH_WEB" />
        <ToolName className="shrink-0">Google Search</ToolName>
        <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
          <span className="font-monospace truncate">{queries[0] ?? "searching..."}</span>
        </div>
        {queries.length > 1 && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            +{queries.length - 1} more
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {queries.length > 0 && (
            <DetailSection>
              <DetailLabel>Queries</DetailLabel>
              <div className="bg-code-bg rounded px-2 py-1.5 text-[11px] leading-[1.4]">
                {queries.map((query, i) => (
                  // break-words (not truncate): the expanded view is the only place a long
                  // query can be read in full — the collapsed header already truncates.
                  <div key={i} className="font-monospace text-text break-words">
                    {query}
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {chips.length > 0 && (
            <DetailSection>
              <DetailLabel>Suggested searches</DetailLabel>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((chip) => (
                  <a
                    key={chip.href}
                    href={chip.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border-border-medium text-text hover:border-border-darker hover:bg-code-bg focus-visible:border-accent focus-visible:ring-accent/50 inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] no-underline transition-colors focus-visible:ring-1"
                  >
                    <GoogleLogo />
                    <span className="truncate">{chip.label}</span>
                  </a>
                ))}
              </div>
            </DetailSection>
          )}

          {failureError !== undefined && (
            <DetailSection>
              <DetailLabel>Error</DetailLabel>
              <ErrorBox>{failureError}</ErrorBox>
            </DetailSection>
          )}

          {showRawFailureResult && (
            <DetailSection>
              <DetailLabel>Result</DetailLabel>
              <div className="bg-code-bg max-h-[300px] overflow-y-auto rounded px-3 py-2 text-[12px]">
                <JsonHighlight value={result} />
              </div>
            </DetailSection>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                Searching
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
