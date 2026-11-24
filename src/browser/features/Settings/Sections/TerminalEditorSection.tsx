import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import { useAPI, useLiveAPI, type APIClient } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  DEFAULT_TERMINAL_BADGE_CONFIG,
  DEFAULT_TERMINAL_FONT_CONFIG,
  TERMINAL_BADGE_POSITIONS,
  normalizeEditorConfig,
  normalizeTerminalBadgeConfig,
  normalizeTerminalFontConfig,
  type EditorConfig,
  type EditorType,
  type TerminalBadgeConfig,
  type TerminalBadgePosition,
  type TerminalFontConfig,
} from "@/common/constants/storage";
import {
  appendTerminalIconFallback,
  getPrimaryFontFamily,
  isFontFamilyAvailableInBrowser,
  isGenericFontFamily,
} from "@/browser/terminal/terminalFontFamily";
import {
  SETTING_SELECT_TRIGGER_CLASS,
  SettingRow,
  SettingsGroup,
} from "../Components/SettingsLayout";
import { isBrowserMode } from "./settingsEnv";

/** The font to check, or undefined when there is nothing a warning could say. */
function checkablePrimaryFont(config: TerminalFontConfig): string | undefined {
  if (typeof document === "undefined") return undefined;
  const primary = getPrimaryFontFamily(config.fontFamily)?.trim();
  // Geist Mono is bundled via @font-face. Treat it as always available so we don't show a
  // false-negative warning before the webfont finishes loading.
  if (!primary || primary.toLowerCase() === "geist mono" || isGenericFontFamily(primary)) {
    return undefined;
  }
  return primary;
}

function getTerminalFontAvailabilityWarning(config: TerminalFontConfig): string | undefined {
  const primary = checkablePrimaryFont(config);
  if (!primary || isFontFamilyAvailableInBrowser(primary, config.fontSize)) return undefined;
  // A "Nerd Font" that is missing often has its "Nerd Font Mono" variant installed.
  const monoCandidate = `${primary} Mono`;
  const suggestMono =
    primary.endsWith("Nerd Font") && isFontFamilyAvailableInBrowser(monoCandidate, config.fontSize);
  return suggestMono
    ? `Font "${primary}" not found. Try "${monoCandidate}".`
    : `Font "${primary}" not found in this browser.`;
}

const EDITOR_OPTIONS: Array<{ value: EditorType; label: string }> = [
  { value: "vscode", label: "VS Code" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
  { value: "custom", label: "Custom" },
];
const TERMINAL_BADGE_POSITION_LABELS: Record<TerminalBadgePosition, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "bottom-left": "Bottom left",
  "bottom-right": "Bottom right",
};
const TERMINAL_BADGE_POSITION_OPTIONS = TERMINAL_BADGE_POSITIONS.map((value) => ({
  value,
  label: TERMINAL_BADGE_POSITION_LABELS[value],
}));

/** Terminal, editor and debugging settings (split out of General, which had nine groups). */
export function TerminalEditorSection() {
  return (
    <div className="space-y-8">
      <TerminalSettings />
      <EditorSettings />
      <DebugLogsSetting />
    </div>
  );
}

const TERMINAL_FONT_PREVIEW_TEXT = [
  String.fromCodePoint(0xf024b), // md-folder
  String.fromCodePoint(0xf0214), // md-file
  String.fromCodePoint(0xf02a2), // md-git
  String.fromCodePoint(0xea85), // cod-terminal
  String.fromCodePoint(0xe725), // dev-git_branch
  String.fromCodePoint(0xf135), // fa-rocket
].join(" ");

/** Parse a positive number typed in a field; undefined keeps the stored value. */
function parsePositive(rawValue: string, max = Infinity): number | undefined {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max ? parsed : undefined;
}

function TerminalSettings() {
  return (
    <SettingsGroup title="Terminal">
      <TerminalFontRows />
      <TerminalBadgeRows />
    </SettingsGroup>
  );
}

