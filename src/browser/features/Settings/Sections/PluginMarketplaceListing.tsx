import React, { useState } from "react";
import { ArrowLeft, Loader2, Store, XCircle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { cn } from "@/common/lib/utils";
import type {
  AgentPluginInstallMethod,
  AgentPluginMarketplaceEntry,
  AgentPluginMarketplaceListing,
} from "@/common/orpc/schemas/agentPlugins";
import { displayRepoUrl } from "@/common/utils/agentPluginSource";
import { installMethodLabel } from "./PluginInstallMethods";

/**
 * The entries of a Claude Code marketplace in the Add panel. The user picks ONE plugin per
 * install; "Preview <entry>" previews it with the normal consent review. Entries that Xum cannot
 * install (npm, archive and command sources, or a malformed entry) are listed, disabled, with
 * the reason.
 */
export const MarketplaceListing: React.FC<{
  listing: AgentPluginMarketplaceListing;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  /** Another entry is picked: the error of the previous preview no longer applies. */
  onPickEntry: () => void;
  onPreviewEntry: (entry: string) => void;
  /** Install the whole repository with another method (Skills) instead of one entry. */
  onPickMethod: (method: AgentPluginInstallMethod) => void;
}> = (props) => {
  // The row index, not the name: a marketplace can list one name twice (the backend keeps both
  // rows and refuses the later one), and two radios must never both be checked. Only an
  // installable row can be picked, and the backend resolves a name to its first (installable) row.
  const [pickedIndex, setPickedIndex] = useState<number | null>(() => {
    const index = props.listing.entries.findIndex((entry) => entry.installable);
    return index === -1 ? null : index;
  });
  const picked = pickedIndex === null ? null : (props.listing.entries[pickedIndex]?.name ?? null);
  return (
    <div className="space-y-3">
      <MarketplaceHeader listing={props.listing} />
      {/* Native radios: Tab reaches the group, arrow keys move between enabled entries. */}
      <fieldset className="min-w-0 space-y-1" disabled={props.busy}>
        <legend className="text-muted mb-1 text-xs">Pick one plugin to install</legend>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {props.listing.entries.map((entry, index) => (
            <EntryRow
              key={`${index}:${entry.name}`}
              entry={entry}
              checked={pickedIndex === index}
              onPick={() => {
                setPickedIndex(index);
                props.onPickEntry();
              }}
            />
          ))}
        </div>
      </fieldset>
      <ul className="text-warning space-y-0.5 text-xs">
        {props.listing.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
      {props.error !== null && (
        <div
          role="alert"
          className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm"
        >
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{props.error}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={props.onBack} disabled={props.busy}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <PreviewEntryButton picked={picked} busy={props.busy} onPreview={props.onPreviewEntry} />
        {props.listing.methods.map((method) => (
          <Button
            key={method.kind}
            variant="ghost"
            size="sm"
            onClick={() => props.onPickMethod(method)}
            disabled={props.busy}
          >
            Install the repository as {installMethodLabel(method)}
          </Button>
        ))}
      </div>
    </div>
  );
};

/** Marketplace name, size, description and the commit it was read from. */
const MarketplaceHeader: React.FC<{ listing: AgentPluginMarketplaceListing }> = (props) => {
  const listing = props.listing;
  const count = listing.entries.length;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Store className="text-muted h-4 w-4 shrink-0" aria-hidden />
        <span className="text-foreground text-sm font-medium break-all">{listing.name}</span>
        <span className="text-muted text-xs">
          Claude Code marketplace · {count === 1 ? "1 plugin" : `${count} plugins`}
        </span>
      </div>
      {listing.description && <p className="text-muted text-xs">{listing.description}</p>}
      {/* break-words: the line wraps at spaces, and only a word too long for a line (a long
          URL on phone widths) breaks inside, so the owner name stays whole. */}
      <p className="text-muted text-[11px] break-words">
        {displayRepoUrl(listing.source.url)} @ {listing.source.ref} ·{" "}
        {listing.lockedSha.slice(0, 12)}
        {listing.owner ? ` · by ${listing.owner}` : ""}
      </p>
    </div>
  );
};

/** One entry: a radio with its name, skill count, source, description and refusal reason. */
const EntryRow: React.FC<{
  entry: AgentPluginMarketplaceEntry;
  checked: boolean;
  onPick: () => void;
}> = (props) => {
  const entry = props.entry;
  return (
    <label
      className={cn(
        "border-border-medium flex items-start gap-2 rounded border px-2 py-1.5",
        entry.installable ? "cursor-pointer" : "opacity-60"
      )}
    >
      <input
        type="radio"
        name="marketplace-entry"
        value={entry.name}
        checked={props.checked}
        disabled={!entry.installable}
        onChange={props.onPick}
        className="accent-accent mt-0.5 shrink-0"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-foreground font-mono text-xs break-all">{entry.name}</span>
          {entry.skillCount !== undefined && (
            <span className="text-muted counter-nums text-[11px]">
              {entry.skillCount === 1 ? "1 skill" : `${entry.skillCount} skills`}
            </span>
          )}
          <span className="text-muted text-[11px] break-all">{entry.source}</span>
        </span>
        {entry.description && <span className="text-muted block text-xs">{entry.description}</span>}
        {entry.reason && <span className="text-warning block text-xs">{entry.reason}</span>}
      </span>
    </label>
  );
};

const PreviewEntryButton: React.FC<{
  picked: string | null;
  busy: boolean;
  onPreview: (entry: string) => void;
}> = (props) => {
  const picked = props.picked;
  return (
    <Button
      size="sm"
      onClick={() => {
        if (picked !== null) props.onPreview(picked);
      }}
      disabled={props.busy || picked === null}
    >
      {props.busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {props.busy ? "Fetching…" : picked !== null ? `Preview ${picked}` : "Preview"}
    </Button>
  );
};
