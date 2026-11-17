import { FlaskConical } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { SETTINGS_GROUPS } from "../settingsRegistry";
import { SETTINGS_GROUP_CARD_CLASS } from "./SettingsLayout";
import {
  splitHighlights,
  type SettingsSearchEntry,
  type SettingsSearchResult,
  type groupSettingsSearchResults,
} from "../settingsSearch";

const GROUP_LABELS = new Map<string, string>(SETTINGS_GROUPS.map((g) => [g.id, g.label]));

export const settingsSearchResultDomId = (index: number) => `settings-search-result-${index}`;
export const SETTINGS_SEARCH_LISTBOX_ID = "settings-search-results";

function Highlighted(props: { text: string; query: string }) {
  // React nodes, not HTML: setting copy stays escaped.
  return (
    <>
      {splitHighlights(props.text, props.query).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="bg-accent/30 text-content-primary rounded-[2px]">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}

const KIND_LABELS: Partial<Record<SettingsSearchEntry["kind"], string>> = {
  section: "Section",
  provider: "Provider",
};

function SearchResultRow(props: {
  entry: SettingsSearchEntry;
  index: number;
  active: boolean;
  query: string;
  onOpen: () => void;
  onHover: (index: number) => void;
}) {
  const entry = props.entry;
  const kindLabel = KIND_LABELS[entry.kind];
  return (
    <button
      id={settingsSearchResultDomId(props.index)}
      type="button"
      role="option"
      aria-selected={props.active}
      tabIndex={-1}
      onClick={props.onOpen}
      onMouseMove={() => {
        if (!props.active) props.onHover(props.index);
      }}
      className={cn(
        "flex w-full items-start gap-3 px-4 py-2.5 text-left",
        props.active ? "bg-hover" : "hover:bg-hover"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-content-primary flex flex-wrap items-center gap-x-2 text-sm">
          <span>
            <Highlighted text={entry.label} query={props.query} />
          </span>
          {kindLabel ? <span className="text-content-secondary text-xs">{kindLabel}</span> : null}
          {entry.kind === "experiment" ? (
            <span className="text-warning inline-flex items-center gap-1 text-xs">
              <FlaskConical aria-hidden="true" className="h-3 w-3" />
              Experiment
            </span>
          ) : null}
        </div>
        {entry.description ? (
          <div className="text-content-secondary mt-0.5 line-clamp-2 text-xs">
            <Highlighted text={entry.description} query={props.query} />
          </div>
        ) : null}
      </div>
      {entry.shortcut ? (
        <kbd className="bg-surface-primary text-content-primary border-border-medium shrink-0 rounded border px-2 py-0.5 font-mono text-xs">
          {entry.shortcut}
        </kbd>
      ) : null}
    </button>
  );
}

/**
 * Search results grouped by section. Selecting a result opens its section and scrolls to the
 * matching row; the field keeps keyboard focus (combobox pattern), so arrows move the active
 * result and Enter opens it.
 */
export function SettingsSearchResults(props: {
  query: string;
  groups: ReturnType<typeof groupSettingsSearchResults>;
  activeIndex: number;
  onOpen: (result: SettingsSearchResult) => void;
  onHover: (index: number) => void;
}) {
  if (props.groups.length === 0) {
    return (
      <div className="text-content-secondary px-1 py-6 text-sm">
        No settings match &ldquo;{props.query.trim()}&rdquo;.
      </div>
    );
  }

  let index = -1;
  return (
    <div id={SETTINGS_SEARCH_LISTBOX_ID} role="listbox" aria-label="Settings search results">
      {props.groups.map((group) => (
        <section key={group.section.id} className="mb-5" aria-label={group.section.label}>
          <div className="text-content-secondary mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wider uppercase">
            {group.section.icon}
            <span>
              {GROUP_LABELS.get(group.section.group)} › {group.section.label}
            </span>
          </div>
          <div className={SETTINGS_GROUP_CARD_CLASS}>
            {group.results.map((result) => {
              index++;
              const resultIndex = index;
              const active = resultIndex === props.activeIndex;
              return (
                <SearchResultRow
                  key={result.entry.id}
                  entry={result.entry}
                  index={resultIndex}
                  active={active}
                  query={props.query}
                  onOpen={() => props.onOpen(result)}
                  onHover={props.onHover}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
