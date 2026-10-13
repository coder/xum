import React, { useImperativeHandle, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { Select } from "@/browser/components/Select/Select";
import { Switch } from "@/browser/components/Switch/Switch";
import { useAPI } from "@/browser/contexts/API";
import { formatKeybind, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { getOwn } from "@/common/utils/getOwn";
import {
  validateMCPSettingValue,
  type MCPSettingSchema,
  type MCPSettingValue,
  type MCPSettingsSnapshot,
} from "@/common/utils/mcpSettings";

interface MCPServerSettingsSectionProps {
  workspaceId: string;
  serverName: string;
  snapshot: MCPSettingsSnapshot;
  /**
   * Called when a save starts (it takes the save's settings request); the returned callback
   * gets the values a successful save returned. The dialog keeps them as the snapshot's
   * values, so a remount (server toggled off and on) starts from what the server stored.
   */
  beginSave: () => (values: MCPSettingsSnapshot["values"]) => void;
}

/** Lets the dialog check, at Save time, for edits this section has not saved yet. */
export interface MCPServerSettingsSectionHandle {
  hasUnsavedChanges: () => boolean;
}

/**
 * OpenAI structured settings (`openai/settings`) of one workspace server:
 * native controls drawn from the server's schema, in its layout groups.
 * Server strings render as plain text. Saves send only the values that differ
 * from the last values the server returned (read or update result); a failed
 * save shows the error and restores those values.
 */
export const MCPServerSettingsSection = React.forwardRef<
  MCPServerSettingsSectionHandle,
  MCPServerSettingsSectionProps
>(function MCPServerSettingsSection(props, ref) {
  const { api } = useAPI();
  const [saved, setSaved] = useState(props.snapshot.values);
  const [draft, setDraft] = useState(props.snapshot.values);
  // Number inputs keep their raw text so a half-typed "1." is not rewritten.
  const [numberText, setNumberText] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { properties } = props.snapshot;
  const changed = Object.fromEntries(
    Object.entries(draft).filter(([name, value]) => getOwn(saved, name) !== value)
  );
  const errors: Record<string, string> = {};
  for (const [name, value] of Object.entries(draft)) {
    const schema = getOwn(properties, name);
    const message = schema && validateMCPSettingValue(schema, value);
    if (message) errors[name] = `${schema.title} ${message}`;
  }
  const canSave = Object.keys(changed).length > 0 && Object.keys(errors).length === 0 && !saving;
  // The dialog's Save does not send settings, so it must not close over a pending edit.
  useImperativeHandle(ref, () => ({ hasUnsavedChanges: () => Object.keys(changed).length > 0 }));

  const setValue = (name: string, value: MCPSettingValue) => setDraft({ ...draft, [name]: value });

  const save = async () => {
    if (!api) return;
    setSaving(true);
    setError(null);
    const onSaved = props.beginSave();
    try {
      const result = await api.mcp.settings.update({
        workspaceId: props.workspaceId,
        serverName: props.serverName,
        set: changed,
      });
      if (result.success) {
        setSaved(result.data);
        setDraft(result.data);
        onSaved(result.data);
      } else {
        setError(result.error);
        setDraft(saved);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDraft(saved);
    } finally {
      setNumberText({});
      setSaving(false);
    }
  };

  // Every control is disabled while a save is in flight (`saving`): the response replaces the
  // draft, so an edit made meanwhile would be lost silently.
  const renderControl = (name: string, schema: MCPSettingSchema) => {
    const value = getOwn(draft, name);
    const label = `${schema.title} setting`;
    if (schema.type === "boolean")
      return (
        <Switch
          checked={value === true}
          onCheckedChange={(checked) => setValue(name, checked)}
          aria-label={label}
          disabled={saving}
        />
      );
    if (schema.type === "string" && schema.enum !== undefined) {
      // Option values are indexes: "" is a valid enum option, but not a valid Select value.
      const options = schema.enum;
      return (
        <Select
          value={String(options.indexOf(typeof value === "string" ? value : ""))}
          options={options.map((option, index) => ({
            value: String(index),
            label: option === "" ? "(empty)" : option,
          }))}
          onChange={(next) => setValue(name, options[Number(next)] ?? "")}
          aria-label={label}
          disabled={saving}
          className="w-40 max-w-full"
        />
      );
    }
    if (schema.type === "string")
      return (
        <Input
          value={typeof value === "string" ? value : ""}
          onChange={(event) => setValue(name, event.target.value)}
          aria-label={label}
          disabled={saving}
          className="w-40 max-w-full"
        />
      );
    return (
      <Input
        type="number"
        value={getOwn(numberText, name) ?? String(value ?? "")}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.multipleOf ?? (schema.type === "integer" ? 1 : "any")}
        onChange={(event) => {
          setNumberText({ ...numberText, [name]: event.target.value });
          // An empty or partial number stays invalid instead of becoming 0.
          setValue(name, event.target.value.trim() === "" ? NaN : Number(event.target.value));
        }}
        aria-label={label}
        disabled={saving}
        className="w-28 max-w-full"
      />
    );
  };

  return (
    <div
      className="mt-4 space-y-3 border-t pt-4"
      data-testid="mcp-server-settings"
      onKeyDown={(event) => {
        if (!matchesKeybind(event, KEYBINDS.SAVE_EDIT)) return;
        event.preventDefault();
        if (canSave) void save();
      }}
    >
      <div className="text-sm font-medium">Settings</div>
      {props.snapshot.droppedSettingCount > 0 && (
        <div className="bg-warning/10 text-warning flex items-start gap-2 rounded-md px-3 py-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This server sent {props.snapshot.droppedSettingCount}{" "}
            {props.snapshot.droppedSettingCount === 1 ? "setting" : "settings"} Xum cannot show
          </span>
        </div>
      )}
      {props.snapshot.layout.map((group) => (
        <div key={group.title} className="space-y-2">
          <div className="text-content-secondary text-xs font-medium wrap-anywhere">
            {group.title}
          </div>
          {group.items.map((item) => {
            if (item.kind === "tool")
              return (
                <div
                  key={`tool:${item.tool}`}
                  className="text-content-secondary flex items-center justify-between gap-3 text-xs opacity-60"
                  aria-disabled="true"
                >
                  <span className="min-w-0 wrap-anywhere">{item.description ?? item.tool}</span>
                  <span className="shrink-0">Opens in a later version</span>
                </div>
              );
            const schema = getOwn(properties, item.property);
            if (schema === undefined) return null;
            return (
              <div key={item.property} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm wrap-anywhere">{schema.title}</div>
                  {schema.description && (
                    <div className="text-content-secondary text-xs wrap-anywhere">
                      {schema.description}
                    </div>
                  )}
                  {getOwn(errors, item.property) && (
                    <div className="text-danger-soft text-xs" role="alert">
                      {getOwn(errors, item.property)}
                    </div>
                  )}
                </div>
                <div className="shrink-0">{renderControl(item.property, schema)}</div>
              </div>
            );
          })}
        </div>
      ))}
      {error && (
        <div className="bg-danger-soft/10 text-danger-soft rounded-md p-2 text-xs wrap-anywhere">
          {error}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted mobile-hide-shortcut-hints text-[10px]">
          {formatKeybind(KEYBINDS.SAVE_EDIT)} to save
        </span>
        <Button size="sm" onClick={() => void save()} disabled={!canSave}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save settings
        </Button>
      </div>
    </div>
  );
});