function TerminalFontRows() {
  const rawTerminalFontConfig = useUserPreferences(
    (preferences) => preferences.appearance?.terminalFontConfig
  );
  const terminalFontConfig = normalizeTerminalFontConfig(rawTerminalFontConfig);
  const terminalFontWarning = getTerminalFontAvailabilityWarning(terminalFontConfig);

  // Font fields are patched one at a time so a concurrent edit of the other field survives.
  const handleTerminalFontFamilyChange = (fontFamily: string) => {
    updateUserPreferences({
      appearance: { terminalFontConfig: { fontFamily: fontFamily.trim() ? fontFamily : null } },
    });
  };
  const handleTerminalFontSizeChange = (rawValue: string) => {
    const fontSize = parsePositive(rawValue);
    if (fontSize === undefined) return;
    updateUserPreferences({ appearance: { terminalFontConfig: { fontSize } } });
  };

  return (
    <>
      <SettingRow
        id="terminal-font"
        hint={
          <>
            {terminalFontWarning ? (
              <div className="text-warning text-xs">{terminalFontWarning}</div>
            ) : null}
            <div className="text-muted text-xs">
              Preview:{" "}
              <span
                className="text-foreground"
                style={{ fontFamily: appendTerminalIconFallback(terminalFontConfig.fontFamily) }}
              >
                {TERMINAL_FONT_PREVIEW_TEXT}
              </span>
            </div>
          </>
        }
      >
        <Input
          // Stored value: a cleared field stays empty instead of snapping back to the default.
          value={rawTerminalFontConfig?.fontFamily ?? ""}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            handleTerminalFontFamilyChange(e.target.value)
          }
          placeholder={DEFAULT_TERMINAL_FONT_CONFIG.fontFamily}
          aria-label="Terminal Font"
          className="border-border-medium bg-surface-primary h-9 w-80 max-w-full"
        />
      </SettingRow>

      <SettingRow id="terminal-font-size">
        <Input
          type="number"
          value={terminalFontConfig.fontSize}
          min={6}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            handleTerminalFontSizeChange(e.target.value)
          }
          aria-label="Terminal Font Size"
          className="border-border-medium bg-surface-primary h-9 w-28"
        />
      </SettingRow>
    </>
  );
}

function TerminalBadgeRows() {
  const rawTerminalBadgeConfig = useUserPreferences(
    (preferences) => preferences.appearance?.terminalBadgeConfig
  );
  const terminalBadgeConfig = normalizeTerminalBadgeConfig(rawTerminalBadgeConfig);

  // Config objects are written whole: a merge patch keeps omitted fields, so a partial object
  // over a missing server value would fail the schema.
  const patchBadge = (patch: Partial<TerminalBadgeConfig>) => {
    updateUserPreferences({
      appearance: { terminalBadgeConfig: { ...terminalBadgeConfig, ...patch } },
    });
  };
  const handleTerminalBadgeOpacityChange = (rawValue: string) => {
    const percent = parsePositive(rawValue, 100);
    if (percent !== undefined) patchBadge({ opacity: percent / 100 });
  };
  const handleTerminalBadgeFontSizeChange = (rawValue: string) => {
    const fontSize = parsePositive(rawValue);
    if (fontSize !== undefined) patchBadge({ fontSize });
  };

  return (
    <>
      <SettingRow id="terminal-badge">
        <Switch
          checked={terminalBadgeConfig.enabled}
          onCheckedChange={(enabled) => patchBadge({ enabled })}
          aria-label="Toggle Terminal Badge"
        />
      </SettingRow>

      {terminalBadgeConfig.enabled && (
        <>
          <SettingRow
            id="terminal-badge-template"
            hint={
              <div className="text-muted text-xs">
                {"{tab}"} follows the tab label (shell titles); {"{index}"} is the stable tab number
              </div>
            }
          >
            <Input
              value={terminalBadgeConfig.template}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                patchBadge({ template: e.target.value })
              }
              placeholder={DEFAULT_TERMINAL_BADGE_CONFIG.template}
              aria-label="Terminal Badge Template"
              className="border-border-medium bg-surface-primary h-9 w-80 max-w-full"
            />
          </SettingRow>

          <SettingRow id="terminal-badge-position">
            <Select
              value={terminalBadgeConfig.position}
              onValueChange={(value) => patchBadge({ position: value as TerminalBadgePosition })}
            >
              <SelectTrigger className={SETTING_SELECT_TRIGGER_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TERMINAL_BADGE_POSITION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow id="terminal-badge-opacity">
            <Input
              type="number"
              value={Math.round(terminalBadgeConfig.opacity * 100)}
              min={1}
              max={100}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleTerminalBadgeOpacityChange(e.target.value)
              }
              aria-label="Terminal Badge Opacity"
              className="border-border-medium bg-surface-primary h-9 w-28"
            />
          </SettingRow>

          <SettingRow id="terminal-badge-font-size">
            <Input
              type="number"
              value={terminalBadgeConfig.fontSize}
              min={6}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleTerminalBadgeFontSizeChange(e.target.value)
              }
              aria-label="Terminal Badge Font Size"
              className="border-border-medium bg-surface-primary h-9 w-28"
            />
          </SettingRow>
        </>
      )}
    </>
  );
}

function EditorSettings() {
  return (
    <SettingsGroup title="Editor">
      <EditorRows />
      {isBrowserMode() ? <SshHostRow /> : null}
    </SettingsGroup>
  );
}

