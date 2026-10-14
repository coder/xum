import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import type { CacheHealth, TurnCacheHealth } from "@/common/utils/tokens/cacheHealth";
import { formatTokens } from "@/common/utils/tokens/tokenMeterUtils";
import { formatCostWithDollar } from "@/common/utils/tokens/usageAggregator";

interface PromptCacheHealthProps {
  /** Cache health of the whole session (sum of every request). */
  session: CacheHealth;
  /** Recent assistant turns, newest first. */
  turns: readonly TurnCacheHealth[];
}

const HEADER_CELL = "text-muted py-1 pr-2 text-left font-medium";
const NUMBER_HEADER_CELL = "text-muted py-1 pr-2 text-right font-medium [&:last-child]:pr-0";
const NUMBER_CELL = "text-foreground counter-nums py-1 pr-2 text-right [&:last-child]:pr-0";

function formatReadRatio(ratio: number | undefined): string {
  return ratio === undefined ? "-" : `${Math.round(ratio * 100)}%`;
}

/** Prompt-cache read share, writes and rewrite cost per session and per recent turn. */
export function PromptCacheHealth(props: PromptCacheHealthProps) {
  const coldStarts = props.turns.filter((turn) => turn.coldStart).length;

  return (
    <div data-testid="prompt-cache-health" className="mt-4">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-foreground cursor-help font-medium">Prompt cache</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64 whitespace-normal">
            Read: share of prompt tokens served from the cache. Writes: tokens written to the cache.
            Rewrite: what those writes cost. Cold: the turn wrote over half its prompt to the cache.
          </TooltipContent>
        </Tooltip>
        <span className="text-muted counter-nums text-xs">
          {formatReadRatio(props.session.readRatio)} read
        </span>
      </div>
      <dl className="text-muted mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <div className="flex gap-1">
          <dt>Writes</dt>
          <dd className="text-foreground counter-nums">
            {formatTokens(props.session.cacheWriteTokens)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Rewrite</dt>
          <dd className="text-foreground counter-nums">
            {formatCostWithDollar(props.session.rewriteCostUsd) || "-"}
          </dd>
        </div>
        {props.turns.length > 0 && (
          <div className="flex gap-1">
            <dt>Cold starts</dt>
            <dd className="text-foreground counter-nums">
              {coldStarts} of last {props.turns.length}
            </dd>
          </div>
        )}
      </dl>
      {props.turns.length > 0 && (
        <table data-testid="prompt-cache-turns" className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-border-light border-b">
              <th className={HEADER_CELL}>Turn</th>
              <th className={NUMBER_HEADER_CELL}>Read</th>
              <th className={NUMBER_HEADER_CELL}>Writes</th>
              <th className={NUMBER_HEADER_CELL}>Rewrite</th>
            </tr>
          </thead>
          <tbody>
            {props.turns.map((turn) => (
              <tr key={turn.messageId}>
                <td className="text-foreground py-1 pr-2">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    {/* Absolute time: a relative label would go stale while the tab stays open. */}
                    {turn.timestamp === undefined ? "-" : formatTimestamp(turn.timestamp)}
                    {turn.coldStart && <span className="text-warning">cold</span>}
                  </span>
                </td>
                <td className={NUMBER_CELL}>{formatReadRatio(turn.readRatio)}</td>
                <td className={NUMBER_CELL}>{formatTokens(turn.cacheWriteTokens)}</td>
                <td className={NUMBER_CELL}>{formatCostWithDollar(turn.rewriteCostUsd) || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
