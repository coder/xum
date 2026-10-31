import React, { useState } from "react";
import { ArrowLeft, Loader2, Store, XCircle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { cn } from "@/common/lib/utils";
import type {
  AgentPluginInstallMethod,
  AgentPluginMarketplaceBuild,
  AgentPluginMarketplaceEntry,
  AgentPluginMarketplaceListing,
} from "@/common/orpc/schemas/agentPlugins";
import { displayRepoUrl } from "@/common/utils/agentPluginSource";
import { installMethodLabel } from "./PluginInstallMethods";

type MarketplaceFile = AgentPluginMarketplaceBuild["file"];
export type MarketplaceEntrySelector = Extract<AgentPluginInstallMethod, { entry: string }>;

const MARKETPLACE_FILE: Record<
  MarketplaceFile,
  { selector: MarketplaceEntrySelector["kind"]; build: string; marketplace: string }
> = {
  cursor: {
    selector: "cursor-marketplace",
    build: "Cursor build",
    marketplace: "Cursor marketplace",
  },
  claude: {
    selector: "claude-marketplace",
    build: "Claude build",
    marketplace: "Claude Code marketplace",
  },
};

function pickable(entry: AgentPluginMarketplaceEntry): boolean {
  return entry.builds.some((build) => build.installable);
}

/**
 * The entries of a marketplace repository in the Add panel: the Cursor and Claude Code
 * marketplace files merged by name. The user picks ONE plugin per install and previews it with
 * the normal consent review. A name in both files has two builds, each with its own preview
 * action. Builds that Xum cannot install (npm, archive and command sources, or a malformed entry)
 * are listed, disabled, with the reason.
 */
export const MarketplaceListing: React.FC<{
  listing: AgentPluginMarketplaceListing;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  /** The entry to pick first: the one previewed before Back, else the first one that installs. */
  initialEntry?: string | null;
  /** Another entry is picked: the error of the previous preview no longer applies. */
  onPickEntry: () => void;
  onPreviewEntry: (selector: MarketplaceEntrySelector) => void;
  /** Install the whole repository with another method (Skills) instead of one entry. */
  onPickMethod: (method: AgentPluginInstallMethod) => void;
}> = (props) => {
  // The row index, not the name: a marketplace can list one name twice (the backend keeps both
  // rows and refuses the later one), and two radios must never both be checked. Only a row with
  // an installable build can be picked, and the backend resolves a name to its first such row.
  const [pickedIndex, setPickedIndex] = useState<number | null>(() => {
    const entries = props.listing.entries;
    const again = entries.findIndex(
      (entry) => pickable(entry) && entry.name === props.initialEntry
    );
    const index = again !== -1 ? again : entries.findIndex(pickable);
    return index === -1 ? null : index;
  });
  const picked = pickedIndex === null ? null : (props.listing.entries[pickedIndex] ?? null);
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
        <PreviewEntryButtons picked={picked} busy={props.busy} onPreview={props.onPreviewEntry} />
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
  const files = new Set(
    listing.entries.flatMap((entry) => entry.builds.map((build) => build.file))
  );
  const filesLabel =
    files.size === 2
      ? "Cursor and Claude Code marketplaces"
      : MARKETPLACE_FILE[files.has("cursor") ? "cursor" : "claude"].marketplace;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Store className="text-muted h-4 w-4 shrink-0" aria-hidden />
        <span className="text-foreground text-sm font-medium break-all">{listing.name}</span>
        <span className="text-muted text-xs">
          {filesLabel} · {count === 1 ? "1 plugin" : `${count} plugins`}
        </span>
      </div>
      {/* Catalog text has no length limit: a long word breaks inside instead of overflowing. */}
      {listing.description && (
        <p className="text-muted text-xs break-words">{listing.description}</p>
      )}
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

const EntryRow: React.FC<{
  entry: AgentPluginMarketplaceEntry;
  checked: boolean;
  onPick: () => void;
}> = (props) => {
  const entry = props.entry;
  const single = entry.builds.length === 1 ? entry.builds[0] : null;
  return (
    <label
      className={cn(
        "border-border-medium flex items-start gap-2 rounded border px-2 py-1.5",
        pickable(entry) ? "cursor-pointer" : "opacity-60"
      )}
    >
      {/* The list mounts after the source form's Preview button or the preview's Back button
          unmounts, so the picked entry takes the focus: the arrow keys work at once. */}
      <input
        type="radio"
        name="marketplace-entry"
        value={entry.name}
        autoFocus={props.checked}
        checked={props.checked}
        disabled={!pickable(entry)}
        onChange={props.onPick}
        className="accent-accent mt-0.5 shrink-0"
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-foreground font-mono text-xs break-all">{entry.name}</span>
          {single && <BuildFacts build={single} />}
        </span>
        {entry.description && (
          <span className="text-muted block text-xs break-words">{entry.description}</span>
        )}
        {single ? (
          <BuildReason build={single} />
        ) : (
          entry.builds.map((build) => (
            <span key={build.file} className="block">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-foreground text-[11px]">
                  {MARKETPLACE_FILE[build.file].build}
                </span>
                <BuildFacts build={build} />
              </span>
              <BuildReason build={build} />
            </span>
          ))
        )}
      </span>
    </label>
  );
};

const BuildFacts: React.FC<{ build: AgentPluginMarketplaceBuild }> = (props) => (
  <>
    {props.build.skillCount !== undefined && (
      <span className="text-muted counter-nums text-[11px]">
        {props.build.skillCount === 1 ? "1 skill" : `${props.build.skillCount} skills`}
      </span>
    )}
    <span className="text-muted text-[11px] break-all">{props.build.source}</span>
  </>
);

const BuildReason: React.FC<{ build: AgentPluginMarketplaceBuild }> = (props) =>
  props.build.reason ? (
    <span className="text-warning block text-xs break-words">{props.build.reason}</span>
  ) : null;

const PreviewEntryButtons: React.FC<{
  picked: AgentPluginMarketplaceEntry | null;
  busy: boolean;
  onPreview: (selector: MarketplaceEntrySelector) => void;
}> = (props) => {
  const [clicked, setClicked] = useState<MarketplaceFile | null>(null);
  const picked = props.picked;
  if (picked === null) return <PreviewButton label="Preview" fetching={props.busy} disabled />;
  const single = picked.builds.length === 1;
  return (
    <>
      {picked.builds.map((build) => (
        <PreviewButton
          key={build.file}
          label={
            single ? `Preview ${picked.name}` : `Preview ${MARKETPLACE_FILE[build.file].build}`
          }
          fetching={props.busy && (single || clicked === build.file)}
          disabled={props.busy || !build.installable}
          onClick={() => {
            setClicked(build.file);
            props.onPreview({ kind: MARKETPLACE_FILE[build.file].selector, entry: picked.name });
          }}
        />
      ))}
    </>
  );
};

const PreviewButton: React.FC<{
  label: string;
  fetching: boolean;
  disabled: boolean;
  onClick?: () => void;
}> = (props) => (
  <Button
    size="sm"
    // An entry name has no length limit and may have no break point: let it wrap inside the
    // card instead of widening the action row past a phone screen.
    className="h-auto min-h-8 max-w-full py-1 text-left break-all whitespace-normal"
    onClick={props.onClick}
    disabled={props.disabled}
  >
    {props.fetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
    {props.fetching ? "Fetching…" : props.label}
  </Button>
);