function EditorRows() {
  const rawEditorConfig = useUserPreferences((preferences) => preferences.appearance?.editorConfig);
  const editorConfig = normalizeEditorConfig(rawEditorConfig);

  // Config objects are written whole: a merge patch keeps omitted fields, so a partial object
  // over a missing server value would fail the schema.
  const setEditorConfig = (next: EditorConfig) => {
    updateUserPreferences({
      appearance: {
        editorConfig: { editor: next.editor, customCommand: next.customCommand ?? null },
      },
    });
  };

  return (
    <>
      <SettingRow id="editor">
        <Select
          value={editorConfig.editor}
          onValueChange={(editor) =>
            setEditorConfig({ ...editorConfig, editor: editor as EditorType })
          }
        >
          <SelectTrigger className={SETTING_SELECT_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EDITOR_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      {editorConfig.editor === "custom" && (
        <SettingRow
          id="editor-custom-command"
          hint={
            isBrowserMode() ? (
              <div className="text-warning mt-1 text-xs">
                Custom editors are not supported in browser mode. Use VS Code or Cursor instead.
              </div>
            ) : null
          }
        >
          <Input
            value={editorConfig.customCommand ?? ""}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setEditorConfig({
                ...editorConfig,
                customCommand: e.target.value.trim() ? e.target.value : undefined,
              })
            }
            placeholder="e.g., nvim"
            aria-label="Custom Command"
            className="border-border-medium bg-surface-primary h-9 w-40"
          />
        </SettingRow>
      )}
    </>
  );
}

/** The host the backend kept, "" when none, undefined when it could not be read. */
async function readSavedSshHost(api: APIClient): Promise<string | undefined> {
  try {
    return (await api.server.getSshHost()) ?? "";
  } catch {
    return undefined;
  }
}

/** Browser mode only: the host 'Open in Editor' deep links point at. */
function SshHostRow() {
  const { api } = useAPI();
  const offline = useLiveAPI() == null;
  const [sshHost, setSshHost] = useState<string>("");
  const [sshHostLoaded, setSshHostLoaded] = useState(false);
  const sshHostEditRef = useRef(0);

  useEffect(() => {
    if (!api) return;
    void api.server.getSshHost().then((host) => {
      setSshHost(host ?? "");
      setSshHostLoaded(true);
    });
  }, [api]);

  const handleSshHostChange = useCallback(
    (value: string) => {
      const edit = ++sshHostEditRef.current;
      setSshHost(value);
      if (!api) return;
      // Save to server (debounced effect would be better, but keeping it simple)
      api.server.setSshHost({ sshHost: value || null }).catch(async () => {
        // A rejected save leaves the backend on its old host (#4748): show that instead of the
        // unsaved value, unless the user has typed again since.
        const saved = await readSavedSshHost(api);
        if (saved !== undefined && edit === sshHostEditRef.current) setSshHost(saved);
      });
    },
    [api]
  );

  if (!sshHostLoaded) return null;
  return (
    <SettingRow id="ssh-host">
      <Input
        value={sshHost}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSshHostChange(e.target.value)}
        placeholder={window.location.hostname}
        disabled={offline}
        aria-label="SSH Host"
        className="border-border-medium bg-surface-primary h-9 w-40"
      />
    </SettingRow>
  );
}

function DebugLogsSetting() {
  const { api } = useAPI();
  const offline = useLiveAPI() == null;
  const [llmDebugLogs, setLlmDebugLogs] = useState(false);
  const llmDebugLogsLoadNonceRef = useRef(0);
  const llmDebugLogsUpdateChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!api) {
      return;
    }
    const nonce = ++llmDebugLogsLoadNonceRef.current;
    void api.config
      .getConfig()
      .then((cfg) => {
        if (nonce === llmDebugLogsLoadNonceRef.current) {
          setLlmDebugLogs(cfg.llmDebugLogs === true);
        }
      })
      .catch((error: unknown) => {
        // A lost connection is no read failure: the reconnect reads again.
        if (isConnectionLostError(error)) return;
      });
  }, [api]);

  const handleLlmDebugLogsChange = (checked: boolean) => {
    // Invalidate any in-flight debug-log load so it doesn't overwrite the user's selection.
    llmDebugLogsLoadNonceRef.current++;
    setLlmDebugLogs(checked);
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.LLM_DEBUG_LOGS_CHANGED, {
        enabled: checked,
      })
    );

    if (!api?.config?.updateLlmDebugLogs) {
      return;
    }

    // Serialize writes so rapid toggles always persist the last user choice.
    llmDebugLogsUpdateChainRef.current = llmDebugLogsUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() => api.config.updateLlmDebugLogs({ enabled: checked }))
      .then(() => {
        // Coerce the chain back to Promise<void>.
      })
      .catch(() => {
        // Best-effort persistence.
      });
  };

  return (
    <SettingsGroup title="Debugging">
      <SettingRow id="api-debug-logs">
        <Switch
          checked={llmDebugLogs}
          onCheckedChange={handleLlmDebugLogsChange}
          disabled={offline}
          aria-label="Toggle API Debug Logs"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
