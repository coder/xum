import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  CircleAlert,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useAPI, useLiveAPI } from "@/browser/contexts/API";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { isLightThemeMode } from "@/browser/utils/highlighting/shiki-shared";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { cn } from "@/common/lib/utils";
import type {
  AgentPluginComponentRef,
  AgentPluginComponents,
  AgentPluginInstallPreview,
  AgentPluginInterfaceSummary,
  AgentPluginListItem,
  AgentPluginPendingSignOuts,
  AgentPluginUpdateCheck,
  AgentPluginUpdateConsent,
  AgentPluginUpdateReview,
} from "@/common/orpc/schemas/agentPlugins";
import type { AgentPluginImportedComponents } from "@/common/config/schemas/agentPluginInstalls";
import { getErrorMessage } from "@/common/utils/errors";
import { publishAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import {
  consumePendingPluginsSectionIntent,
  subscribePluginsSectionIntents,
  type PluginsSectionIntent,
} from "./pluginsSectionIntents";
import {
  describePluginHookHandler,
  PLUGIN_HOOK_STATUS_NOTE,
  PluginHooksPanel,
  cutReviewText,
  kilobytes,
} from "./PluginHooksPanel";

/**
 * Settings → Plugins (global scope only).
 *
 * Managed installs come from the `~/.mux/plugins.json` registry;
 * unmanaged plugin directories found by discovery are listed read-only.
 * Update checks run on section open and on the explicit button only — no
 * background timers, and updates never auto-apply.
 */

/** Compact source display, e.g. "github.com/foo/grill @ main" or "github.com/cursor/plugins/pstack @ main". */
function formatSource(item: AgentPluginListItem): string | null {
  if (!item.source) {
    return null;
  }
  const ref = item.source.refType === "commit" ? item.source.ref.slice(0, 12) : item.source.ref;
  return `${displayRepoUrl(item.source.url)}${subpathSuffix(item.source.subpath)} @ ${ref}`;
}

/**
 * Clone URL without scheme and `.git` ("github.com/foo/grill"), so a monorepo
 * folder appended to it reads as a path, not as an invalid `….git/pstack` URL.
 */
function displayRepoUrl(url: string): string {
  return url
    .replace(/^https:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
}

/** Trimmed optional text-field value, or null when empty. */
function optionalField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Monorepo plugin folder appended to a source URL ("/pstack"), or nothing for root installs. */
function subpathSuffix(subpath: string | undefined): string {
  return subpath === undefined ? "" : `/${subpath}`;
}

const Badge: React.FC<{
  tone: "muted" | "accent" | "warning" | "error";
  /** Manifest text (up to 120 chars) must wrap on narrow cards; status words stay on one line. */
  wrap?: boolean;
  children: React.ReactNode;
}> = (props) => (
  <span
    className={cn(
      "rounded px-1.5 py-0.5 text-[10px] font-medium",
      props.wrap === true ? "max-w-full wrap-anywhere" : "whitespace-nowrap",
      // Foreground text: muted text on this tint stayed below 4.5:1 even after #6544 raised the token.
      props.tone === "muted" && "bg-foreground/10 text-foreground",
      props.tone === "accent" && "bg-accent/15 text-accent-text",
      props.tone === "warning" && "bg-warning/15 text-warning",
      props.tone === "error" && "bg-destructive/15 text-destructive"
    )}
  >
    {props.children}
  </span>
);

/**
 * The interface logo for the current theme. A light logo can vanish on a dark
 * background (#6124), so dark themes use OpenAI's dark variant. Each theme
 * falls back to the other image when its own is missing or failed to read:
 * some logo beats none, as before.
 */
const PluginLogo: React.FC<{
  info: Pick<AgentPluginInterfaceSummary, "logoDataUrl" | "logoDarkDataUrl">;
}> = (props) => {
  const isLight = isLightThemeMode(useTheme().theme);
  const logo = isLight
    ? (props.info.logoDataUrl ?? props.info.logoDarkDataUrl)
    : (props.info.logoDarkDataUrl ?? props.info.logoDataUrl);
  if (logo?.startsWith("data:image/") !== true) return null;
  return <img src={logo} alt="" className="size-8 shrink-0 rounded" />;
};

/**
 * OpenAI `interface` metadata. Every manifest string renders as React text
 * (escaped, no HTML or markdown). The logo is a backend-read data URL, links
 * are https only and open externally (the desktop main process routes
 * _blank navigations through shell.openExternal).
 */
const PluginInterfaceDetails: React.FC<{ info: AgentPluginInterfaceSummary }> = (props) => {
  const links: Array<{ label: string; url: string | undefined }> = [
    { label: "Website", url: props.info.websiteURL },
    { label: "Privacy", url: props.info.privacyPolicyURL },
    { label: "Terms", url: props.info.termsOfServiceURL },
    { label: "Support", url: props.info.supportURL },
  ];
  const httpsLinks = links.filter((link) => link.url?.startsWith("https://") === true);
  return (
    <div className="mt-1 flex min-w-0 items-start gap-2" data-testid="plugin-interface">
      <PluginLogo info={props.info} />
      <div className="min-w-0 space-y-0.5">
        <p className="text-foreground text-xs break-words">
          <span className="font-medium">{props.info.displayName}</span>
          <span className="text-muted"> · by {props.info.developerName}</span>
        </p>
        <p className="text-muted text-xs break-words">{props.info.shortDescription}</p>
        {props.info.capabilities !== undefined && props.info.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {props.info.capabilities.map((capability) => (
              <Badge key={capability} tone="muted" wrap>
                {capability}
              </Badge>
            ))}
          </div>
        )}
        {httpsLinks.length > 0 && (
          <div className="flex flex-wrap gap-x-3 text-[11px]">
            {httpsLinks.map(({ label, url }) => (
              <a
                key={label}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link inline-flex items-center gap-1"
              >
                {label} <ExternalLink aria-hidden className="size-3" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * #6617: a skill's directive commands run when the user invokes it, so the review shows them.
 * The backend escapes invisible characters; React escapes the rest.
 */
const SkillDirectives: React.FC<{ directives?: readonly string[] }> = (props) => {
  if (props.directives === undefined || props.directives.length === 0) return null;
  return (
    <span className="block">
      <span className="text-muted block">Can run these commands when invoked:</span>
      {props.directives.map((command, index) => (
        <code key={index} className="text-foreground block font-mono break-all whitespace-pre-wrap">
          {command}
        </code>
      ))}
    </span>
  );
};

/** Only skills/MCP are selective; keep full-package consent below this shared chooser. */
const ComponentChooser: React.FC<{
  inventory: Pick<AgentPluginComponents, "skills" | "mcpServers">;
  selected: AgentPluginImportedComponents;
  imported?: AgentPluginImportedComponents;
  disabled: boolean;
  onChange: (selection: AgentPluginImportedComponents) => void;
}> = (props) => (
  <div className="space-y-3">
    {(["skills", "mcpServers"] as const).map((group) => {
      const label = group === "skills" ? "Skills" : "MCP servers";
      const entries =
        group === "skills"
          ? props.inventory.skills.map((skill) => ({
              name: skill.name,
              detail: skill.description,
              directives: skill.directives,
            }))
          : props.inventory.mcpServers.map((server) => ({
              name: server.serverName,
              detail: `${server.transport} · ${server.summary}`,
              directives: undefined,
            }));
      const imported = props.imported?.[group] ?? [];
      const selectable = entries.map((entry) => entry.name);
      const count = entries.filter(({ name }) => props.selected[group].includes(name)).length;
      const change = (names: string[]) => props.onChange({ ...props.selected, [group]: names });
      return (
        <fieldset
          key={group}
          aria-label={label}
          className="min-w-0 space-y-1"
          disabled={props.disabled}
        >
          <legend className="text-foreground text-xs font-medium">
            {label}{" "}
            <span className="counter-nums">
              ({count} of {entries.length} selected)
            </span>
          </legend>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={props.disabled || count === entries.length}
              onClick={() => change(selectable)}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={props.disabled || props.selected[group].length === 0}
              onClick={() => change([])}
            >
              Clear
            </Button>
          </div>
          {entries.length === 0 && <p className="text-muted text-xs">None available</p>}
          {entries.map(({ name, detail, directives }) => (
            <label key={name} className="flex items-start gap-2 text-xs">
              <Checkbox
                aria-label={name}
                checked={props.selected[group].includes(name)}
                disabled={props.disabled}
                onCheckedChange={(checked) =>
                  change(
                    checked === true
                      ? [...props.selected[group], name]
                      : props.selected[group].filter((value) => value !== name)
                  )
                }
              />
              <span className="min-w-0 break-words">
                <span className="text-foreground font-mono break-all">{name}</span>
                {imported.includes(name) && <span className="text-muted"> — imported</span>}
                {detail && (
                  <span className="text-muted block break-all whitespace-pre-wrap">{detail}</span>
                )}
                <SkillDirectives directives={directives} />
              </span>
            </label>
          ))}
        </fieldset>
      );
    })}
    <p className="text-muted text-[11px]">
      {props.imported
        ? "New MCP imports need workspace opt-in. Re-adding a server honors its saved workspace enablement."
        : "Importing MCP servers only makes them available; they stay disabled until enabled per workspace."}
    </p>
    <p className="text-muted hidden text-[11px] md:block">
      Tab to navigate · Space to select · Enter to activate buttons
    </p>
  </div>
);

function effectiveImports(inventory: AgentPluginComponents): AgentPluginImportedComponents {
  // Manage saves replace the selection; carrying unavailable names would defeat Clear/empty consent.
  return {
    skills: inventory.skills
      .map((skill) => skill.name)
      .filter(
        (name) =>
          !inventory.importedComponents || inventory.importedComponents.skills.includes(name)
      ),
    mcpServers: inventory.mcpServers
      .map((server) => server.serverName)
      .filter(
        (name) =>
          !inventory.importedComponents || inventory.importedComponents.mcpServers.includes(name)
      ),
  };
}

function sameImports(
  a: AgentPluginImportedComponents | null,
  b: AgentPluginImportedComponents | null
): boolean {
  if (a === null || b === null) return a === b;
  return (["skills", "mcpServers"] as const).every(
    (group) =>
      a[group].every((name) => b[group].includes(name)) &&
      b[group].every((name) => a[group].includes(name))
  );
}

const ManageComponentsPanel: React.FC<{
  name: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}> = (props) => {
  const { api } = useAPI();
  // Keep the raw baseline (including legacy absence) separate from the visible selection.
  const [inventory, setInventory] = useState<AgentPluginComponents | null>(null);
  const [selected, setSelected] = useState<AgentPluginImportedComponents>({
    skills: [],
    mcpServers: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const name = props.name;

  useEffect(() => {
    let ignore = false;
    if (!api) return;
    api.agentPlugins.getComponents({ name }).then(
      (result) => {
        if (ignore) return;
        if (result.success) {
          setInventory(result.data);
          setSelected(effectiveImports(result.data));
        } else setError(result.error);
        setBusy(false);
      },
      (err: unknown) => {
        if (!ignore) {
          setError(getErrorMessage(err));
          setBusy(false);
        }
      }
    );
    return () => {
      ignore = true;
    };
  }, [api, name, loadAttempt]);

  const imported = inventory ? effectiveImports(inventory) : { skills: [], mcpServers: [] };
  const added = (["skills", "mcpServers"] as const).reduce(
    (count, group) =>
      count + selected[group].filter((name) => !imported[group].includes(name)).length,
    0
  );
  const removed = (["skills", "mcpServers"] as const).reduce(
    (count, group) =>
      count + imported[group].filter((name) => !selected[group].includes(name)).length,
    0
  );
  const handleSave = async () => {
    if (!api || !inventory || busy || added + removed === 0) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    let confirmed = false;
    let responseLost = false;
    let savedImports: AgentPluginImportedComponents | null = selected;
    let warning: string | undefined;
    try {
      const result = await api.agentPlugins
        .setComponents({
          name,
          expectedLockedSha: inventory.lockedSha,
          expectedContentHash: inventory.contentHash,
          expectedImportedComponents: inventory.importedComponents ?? null,
          importedComponents: selected,
        })
        .catch((err: unknown) => {
          responseLost = true;
          throw err;
        });
      if (!result.success) throw new Error(result.error);
      confirmed = true;
      warning = result.cleanupWarning;
      savedImports = result.data.importedComponents ?? null;
      publishAgentPluginsMutated();
    } catch (err) {
      setError(getErrorMessage(err));
    }
    // Refetch even after a lost response: a transport failure does not mean the write failed.
    try {
      const current = await api.agentPlugins.getComponents({ name });
      if (!current.success) throw new Error(current.error);
      const sameTree =
        current.data.lockedSha === inventory.lockedSha &&
        current.data.contentHash === inventory.contentHash;
      if (
        (confirmed || responseLost) &&
        sameTree &&
        sameImports(current.data.importedComponents ?? null, savedImports)
      ) {
        setInventory(current.data);
        setSelected(effectiveImports(current.data));
        setSaved(true);
        setError(warning ?? null);
        if (!confirmed) publishAgentPluginsMutated();
        await props.onSaved();
      } else if (
        confirmed ||
        !sameTree ||
        !sameImports(current.data.importedComponents ?? null, inventory.importedComponents ?? null)
      ) {
        setSaved(false);
        setInventory(current.data);
        setSelected(effectiveImports(current.data));
        setError(
          "The installed plugin or selection changed. Inventory refreshed; review your choices and save again."
        );
        // A rejected stale save still discovered newer counts for the surrounding card.
        await props.onSaved();
      }
    } catch (err) {
      setError(
        confirmed
          ? `Components saved, but refreshing failed: ${getErrorMessage(err)}. Reopen to read the saved selection.`
          : `Could not confirm the saved selection: ${getErrorMessage(err)}. Reopen to refresh before retrying.`
      );
      if (confirmed || responseLost) {
        // Refresh counts for acknowledged or possible writes even without an inventory receipt.
        if (!confirmed) publishAgentPluginsMutated();
        await props.onSaved();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-3 rounded-md border p-3">
      <p className="text-foreground text-xs">
        Manage components from the installed version
        {inventory ? ` · ${inventory.lockedSha.slice(0, 12)}` : ""}. No remote fetch.
      </p>
      <p className="text-muted text-xs">
        Removing imports keeps source files, plugin data, and workspace MCP settings. Uninstall is
        separate.
      </p>
      {busy && (
        <p role="status" className="text-muted text-xs">
          {inventory ? "Saving components…" : "Loading components…"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs break-words">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-accent-text text-xs">
          Component selection saved.
        </p>
      )}
      {inventory && (
        <>
          <ComponentChooser
            inventory={inventory}
            imported={imported}
            selected={selected}
            disabled={busy}
            onChange={(selection) => {
              setSelected(selection);
              setSaved(false);
            }}
          />
          <p className="text-muted counter-nums text-xs">
            {added} to add · {removed} to remove
          </p>
          {selected.skills.length + selected.mcpServers.length === 0 && (
            <p className="text-muted text-xs">
              No skills or MCP servers will be imported. The plugin stays installed.
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {inventory ? (
          <Button
            size="sm"
            disabled={busy || added + removed === 0}
            onClick={() => void handleSave()}
          >
            Save changes
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Retry inventory
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onClose}>
          {saved ? "Done" : "Cancel"}
        </Button>
      </div>
    </div>
  );
};

/** Two-phase add flow: source input → consent preview → install. */
const AddPluginPanel: React.FC<{
  onInstalled: () => void;
  onClose: () => void;
}> = (props) => {
  const { api } = useAPI();
  const [input, setInput] = useState("");
  const [ref, setRef] = useState("");
  const [subpath, setSubpath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgentPluginInstallPreview | null>(null);
  const [selected, setSelected] = useState<AgentPluginImportedComponents>({
    skills: [],
    mcpServers: [],
  });

  const handlePreview = async () => {
    if (!api || input.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.agentPlugins.preview({
        input: input.trim(),
        ref: optionalField(ref),
        subpath: optionalField(subpath),
      });
      if (result.success) {
        setPreview(result.data);
        // An accepted preview starts a new consent decision; failed attempts retain choices.
        setSelected({
          skills: result.data.skills.map((skill) => skill.name),
          mcpServers: result.data.mcpServers.map((server) => server.serverName),
        });
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const previewOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void handlePreview();
  };

  const handleInstall = async () => {
    if (!api || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.agentPlugins.install({
        source: preview.source,
        expectedSha: preview.lockedSha,
        importedComponents: selected,
      });
      if (result.success) {
        // Mounted composers cache contributed slash-command/skill
        // descriptors; an install adds them without a remount.
        publishAgentPluginsMutated();
        props.onInstalled();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-border-medium bg-background-secondary space-y-3 rounded-md border p-3">
      {preview === null ? (
        <>
          <div>
            <label htmlFor="plugin-source" className="text-muted mb-1 block text-xs">
              Git URL or owner/repo
            </label>
            <input
              id="plugin-source"
              type="text"
              autoFocus
              placeholder="e.g., owner/repo, owner/repo/path/to/plugin, owner/repo@v1.2.0, or https://github.com/owner/repo.git"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={previewOnEnter}
              spellCheck={false}
              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="plugin-ref" className="text-muted mb-1 block text-xs">
              Branch, tag, or commit SHA (optional — defaults to the default branch)
            </label>
            <input
              id="plugin-ref"
              type="text"
              placeholder="e.g., main, v1.2.0, or a full 40-character SHA"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={previewOnEnter}
              spellCheck={false}
              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
            />
          </div>
          {/* Full URLs (GitLab, self-hosted, SSH, file) cannot carry a folder
              in the source field, so monorepo folders need their own field. */}
          <div>
            <label htmlFor="plugin-subpath" className="text-muted mb-1 block text-xs">
              Plugin folder in the repository (optional — for monorepos)
            </label>
            <input
              id="plugin-subpath"
              type="text"
              placeholder="e.g., packages/my-plugin"
              value={subpath}
              onChange={(e) => setSubpath(e.target.value)}
              onKeyDown={previewOnEnter}
              spellCheck={false}
              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
            />
          </div>
          {error && (
            <div
              role="alert"
              className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handlePreview()}
              disabled={busy || input.trim().length === 0}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Fetching…" : "Preview"}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          {/* Consent preview: everything the plugin will contribute, before anything is written. */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              {/* break-all: a valid 64-char separator-free name has no natural
                  break points and would overflow the card on phone widths. */}
              <span className="text-foreground text-sm font-medium break-all">
                {preview.manifest.name}
              </span>
              {preview.manifest.version && (
                <span className="text-muted text-xs">v{preview.manifest.version}</span>
              )}
              <Badge tone="muted">
                {preview.source.refType} · {preview.lockedSha.slice(0, 12)}
              </Badge>
            </div>
            {preview.manifest.description && (
              <p className="text-muted text-xs">{preview.manifest.description}</p>
            )}
            {preview.manifest.interface && (
              <PluginInterfaceDetails info={preview.manifest.interface} />
            )}
            {/* break-all: URLs and a 64-char separator-free plugin dir name
                have no natural break points and would overflow the card on
                phone widths. */}
            <p className="text-muted text-[11px] break-all">
              {displayRepoUrl(preview.source.url)}
              {subpathSuffix(preview.source.subpath)} @ {preview.source.ref} →{" "}
              <code className="text-accent-text">{preview.targetPath}</code>
              {preview.manifest.authorName ? ` · by ${preview.manifest.authorName}` : ""}
              {preview.manifest.license ? ` · ${preview.manifest.license}` : ""}
            </p>
          </div>

          {preview.warnings.length > 0 && (
            <div className="bg-warning/10 space-y-1 rounded-md px-3 py-2">
              {preview.warnings.map((warning) => (
                <div key={warning} className="text-warning flex items-start gap-2 text-xs">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">{warning}</span>
                </div>
              ))}
            </div>
          )}

          <ComponentChooser
            inventory={preview}
            selected={selected}
            disabled={busy}
            onChange={setSelected}
          />
          <p className="text-warning text-xs">
            {selected.skills.length + selected.mcpServers.length === 0
              ? "No skills or MCP servers selected. "
              : ""}
            Selection does not affect agents, workflows, slash commands, or hooks below: these
            remain part of the install, even when neither group is selected. Skipped files stay on
            disk; this is not a filesystem sandbox.
          </p>

          {preview.agents.length > 0 && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">
                Agents ({preview.agents.length})
              </h4>
              {/* Activatable components: consent must name everything that
                  becomes available after install, not just skills/MCP. */}
              <p className="text-xs">
                <span className="text-foreground font-mono break-all">
                  {preview.agents.join(", ")}
                </span>{" "}
                <span className="text-muted">
                  — become agent definitions. An agent in Claude Code or Cursor format (no Xum-only
                  field such as base or tools) becomes a hidden sub-agent with Exec&apos;s tools. It
                  can run shell commands, which can change any file. readonly: true removes only the
                  file edit and task tools.
                </span>
              </p>
            </div>
          )}

          {preview.workflows.length > 0 && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">
                Workflows ({preview.workflows.length})
              </h4>
              <p className="text-xs">
                <span className="text-foreground font-mono break-all">
                  {preview.workflows.join(", ")}
                </span>{" "}
                <span className="text-muted">
                  — executable workflow scripts, invokable after install.
                </span>
              </p>
            </div>
          )}

          {preview.slashCommands.length > 0 && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">
                Slash commands ({preview.slashCommands.length})
              </h4>
              <ul className="space-y-1">
                {preview.slashCommands.map((command) => (
                  <li key={command.name} className="text-xs">
                    <span className="text-foreground font-mono">/{command.name}</span>
                    {command.description && (
                      <span className="text-muted"> — {command.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ReviewedDefinitions items={preview.reviewedComponents} />

          {preview.codexHooks.length > 0 && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">
                hooks.json hooks ({preview.codexHooks.length})
              </h4>
              {/* Install trusts none of them (Codex trust per hash): consent must say so. */}
              <p className="text-muted mb-1 text-xs">
                None of these run until you trust each one in Settings → Plugins.
              </p>
              <ul className="space-y-1">
                {preview.codexHooks.map((hook) => (
                  <li key={hook.key} className="text-xs break-all">
                    <span className="text-foreground font-mono">{hook.event}</span>
                    {hook.matcher !== undefined && (
                      <span className="text-muted font-mono"> ({hook.matcher})</span>
                    )}
                    <span className="text-muted">
                      {" "}
                      — {describePluginHookHandler(hook.handler)}
                      {PLUGIN_HOOK_STATUS_NOTE[hook.status] != null &&
                        `. ${PLUGIN_HOOK_STATUS_NOTE[hook.status] ?? ""}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.hook && (
            <div>
              <h4 className="text-foreground mb-1 text-xs font-medium">Hooks</h4>
              {/* Executable code that loads automatically: consent must say so. */}
              <p className="text-xs">
                <span className="text-foreground font-mono break-all">{preview.hook.path}</span>{" "}
                <span className="text-muted">
                  — runs sandboxed on every agent request and can observe, rewrite, or block tool
                  calls
                  {preview.hook.toolGrants.length > 0
                    ? ` for: ${preview.hook.toolGrants.join(", ")}`
                    : " (no tool visibility granted)"}
                  .
                </span>
              </p>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm"
            >
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
              disabled={busy}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <Button size="sm" onClick={() => void handleInstall()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Installing…" : "Install"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

/** Inline uninstall confirmation (conditional rendering keeps this testable without portals). */
const UninstallConfirm: React.FC<{
  item: AgentPluginListItem;
  busy: boolean;
  onConfirm: (deletePluginData: boolean) => void;
  onCancel: () => void;
}> = (props) => {
  const [deletePluginData, setDeletePluginData] = useState(false);

  return (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-2 rounded-md border p-3">
      <p className="text-foreground text-xs">
        Uninstall <span className="font-medium">{props.item.name}</span>? This removes the plugin
        directory and its workspace MCP overrides.
      </p>
      <label className="text-muted flex items-center gap-2 text-xs">
        <Checkbox
          checked={deletePluginData}
          onCheckedChange={(checked) => setDeletePluginData(checked === true)}
          disabled={props.busy}
        />
        Also delete stored plugin data
      </label>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => props.onConfirm(deletePluginData)}
          disabled={props.busy}
        >
          {props.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {props.busy ? "Uninstalling…" : "Uninstall"}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

/**
 * In-place re-consent for an update that changes the plugin's capability
 * surface (new/reworded skill advertisements, MCP servers, hooks, agents,
 * …). Shows each change with the consented ("before") and staged ("after")
 * value so the user can judge it, instead of being routed through uninstall
 * + reinstall. Conditional rendering keeps this testable without portals.
 */
/** The component references a review showed; confirming sends them back (#6498). */
function reviewedComponents(review: AgentPluginUpdateReview): AgentPluginComponentRef[] {
  return review.changes.flatMap((change) => (change.component ? [change.component] : []));
}

/**
 * Update review, also reused for the component review of an installed tree (#6498): the same
 * Before/After rows, with `mode: "components"` changing only the wording and the confirm action.
 */
type ReviewPanelMode = "update" | "components";
const REVIEW_PANEL_COPY: Record<
  ReviewPanelMode,
  {
    intro: (review: AgentPluginUpdateReview) => string;
    commits: (review: AgentPluginUpdateReview) => string;
    confirm: string;
    busy: string;
  }
> = {
  update: {
    intro: (review) =>
      `This update${review.version ? ` (v${review.version})` : ""} changes what the plugin can do. Review the changes before applying it:`,
    commits: (review) => `${review.fromSha.slice(0, 12)} → ${review.toSha.slice(0, 12)}`,
    confirm: "Apply update",
    busy: "Updating…",
  },
  components: {
    intro: () =>
      "These plugin components have not been reviewed on this install. Review them before you approve them:",
    commits: (review) => review.fromSha.slice(0, 12),
    confirm: "Approve components",
    busy: "Approving…",
  },
};

const REVIEWED_KIND_LABEL: Record<AgentPluginComponentRef["kind"], string> = {
  skills: "Skill",
  mcpServers: "MCP server",
  workflows: "Workflow",
  agents: "Agent",
  slashCommands: "Slash command",
};

/**
 * The exact definitions install approves besides skills and MCP servers (#6629). The consent
 * record covers these fields, so the preview must show them before Install.
 */
const ReviewedDefinitions: React.FC<{
  items: AgentPluginInstallPreview["reviewedComponents"];
}> = (props) => {
  if (props.items.length === 0) return null;
  return (
    <div>
      <h4 className="text-foreground mb-1 text-xs font-medium">
        Reviewed definitions ({props.items.length})
      </h4>
      <p className="text-muted mb-1 text-xs">
        Installing approves these exact definitions. If one changes later, it does not load until
        you review it again.
      </p>
      <ul className="space-y-1">
        {props.items.map((item) => (
          <li key={`${item.kind}:${item.name}`} className="text-xs">
            <details>
              <summary className="text-foreground cursor-pointer break-all">
                {REVIEWED_KIND_LABEL[item.kind]} <span className="font-mono">{item.name}</span>
              </summary>
              <pre className="bg-modal-bg border-border-medium mt-1 max-h-64 overflow-auto rounded border px-2 py-1 font-mono text-[11px] break-words whitespace-pre-wrap">
                {item.detail}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** The keys of a review's texts that the panel shows cut (`<row>:before|after`). */
function cutReviewTextKeys(review: AgentPluginUpdateReview): string[] {
  return review.changes.flatMap((change, index) =>
    (["before", "after"] as const).flatMap((field) => {
      const text = change[field];
      return text !== undefined && cutReviewText(text).cut ? [`${index}:${field}`] : [];
    })
  );
}

/**
 * Which cut texts of a review the user expanded (#6629). Keys are valid only for the review object
 * they were expanded in: a new review (same plugin, other rows) starts with nothing expanded.
 */
function useCutTextExpansion(review: AgentPluginUpdateReview) {
  const [expansion, setExpansion] = useState<{
    review: AgentPluginUpdateReview | null;
    keys: ReadonlySet<string>;
  }>({ review: null, keys: new Set() });
  const keys = expansion.review === review ? expansion.keys : new Set<string>();
  return {
    isExpanded: (key: string) => keys.has(key),
    mustExpand: cutReviewTextKeys(review).filter((key) => !keys.has(key)),
    expand: (key: string) =>
      setExpansion((previous) => ({
        review,
        keys: new Set(previous.review === review ? previous.keys : []).add(key),
      })),
  };
}

/** One review row: its summary and its before/after texts. */
const ReviewChangeRow: React.FC<{
  change: AgentPluginUpdateReview["changes"][number];
  index: number;
  isExpanded: (key: string) => boolean;
  onExpand: (key: string) => void;
}> = (props) => {
  const fields = (["before", "after"] as const).flatMap((field) => {
    const text = props.change[field];
    return text !== undefined ? [{ field, text, key: `${props.index}:${field}` }] : [];
  });
  return (
    <li className="text-xs">
      <span className="text-foreground break-words">{props.change.summary}</span>
      {fields.length > 0 && (
        <dl className="mt-1 space-y-1">
          {fields.map((item) => (
            <ReviewTextField
              key={item.field}
              label={item.field === "before" ? "Before" : "After"}
              text={item.text}
              expanded={props.isExpanded(item.key)}
              onExpand={() => props.onExpand(item.key)}
            />
          ))}
        </dl>
      )}
    </li>
  );
};

/**
 * One before/after text of a review row (#6629). A long text is cut at the display bound, and the
 * user must show all of it before confirming: a plugin can pad a definition and hide the part that
 * matters after the cut.
 */
const ReviewTextField: React.FC<{
  label: string;
  text: string;
  expanded: boolean;
  onExpand: () => void;
}> = (props) => {
  const view = cutReviewText(props.text);
  return (
    <div className="flex gap-2">
      <dt className="text-muted w-10 shrink-0 text-[11px]">{props.label}</dt>
      <dd className="bg-modal-bg border-border-medium min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] break-words whitespace-pre-wrap">
        {view.cut && !props.expanded ? view.shown : props.text}
        {view.cut && !props.expanded && (
          <Button
            variant="outline"
            size="sm"
            className="mt-1 h-7 px-2 font-sans text-xs"
            onClick={props.onExpand}
          >
            Show full text ({kilobytes(props.text)} KB)
          </Button>
        )}
      </dd>
    </div>
  );
};

const UpdateReviewPanel: React.FC<{
  review: AgentPluginUpdateReview;
  mode: ReviewPanelMode;
  selective: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => {
  const copy = REVIEW_PANEL_COPY[props.mode];
  const expansion = useCutTextExpansion(props.review);
  const mustExpand = expansion.mustExpand;
  return (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-2 rounded-md border p-3">
      <p className="text-foreground text-xs">{copy.intro(props.review)}</p>
      {props.mode !== "components" && props.selective && (
        <p className="text-warning text-xs">
          Your imported selection is preserved. Newly disclosed skills and MCP servers stay
          unimported until you add them; this review still covers the full package.
        </p>
      )}
      <ul className="space-y-2">
        {props.review.changes.map((change, index) => (
          <ReviewChangeRow
            key={change.summary}
            change={change}
            index={index}
            isExpanded={expansion.isExpanded}
            onExpand={expansion.expand}
          />
        ))}
      </ul>
      {props.review.warnings.length > 0 && (
        <div className="bg-warning/10 space-y-1 rounded-md px-3 py-2">
          {props.review.warnings.map((warning) => (
            <div key={warning} className="text-warning flex items-start gap-2 text-xs">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{warning}</span>
            </div>
          ))}
        </div>
      )}
      <p className="text-muted text-[11px] break-all">{copy.commits(props.review)}</p>
      {mustExpand.length > 0 && (
        <p className="text-warning text-xs">
          Show the full text of each cut definition to review it before you confirm.
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={props.onConfirm} disabled={props.busy || mustExpand.length > 0}>
          {props.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {props.busy ? copy.busy : copy.confirm}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

/**
 * The plugin list and the pending sign-out status (#6627). Opening the section retries the
 * sign-outs, so the status is read after the list. When the record existed before the list and is
 * gone after it, the list may still hold rows the fence hid: list once more.
 */
async function listWithSignOuts(api: NonNullable<ReturnType<typeof useAPI>["api"]>) {
  const readStatus = () => api.agentPlugins.pendingSignOuts().catch(() => null);
  const before = await readStatus();
  let result = await api.agentPlugins.list();
  const signOuts = await readStatus();
  if (before !== null && before.kind !== "none" && signOuts?.kind === "none")
    result = await api.agentPlugins.list();
  return { result, signOuts };
}

/** How often the section re-reads a pending sign-out record (the backend retries every 30 s). */
const PENDING_SIGN_OUT_POLL_MS = 30_000;

/**
 * The pending sign-out record (#6627). The section sets it after each list. A background pass
 * (the discovery gate retries every 30 s) can clear or change the record without any section
 * action, so the hook re-reads it while the notice shows.
 */
function usePendingSignOuts(
  api: ReturnType<typeof useAPI>["api"],
  /** Re-lists the plugins: rows read while the record fenced discovery show as missing. */
  onCleared: () => void
): [AgentPluginPendingSignOuts | null, (status: AgentPluginPendingSignOuts | null) => void] {
  const [status, setStatus] = useState<AgentPluginPendingSignOuts | null>(null);
  const shown = status !== null && status.kind !== "none";
  // The interval reads the latest callback (the section's refresh is a plain handler).
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;
  useEffect(() => {
    if (!api || !shown) return;
    // Each read also lets the backend retry the sign-out (at most every 30 s).
    const timer = setInterval(() => {
      api.agentPlugins.pendingSignOuts().then(
        (next) => {
          setStatus(next);
          if (next.kind === "none") onClearedRef.current();
        },
        () => undefined
      );
    }, PENDING_SIGN_OUT_POLL_MS);
    return () => clearInterval(timer);
  }, [api, shown]);
  return [status, setStatus];
}

/**
 * Section notice while a post-update sign-out record exists (#6627). Every discovery gate keeps
 * managed plugins closed until it is gone, and without this notice they only disappear.
 */
const PendingSignOutNotice: React.FC<{
  status: AgentPluginPendingSignOuts | null;
  /** Re-lists the plugins after the sign-out deleted the record. */
  onCleared: () => void;
}> = (props) => {
  const { api } = useAPI();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const status = props.status;
  if (status === null || status.kind === "none") return null;
  // A broken record fences the plugin servers, so Settings → MCP cannot list them. The backend
  // signs out of them from the plugin trees and deletes the record only after that succeeds.
  const signOut = async () => {
    if (!api) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const result = await api.agentPlugins.signOutPluginServers();
      if (result.success) props.onCleared();
      else setSignOutError(result.error);
    } catch (error) {
      setSignOutError(getErrorMessage(error));
    } finally {
      setSigningOut(false);
    }
  };
  return (
    <div
      role="status"
      className="bg-warning/10 text-warning mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      {status.kind === "broken" ? (
        <span className="min-w-0 space-y-2 break-words">
          <span className="block">Managed plugins are unavailable to agents. {status.reason}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={signingOut || !api}
            onClick={() => void signOut()}
          >
            {signingOut ? "Signing out…" : "Sign out of plugin MCP servers"}
          </Button>
          {signOutError !== null && <span className="block">{signOutError}</span>}
        </span>
      ) : (
        <span className="space-y-1 break-words">
          <span className="block">
            Managed plugins are unavailable to agents until Xum finishes signing out of a plugin MCP
            server whose sign-in changed in an update
            {status.servers.length > 0 ? `: ${status.servers.join(", ")}` : ""}. Xum retries on its
            own and each time you open this section.
          </span>
          {status.lastError !== undefined && (
            <span className="block">Last attempt: {status.lastError}</span>
          )}
        </span>
      )}
    </div>
  );
};

/** Section notice while any plugin has components not reviewed on this install (#6498). */
const ComponentReviewNotice: React.FC<{ items: AgentPluginListItem[] | null }> = (props) => {
  if (!(props.items ?? []).some((item) => (item.reviewRequiredCount ?? 0) > 0)) return null;
  return (
    <div
      role="status"
      className="bg-warning/10 text-warning mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-words">
        Some plugins have components (such as skills, MCP servers or workflow scripts) that you have
        not reviewed on this install. Xum loads a plugin component only after you approve its
        current version, so these do not load until you review them. After an upgrade, each plugin
        needs this review once. Select Review on each plugin marked &quot;needs review&quot; to
        approve them.
      </span>
    </div>
  );
};

const NeedsReviewBadge: React.FC<{ item: AgentPluginListItem }> = (props) =>
  (props.item.reviewRequiredCount ?? 0) > 0 ? <Badge tone="warning">needs review</Badge> : null;

const ReviewComponentsButton: React.FC<{
  item: AgentPluginListItem;
  disabled: boolean;
  onReview: () => void;
}> = (props) => {
  if (!props.item.present || (props.item.reviewRequiredCount ?? 0) === 0) return null;
  return (
    <Button
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={props.disabled}
      onClick={props.onReview}
      aria-label={`Review components of ${props.item.name}`}
    >
      Review
    </Button>
  );
};

/**
 * The open component review of the section (#6498) and its actions. Callers share the section's
 * busy and error state, like the update handlers.
 */
interface ComponentReviewDeps {
  api: ReturnType<typeof useAPI>["api"];
  busyPlugin: string | null;
  setBusyPlugin: (name: string | null) => void;
  setError: (error: string | null) => void;
  refresh: () => Promise<void>;
}

/** One busy-guarded plugin action with the section's error capture. */
async function runPluginAction(
  deps: ComponentReviewDeps,
  name: string,
  action: (api: NonNullable<ComponentReviewDeps["api"]>) => Promise<void>
): Promise<void> {
  const api = deps.api;
  if (!api || deps.busyPlugin !== null) return;
  deps.setBusyPlugin(name);
  deps.setError(null);
  try {
    await action(api);
  } catch (err) {
    deps.setError(getErrorMessage(err));
  } finally {
    deps.setBusyPlugin(null);
  }
}

/** What the section shows after a review confirm: its error, or the saved review's cleanup warning. */
function confirmMessage(
  result: { success: true; data: { cleanupWarning?: string } } | { success: false; error: string }
): string | undefined {
  return result.success ? result.data.cleanupWarning : result.error;
}

/**
 * The section's initial palette intent, handed out once. The mount effect reruns on every API
 * reconnect (APIProvider makes a new client), and replaying the intent would reopen a review the
 * user already cancelled (#6609). Only an attempt on a live connection consumes it: while Xum
 * reconnects, `api` can still hold the detached client, whose calls fail, and the live client
 * that replaces it must still get the intent.
 */
function useInitialIntentOnce(
  liveApi: ReturnType<typeof useLiveAPI>,
  initialIntent: PluginsSectionIntent | null
): () => PluginsSectionIntent | null {
  const consumedRef = useRef(false);
  return () => {
    if (!liveApi || consumedRef.current) return null;
    consumedRef.current = true;
    return initialIntent;
  };
}

function useComponentReview(deps: ComponentReviewDeps) {
  const [review, setReview] = useState<AgentPluginUpdateReview | null>(null);
  const open = (name: string) =>
    runPluginAction(deps, name, async (api) => {
      // Close a panel that is open for another plugin first: if this preview fails, the old panel
      // must not stay actionable under this plugin's error.
      setReview(null);
      const preview = await api.agentPlugins.previewComponentReview({ name });
      if (!preview.success) return deps.setError(preview.error);
      const hasRows = preview.data.changes.length > 0;
      setReview(hasRows ? preview.data : null);
      if (!hasRows) await deps.refresh();
    });
  const confirm = (shown: AgentPluginUpdateReview) =>
    runPluginAction(deps, shown.name, async (api) => {
      const result = await api.agentPlugins.confirmComponentReview({
        name: shown.name,
        expectedLockedSha: shown.fromSha,
        reviewed: reviewedComponents(shown),
      });
      if (result.success) {
        publishAgentPluginsMutated();
        setReview(null);
      }
      // Refresh first: its success path clears the error state.
      await deps.refresh();
      const message = confirmMessage(result);
      if (message !== undefined) deps.setError(message);
    });
  /** A palette "Review Plugin Components" intent, also one that arrived before the section mounted. */
  const openFromIntent = (intent: PluginsSectionIntent | null) => {
    if (intent?.type === "review-components") void open(intent.name);
  };
  return { review, open, confirm, openFromIntent, close: () => setReview(null) };
}

/** The component review under its plugin's row (managed rows only, like the update review). */
const ComponentReviewRow: React.FC<{
  item: AgentPluginListItem;
  review: AgentPluginUpdateReview | null;
  busy: boolean;
  onConfirm: (review: AgentPluginUpdateReview) => void;
  onCancel: () => void;
}> = (props) => {
  const review = props.review;
  if (!props.item.managed || review?.name !== props.item.name) return null;
  return (
    <UpdateReviewPanel
      review={review}
      mode="components"
      selective={false}
      busy={props.busy}
      onConfirm={() => props.onConfirm(review)}
      onCancel={props.onCancel}
    />
  );
};

export const PluginsSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const [items, setItems] = useState<AgentPluginListItem[] | null>(null);
  // List/mutation errors and update-check errors live in separate state: the
  // mount-time list query and update check run concurrently, and a later
  // refresh success must not clear a check failure (an unreachable remote has
  // to stay visibly unknown, never silently "up to date").
  const [error, setError] = useState<string | null>(null);
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);
  const [updateChecks, setUpdateChecks] = useState<Map<string, AgentPluginUpdateCheck>>(
    () => new Map()
  );
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // Backend-provided container path: the root is config-derived (canonically
  // ~/.shux, possibly custom/legacy), so this copy must never hardcode it.
  const [containerLocation, setContainerLocation] = useState<string | null>(null);
  // The record that keeps managed plugins closed after a failed post-update sign-out (#6627).
  // Lazy: `refresh` is declared below.
  const [pendingSignOuts, setPendingSignOuts] = usePendingSignOuts(api, () => void refresh());
  // Palette intents (keyboard rule: install/uninstall/update need keyboard
  // paths). The initializer covers palette → fresh mount; the subscription
  // below covers commands invoked while this section is already on screen
  // (same-route navigation preserves the mounted component, so no re-init
  // happens).
  const [initialIntent] = useState(() => consumePendingPluginsSectionIntent());
  const [addOpen, setAddOpen] = useState(initialIntent?.type === "open-add-panel");
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(
    initialIntent?.type === "confirm-uninstall" ? initialIntent.name : null
  );
  const [componentsTarget, setComponentsTarget] = useState<string | null>(
    initialIntent?.type === "manage-components" ? initialIntent.name : null
  );
  const [hooksTarget, setHooksTarget] = useState<string | null>(
    initialIntent?.type === "review-hooks" ? initialIntent.name : null
  );
  const [installSucceeded, setInstallSucceeded] = useState(false);
  /** Name of the plugin with an update/uninstall in flight. */
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);
  /** Pending update whose capability changes await the user's confirmation. */
  const [updateReview, setUpdateReview] = useState<AgentPluginUpdateReview | null>(
    initialIntent?.type === "review-update" ? initialIntent.review : null
  );
  /** Monotonic ids of the latest list/update-check requests; stale responses must not commit state. */
  const listGenerationRef = useRef(0);
  const checkGenerationRef = useRef(0);

  const componentReview = useComponentReview({
    api,
    busyPlugin,
    setBusyPlugin,
    setError,
    // Lazy: `refresh` is declared below.
    refresh: () => refresh(),
  });

  const openAddPanel = () => {
    // Feedback belongs to the completed install, not the next attempt from any entry point.
    setInstallSucceeded(false);
    setAddOpen(true);
  };

  const refresh = async () => {
    if (!api) return;
    // Overlapping list requests race the same way update checks do (mount
    // fetch vs a refresh published after a palette mutation): an older
    // response resolving last would resurrect removed rows or old versions.
    const generation = ++listGenerationRef.current;
    try {
      const { result, signOuts } = await listWithSignOuts(api);
      if (generation !== listGenerationRef.current) {
        return; // A newer list request superseded this one.
      }
      setPendingSignOuts(signOuts);
      if (result.success) {
        setItems(result.data);
        setError(null);
      } else {
        setItems([]);
        setError(result.error);
      }
    } catch (err) {
      if (generation === listGenerationRef.current) {
        setItems([]);
        setError(getErrorMessage(err));
      }
    }
  };

  const checkForUpdates = async () => {
    if (!api) return;
    // Overlapping checks race (mount-time check vs a refresh published by a
    // palette update): only the latest request may commit state, or a stale
    // response can resurrect an update badge the update just cleared.
    const generation = ++checkGenerationRef.current;
    setCheckingUpdates(true);
    try {
      const result = await api.agentPlugins.checkUpdates();
      if (generation !== checkGenerationRef.current) {
        return; // A newer check superseded this one.
      }
      if (result.success) {
        setUpdateChecks(new Map(result.data.map((check) => [check.name, check])));
        setUpdateCheckError(null);
      } else {
        setUpdateCheckError(result.error);
      }
    } catch (err) {
      if (generation === checkGenerationRef.current) {
        setUpdateCheckError(getErrorMessage(err));
      }
    } finally {
      if (generation === checkGenerationRef.current) {
        setCheckingUpdates(false);
      }
    }
  };

  const takeInitialIntent = useInitialIntentOnce(useLiveAPI(), initialIntent);

  // Approved update policy: passive check on section open + explicit button only.
  useEffect(() => {
    // A palette review intent opens after the first list refresh: the refresh clears the shared
    // error, so a concurrent preview failure would vanish without an explanation.
    const intent = takeInitialIntent();
    void refresh().finally(() => componentReview.openFromIntent(intent));
    void checkForUpdates();
    void api?.agentPlugins.containerLocation().then(setContainerLocation, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on mount / API reconnect only; refresh/checkForUpdates are plain handlers (compiler-memoized), not inputs
  }, [api]);

  // The intent listener below subscribes once per API, so it reads the review actions through
  // this ref: they must see the current busy state, or a palette review could start during a
  // running update and clear its busy flag.
  const latestComponentReview = useRef(componentReview);
  useEffect(() => {
    latestComponentReview.current = componentReview;
  });

  // Live palette intents while mounted (see pluginsSectionIntents).
  useEffect(() => {
    return subscribePluginsSectionIntents((intent: PluginsSectionIntent) => {
      switch (intent.type) {
        case "open-add-panel":
          openAddPanel();
          break;
        case "manage-components":
          setComponentsTarget(intent.name);
          break;
        case "review-hooks":
          setHooksTarget(intent.name);
          break;
        case "confirm-uninstall":
          setUninstallTarget(intent.name);
          break;
        case "review-update":
          setUpdateReview(intent.review);
          break;
        case "review-components":
          latestComponentReview.current.openFromIntent(intent);
          break;
        case "refresh":
          void refresh();
          void checkForUpdates();
          break;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resubscribe on API reconnect only; the listener reads the latest handlers via closure per subscription
  }, [api]);

  /**
   * Update click: review first. A capability-neutral update applies right
   * away; one that changes the capability surface opens the inline review,
   * and only its confirmation applies it (with a consent naming the reviewed
   * SHAs — see installService.update).
   */
  const handleUpdate = async (name: string) => {
    if (!api || busyPlugin !== null) return;
    setBusyPlugin(name);
    setError(null);
    setUpdateReview(null);
    // The update moves lockedSha, so an open component review would confirm against a stale tree.
    componentReview.close();
    try {
      const preview = await api.agentPlugins.previewUpdate({ name });
      if (!preview.success) {
        setError(preview.error);
        return;
      }
      if (preview.data.changes.length > 0) {
        setUpdateReview(preview.data);
        return;
      }
      await applyUpdate(name, undefined);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyPlugin(null);
    }
  };

  const handleConfirmUpdate = async (review: AgentPluginUpdateReview) => {
    if (!api || busyPlugin !== null) return;
    setBusyPlugin(review.name);
    setError(null);
    try {
      // Only the shown components get consent records (#6498).
      await applyUpdate(review.name, {
        fromSha: review.fromSha,
        toSha: review.toSha,
        reviewed: reviewedComponents(review),
      });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyPlugin(null);
    }
  };

  /** Shared tail of both update paths; callers own busy state and error capture. */
  const applyUpdate = async (name: string, consent: AgentPluginUpdateConsent | undefined) => {
    if (!api) return;
    const result = await api.agentPlugins.update({ name, consent: consent ?? null });
    if (result.success) {
      // Mounted composers cache contributed slash-command/skill
      // descriptors; an update can change them without a remount.
      publishAgentPluginsMutated();
      setUpdateReview(null);
    }
    // Refresh regardless of outcome (the swap may be partially visible),
    // but re-assert the mutation error AFTER the refresh: refresh's
    // success path clears the error state, which would silently swallow
    // the failure the user needs to see.
    await refresh();
    await checkForUpdates();
    if (!result.success) {
      setError(result.error);
    }
  };

  const handleUninstall = async (name: string, deletePluginData: boolean) => {
    if (!api || busyPlugin !== null) return;
    setBusyPlugin(name);
    setError(null);
    try {
      const result = await api.agentPlugins.uninstall({ name, deletePluginData });
      if (result.success) {
        // Mounted composers cache contributed slash-command/skill
        // descriptors; an uninstall removes them without a remount.
        publishAgentPluginsMutated();
        setUninstallTarget(null);
        await refresh();
      } else {
        // Keep the confirmation open and surface the error after the list
        // refresh (whose success path clears error state).
        await refresh();
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyPlugin(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-muted mb-4 text-xs">
          Install Agent Plugins from git repositories into{" "}
          {containerLocation !== null ? (
            <code className="text-accent-text">{containerLocation}</code>
          ) : (
            "the managed plugins directory"
          )}
          . Plugins contribute skills and default-disabled MCP servers. Installs are global (shared
          by all projects); updates are manual, and updating discards any local edits to the plugin
          directory.
        </p>
      </div>

      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-foreground text-sm font-medium">Installed plugins</h3>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkForUpdates()}
              disabled={checkingUpdates}
            >
              {checkingUpdates ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check for updates
            </Button>
            {!addOpen && (
              <Button size="sm" onClick={openAddPanel}>
                <Plus className="h-3.5 w-3.5" />
                Add plugin
              </Button>
            )}
          </div>
        </div>

        {addOpen && (
          <div className="mb-4">
            <AddPluginPanel
              onInstalled={() => {
                setAddOpen(false);
                setInstallSucceeded(true);
                void refresh();
                void checkForUpdates();
              }}
              onClose={() => setAddOpen(false)}
            />
          </div>
        )}

        {installSucceeded && (
          <p role="status" className="text-accent-text mb-3 text-xs">
            Plugin installed.
          </p>
        )}
        {error && (
          <div className="bg-destructive/10 text-destructive mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        {updateCheckError && (
          <div className="bg-warning/10 text-warning mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">Update check failed: {updateCheckError}</span>
          </div>
        )}

        <PendingSignOutNotice status={pendingSignOuts} onCleared={() => void refresh()} />
        <ComponentReviewNotice items={items} />

        <div className="space-y-2">
          {items === null ? (
            <div className="text-muted flex items-center gap-2 py-4 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading plugins…
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted py-2 text-sm">No plugins installed yet.</p>
          ) : (
            items.map((item) => {
              // Update checks are keyed by MANAGED-registry name: an
              // unmanaged plugin in another container can share the manifest
              // name, and rendering the managed install's check state on its
              // read-only row would mislabel unrelated content ("update
              // available" with no Update action).
              const check = item.managed ? updateChecks.get(item.name) : undefined;
              const updateAvailable =
                item.managed &&
                (check?.status === "update-available" || check?.status === "tag-moved");
              const isBusy = busyPlugin === item.name;

              return (
                <div
                  key={`${item.location}:${item.name}`}
                  className="border-border-medium rounded-md border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        {/* break-all: names can be 64 separator-free chars. */}
                        <span className="text-foreground text-sm font-medium break-all">
                          {item.name}
                        </span>
                        {item.version && (
                          <span className="text-muted text-xs">v{item.version}</span>
                        )}
                        {!item.managed && <Badge tone="muted">unmanaged</Badge>}
                        {item.managed && !item.present && <Badge tone="error">missing</Badge>}
                        {check?.status === "update-available" && (
                          <Badge tone="accent">update available</Badge>
                        )}
                        {check?.status === "tag-moved" && <Badge tone="warning">tag moved</Badge>}
                        {check?.status === "pinned" && <Badge tone="muted">pinned</Badge>}
                        {check?.status === "error" && <Badge tone="warning">check failed</Badge>}
                        <NeedsReviewBadge item={item} />
                      </div>
                      {item.description && (
                        <p className="text-muted mt-0.5 text-xs">{item.description}</p>
                      )}
                      {item.interface && <PluginInterfaceDetails info={item.interface} />}
                      {/* break-all: locations/sources can contain unbreakable
                          64-char tokens (max-length plugin names) that would
                          otherwise overflow the card at phone widths. */}
                      <p className="text-muted counter-nums mt-0.5 text-[11px] break-all">
                        {item.importedSkillCount ?? item.skillCount} of {item.skillCount} skills
                        imported · {item.importedMcpServerCount ?? item.mcpServerCount} of{" "}
                        {item.mcpServerCount} MCP servers imported · <code>{item.location}</code>
                      </p>
                      {formatSource(item) && (
                        <p className="text-muted mt-0.5 text-[11px] break-all">
                          {formatSource(item)}
                          {item.lockedSha ? ` · ${item.lockedSha.slice(0, 12)}` : ""}
                        </p>
                      )}
                      {check?.status === "error" && check.message && (
                        <p className="text-warning mt-0.5 flex items-start gap-1 text-[11px]">
                          <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                          <span className="break-words">{check.message}</span>
                        </p>
                      )}
                    </div>

                    {item.managed && (
                      <div className="flex flex-wrap gap-1">
                        <ReviewComponentsButton
                          item={item}
                          disabled={busyPlugin !== null}
                          onReview={() => void componentReview.open(item.name)}
                        />
                        {item.present && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={busyPlugin !== null}
                            onClick={() => setComponentsTarget(item.name)}
                            aria-label={`Manage components for ${item.name}`}
                          >
                            Manage components
                          </Button>
                        )}
                        {item.present && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={busyPlugin !== null}
                            onClick={() =>
                              setHooksTarget(hooksTarget === item.name ? null : item.name)
                            }
                            aria-label={`Review hooks for ${item.name}`}
                          >
                            Hooks
                          </Button>
                        )}
                        {updateAvailable && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => void handleUpdate(item.name)}
                            disabled={busyPlugin !== null}
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <ArrowDownToLine className="h-3 w-3" />
                            )}
                            Update
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted hover:text-destructive h-7 px-2 text-xs"
                          onClick={() =>
                            setUninstallTarget(uninstallTarget === item.name ? null : item.name)
                          }
                          disabled={busyPlugin !== null}
                          aria-label={`Uninstall ${item.name}`}
                        >
                          <Trash2 className="h-3 w-3" />
                          Uninstall
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Managed rows only: an unmanaged plugin in another
                      container can share the manifest name, and rendering the
                      confirmation under its row would visually attach a
                      backend uninstall of the MANAGED install to a read-only
                      unmanaged plugin. The backend uninstall is keyed by
                      managed-registry name, so the managed row is the one
                      identity-correct anchor. */}
                  {item.managed && item.present && componentsTarget === item.name && (
                    <ManageComponentsPanel
                      key={item.name}
                      name={item.name}
                      onSaved={refresh}
                      onClose={() => setComponentsTarget(null)}
                    />
                  )}
                  {item.managed && item.present && hooksTarget === item.name && (
                    <PluginHooksPanel
                      // Keyed by the installed commit too: an update (here or from the palette)
                      // remounts the panel, so it never shows the old hooks and trust states.
                      key={`${item.name}@${item.lockedSha ?? ""}`}
                      name={item.name}
                      onClose={() => setHooksTarget(null)}
                    />
                  )}
                  {item.managed && updateReview?.name === item.name && (
                    <UpdateReviewPanel
                      review={updateReview}
                      mode="update"
                      selective={item.importedComponents !== undefined}
                      busy={isBusy}
                      onConfirm={() => void handleConfirmUpdate(updateReview)}
                      onCancel={() => setUpdateReview(null)}
                    />
                  )}
                  <ComponentReviewRow
                    item={item}
                    review={componentReview.review}
                    busy={isBusy}
                    onConfirm={(review) => void componentReview.confirm(review)}
                    onCancel={componentReview.close}
                  />
                  {item.managed && uninstallTarget === item.name && (
                    <UninstallConfirm
                      item={item}
                      busy={isBusy}
                      onConfirm={(deletePluginData) =>
                        void handleUninstall(item.name, deletePluginData)
                      }
                      onCancel={() => setUninstallTarget(null)}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
