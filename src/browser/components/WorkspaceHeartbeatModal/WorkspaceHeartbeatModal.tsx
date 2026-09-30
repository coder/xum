import React, { useEffect, useRef, useState } from "react";
import { HeartPulse, Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { useWorkspaceHeartbeat } from "@/browser/hooks/useWorkspaceHeartbeat";
import assert from "@/common/utils/assert";
import {
  clampIntervalMinutes,
  formatIntervalMinutes,
  HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
  HEARTBEAT_MAX_INTERVAL_MINUTES,
  HEARTBEAT_MIN_INTERVAL_MINUTES,
  intervalMinutesToMs,
  parseIntervalMinutes,
} from "@/browser/utils/heartbeatIntervalMinutes";
import {
  HEARTBEAT_DEFAULT_CONTEXT_MODE,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
  HEARTBEAT_DEFAULT_TRIGGER,
  resolveHeartbeatSchedulePolicy,
  type HeartbeatContextMode,
  type HeartbeatTrigger,
  type HeartbeatWhenBusy,
} from "@/constants/heartbeat";
import { SEND_DISPATCH_MODES } from "@/browser/features/ChatInput/sendDispatchModes";

// Shared styling for the modal's <select> controls (trigger, when-busy, context) so the
// three dropdowns stay visually identical.
const HEARTBEAT_SELECT_CLASS_NAME =
  "border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent h-9 w-full rounded-md border px-3 text-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

const HEARTBEAT_TRIGGER_OPTIONS: Array<{
  value: HeartbeatTrigger;
  label: string;
  helperText: string;
}> = [
  {
    value: "idle",
    label: "After inactivity (default)",
    helperText: "Fires only after the workspace has been idle for the full interval.",
  },
  {
    value: "interval",
    label: "Fixed schedule",
    helperText: "Fires on a fixed wall-clock cadence, regardless of activity.",
  },
];

// Reuse the composer's queue-mode vocabulary ("Send after step" / "Send after turn") so the
// when-busy options read the same as the chat input's send dispatch modes.
function getWhenBusyLabel(mode: HeartbeatWhenBusy): string {
  if (mode === "skip") {
    return "Skip";
  }
  return SEND_DISPATCH_MODES.find((entry) => entry.mode === mode)?.label ?? mode;
}

const HEARTBEAT_WHEN_BUSY_HELPER_TEXTS: Record<HeartbeatWhenBusy, string> = {
  skip: "Skips the check-in when the workspace is busy and waits for the next slot.",
  "tool-end": "Queues the check-in into the current turn at the next tool boundary.",
  "turn-end": "Queues the check-in to run as its own turn after the current one.",
};

// "" represents the unset draft: the effective value follows the trigger via
// resolveHeartbeatSchedulePolicy and saves as an explicit null (clear).
type HeartbeatWhenBusyDraft = HeartbeatWhenBusy | "";

const HEARTBEAT_CONTEXT_MODE_OPTIONS: Array<{
  value: HeartbeatContextMode;
  label: string;
  helperText: string;
}> = [
  {
    value: "normal",
    label: "Use existing context",
    helperText: "Send the heartbeat on the current request context.",
  },
  {
    value: "compact",
    label: "Compact before heartbeat",
    helperText: "Runs a real compaction, then sends the heartbeat on the compacted context.",
  },
  {
    value: "reset",
    label: "Reset context before heartbeat",
    helperText:
      "Adds a visible context-reset marker, preserves history, and sends the heartbeat on a fresh request context without generating a summary.",
  },
];

function getHeartbeatContextModeHelperText(mode: HeartbeatContextMode): string {
  return (
    HEARTBEAT_CONTEXT_MODE_OPTIONS.find((option) => option.value === mode)?.helperText ??
    HEARTBEAT_CONTEXT_MODE_OPTIONS[0].helperText
  );
}

interface WorkspaceHeartbeatModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getValidationErrorMessage(value: string): string | null {
  const minutes = parseIntervalMinutes(value);
  if (minutes == null) {
    return "Heartbeat interval must be a whole number of minutes.";
  }

  if (minutes < HEARTBEAT_MIN_INTERVAL_MINUTES || minutes > HEARTBEAT_MAX_INTERVAL_MINUTES) {
    return `Heartbeat interval must be between ${HEARTBEAT_MIN_INTERVAL_MINUTES} and ${HEARTBEAT_MAX_INTERVAL_MINUTES} minutes.`;
  }

  return null;
}

function normalizeDraftMessage(value: string): string | undefined {
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function getDraftMessageForSave(value: string): string {
  return normalizeDraftMessage(value) ?? "";
}

export function WorkspaceHeartbeatModal(props: WorkspaceHeartbeatModalProps) {
  const { settings, isLoading, isSaving, error, save, globalDefaultPrompt } = useWorkspaceHeartbeat(
    {
      workspaceId: props.open ? props.workspaceId : null,
    }
  );
  const settingsContextMode = settings.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE;
  // Trigger draft: unset and "idle" are semantically identical, so the modal never writes
  // "idle" explicitly — the idle option saves `trigger: null` (clear) to keep configs sparse.
  const settingsTrigger = settings.trigger ?? HEARTBEAT_DEFAULT_TRIGGER;
  const settingsWhenBusy: HeartbeatWhenBusyDraft = settings.whenBusy ?? "";
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState(
    formatIntervalMinutes(HEARTBEAT_DEFAULT_INTERVAL_MS)
  );
  const [draftContextMode, setDraftContextMode] = useState<HeartbeatContextMode>(
    HEARTBEAT_DEFAULT_CONTEXT_MODE
  );
  const [draftTrigger, setDraftTrigger] = useState<HeartbeatTrigger>(HEARTBEAT_DEFAULT_TRIGGER);
  const [draftWhenBusy, setDraftWhenBusy] = useState<HeartbeatWhenBusyDraft>("");
  const [draftMessage, setDraftMessage] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const previousOpenRef = useRef(props.open);
  const previousWorkspaceIdRef = useRef(props.workspaceId);
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSyncedSettingsRef = useRef<
    | (Pick<typeof settings, "enabled" | "intervalMs" | "contextMode" | "message"> & {
        trigger: HeartbeatTrigger;
        whenBusy: HeartbeatWhenBusyDraft;
      })
    | null
  >(null);

  useEffect(() => {
    const didOpen = props.open && !previousOpenRef.current;
    const workspaceChanged = previousWorkspaceIdRef.current !== props.workspaceId;
    const lastSyncedSettings = lastSyncedSettingsRef.current;
    const settingsChanged =
      lastSyncedSettings == null ||
      lastSyncedSettings.enabled !== settings.enabled ||
      lastSyncedSettings.intervalMs !== settings.intervalMs ||
      lastSyncedSettings.contextMode !== settingsContextMode ||
      lastSyncedSettings.trigger !== settingsTrigger ||
      lastSyncedSettings.whenBusy !== settingsWhenBusy ||
      lastSyncedSettings.message !== settings.message;

    previousOpenRef.current = props.open;
    previousWorkspaceIdRef.current = props.workspaceId;

    if (!props.open || isLoading) {
      return;
    }

    // Re-sync untouched drafts when freshly loaded settings arrive, but preserve in-progress edits.
    if (didOpen || workspaceChanged || (!draftDirty && settingsChanged)) {
      setDraftEnabled(settings.enabled);
      setDraftIntervalMinutes(formatIntervalMinutes(settings.intervalMs));
      setDraftContextMode(settingsContextMode);
      setDraftTrigger(settingsTrigger);
      setDraftWhenBusy(settingsWhenBusy);
      setDraftMessage(settings.message ?? "");
      setDraftDirty(false);
      lastSyncedSettingsRef.current = {
        enabled: settings.enabled,
        intervalMs: settings.intervalMs,
        contextMode: settingsContextMode,
        trigger: settingsTrigger,
        whenBusy: settingsWhenBusy,
        message: settings.message,
      };
    }
  }, [
    draftDirty,
    isLoading,
    props.open,
    props.workspaceId,
    settings.enabled,
    settings.intervalMs,
    settings.message,
    settingsContextMode,
    settingsTrigger,
    settingsWhenBusy,
  ]);

  const validationError = getValidationErrorMessage(draftIntervalMinutes);
  // Effective whenBusy when left unset — follows the draft trigger live so switching to a
  // fixed schedule immediately shows "Default (Send after turn)".
  const effectiveDefaultWhenBusy = resolveHeartbeatSchedulePolicy({
    trigger: draftTrigger,
  }).whenBusy;
  const errorMessages = [validationError, error].filter(
    (message): message is string => message != null
  );
  const hasBlockingError = isLoading || isSaving || validationError != null;

  const handleIntervalBlur = () => {
    const parsedMinutes = parseIntervalMinutes(draftIntervalMinutes);
    if (parsedMinutes == null) {
      return;
    }

    const clampedMinutes = clampIntervalMinutes(parsedMinutes);
    const clampedMinutesValue = String(clampedMinutes);
    if (clampedMinutesValue !== draftIntervalMinutes) {
      setDraftIntervalMinutes(clampedMinutesValue);
      setDraftDirty(true);
    }
  };

  const handleSave = async () => {
    const parsedMinutes = parseIntervalMinutes(draftIntervalMinutes);
    assert(parsedMinutes != null, "Save should only run with a valid heartbeat interval");
    assert(
      parsedMinutes >= HEARTBEAT_MIN_INTERVAL_MINUTES &&
        parsedMinutes <= HEARTBEAT_MAX_INTERVAL_MINUTES,
      "Save should only run with a heartbeat interval inside the supported range"
    );

    const didSave = await save({
      enabled: draftEnabled,
      intervalMs: intervalMinutesToMs(parsedMinutes),
      contextMode: draftContextMode,
      // Always send both keys: an explicit value persists, null clears back to unset so the
      // effective value keeps following the read-time defaults (see
      // resolveHeartbeatSchedulePolicy). The idle trigger is never written explicitly.
      trigger: draftTrigger === "interval" ? draftTrigger : null,
      whenBusy: draftWhenBusy === "" ? null : draftWhenBusy,
      // Read directly from the textarea on save so the final keystroke is preserved even if the
      // click lands before React finishes flushing the last state update.
      message: getDraftMessageForSave(messageTextareaRef.current?.value ?? draftMessage),
    });
    if (didSave) {
      props.onOpenChange(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl lg:max-w-5xl">
        <DialogHeader className="border-border border-b px-6 py-5 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5" />
            Configure heartbeat
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted h-6 w-6 animate-spin" />
          </div>
        ) : (
          <>
            <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
              <p className="text-muted max-w-3xl text-sm">
                Schedule future background follow-ups for this workspace. Valid range:{" "}
                {HEARTBEAT_MIN_INTERVAL_MINUTES}–{HEARTBEAT_MAX_INTERVAL_MINUTES} minutes. New
                workspaces default to {HEARTBEAT_DEFAULT_INTERVAL_MINUTES} minutes unless you change
                them.
              </p>

              {/* Keep custom heartbeat instructions visible even when disabled so prompts can be edited before scheduling resumes. */}
              <div className="grid gap-4 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
                <div className="border-border rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground text-sm font-medium">Enable heartbeats</div>
                      <div className="text-muted mt-1 text-xs">
                        Keep this workspace eligible for future background heartbeat follow-ups.
                      </div>
                    </div>
                    <Switch
                      checked={draftEnabled}
                      onCheckedChange={(checked) => {
                        setDraftEnabled(checked);
                        setDraftDirty(true);
                      }}
                      disabled={isSaving}
                      aria-label="Enable workspace heartbeats"
                    />
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-4">
                    <label htmlFor="workspace-heartbeat-interval" className="min-w-0 flex-1">
                      <div className="text-foreground text-sm font-medium">Interval</div>
                      <div className="text-muted mt-1 text-xs">Heartbeat cadence in minutes.</div>
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="workspace-heartbeat-interval"
                        type="number"
                        inputMode="numeric"
                        min={HEARTBEAT_MIN_INTERVAL_MINUTES}
                        max={HEARTBEAT_MAX_INTERVAL_MINUTES}
                        step={1}
                        value={draftIntervalMinutes}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                          setDraftIntervalMinutes(event.target.value);
                          setDraftDirty(true);
                        }}
                        onBlur={handleIntervalBlur}
                        disabled={isSaving}
                        className="border-border-medium bg-background-secondary h-9 w-24 text-right"
                        aria-label="Heartbeat interval in minutes"
                      />
                      <span className="text-muted text-sm">min</span>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    <label htmlFor="workspace-heartbeat-trigger" className="block">
                      <div className="text-foreground text-sm font-medium">Trigger</div>
                      <div className="text-muted mt-1 text-xs">
                        Choose how the heartbeat countdown is anchored.
                      </div>
                    </label>
                    <select
                      id="workspace-heartbeat-trigger"
                      value={draftTrigger}
                      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                        const nextTrigger =
                          HEARTBEAT_TRIGGER_OPTIONS.find(
                            (option) => option.value === event.target.value
                          )?.value ?? HEARTBEAT_DEFAULT_TRIGGER;
                        setDraftTrigger(nextTrigger);
                        setDraftDirty(true);
                      }}
                      disabled={isSaving}
                      className={HEARTBEAT_SELECT_CLASS_NAME}
                      aria-label="Heartbeat trigger"
                    >
                      {HEARTBEAT_TRIGGER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-muted text-xs">
                      {
                        (
                          HEARTBEAT_TRIGGER_OPTIONS.find(
                            (option) => option.value === draftTrigger
                          ) ?? HEARTBEAT_TRIGGER_OPTIONS[0]
                        ).helperText
                      }
                    </p>
                  </div>

                  <div className="mt-4 space-y-2">
                    <label htmlFor="workspace-heartbeat-when-busy" className="block">
                      <div className="text-foreground text-sm font-medium">When busy</div>
                      <div className="text-muted mt-1 text-xs">
                        What happens when a heartbeat fires while the workspace is busy.
                      </div>
                    </label>
                    <select
                      id="workspace-heartbeat-when-busy"
                      value={draftWhenBusy}
                      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                        const value = event.target.value;
                        setDraftWhenBusy(
                          value === "skip" || value === "tool-end" || value === "turn-end"
                            ? value
                            : ""
                        );
                        setDraftDirty(true);
                      }}
                      disabled={isSaving}
                      className={HEARTBEAT_SELECT_CLASS_NAME}
                      aria-label="Heartbeat when busy"
                    >
                      {/* The default option's label follows the draft trigger (skip for idle,
                          send-after-turn for interval) via the shared read-time resolver. */}
                      <option value="">{`Default (${getWhenBusyLabel(effectiveDefaultWhenBusy)})`}</option>
                      <option value="skip">{getWhenBusyLabel("skip")}</option>
                      <option value="tool-end">{getWhenBusyLabel("tool-end")}</option>
                      <option value="turn-end">{getWhenBusyLabel("turn-end")}</option>
                    </select>
                    <p className="text-muted text-xs">
                      {
                        HEARTBEAT_WHEN_BUSY_HELPER_TEXTS[
                          draftWhenBusy === "" ? effectiveDefaultWhenBusy : draftWhenBusy
                        ]
                      }
                    </p>
                  </div>

                  <div className="mt-4 space-y-2">
                    <label htmlFor="workspace-heartbeat-context-mode" className="block">
                      <div className="text-foreground text-sm font-medium">Context</div>
                      <div className="text-muted mt-1 text-xs">
                        Choose whether heartbeats reuse, compact, or reset request context.
                      </div>
                    </label>
                    <select
                      id="workspace-heartbeat-context-mode"
                      value={draftContextMode}
                      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                        const nextContextMode =
                          HEARTBEAT_CONTEXT_MODE_OPTIONS.find(
                            (option) => option.value === event.target.value
                          )?.value ?? HEARTBEAT_DEFAULT_CONTEXT_MODE;
                        setDraftContextMode(nextContextMode);
                        setDraftDirty(true);
                      }}
                      disabled={isSaving}
                      className={HEARTBEAT_SELECT_CLASS_NAME}
                      aria-label="Heartbeat context mode"
                    >
                      {HEARTBEAT_CONTEXT_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-muted text-xs">
                      {getHeartbeatContextModeHelperText(draftContextMode)}
                    </p>
                  </div>
                </div>

                <div className="border-border rounded-lg border p-4">
                  <label htmlFor="workspace-heartbeat-message" className="block">
                    <div className="text-foreground text-sm font-medium">Message</div>
                    <div className="text-muted mt-1 text-xs">
                      Leave empty to use the default heartbeat message.
                    </div>
                  </label>
                  <textarea
                    ref={messageTextareaRef}
                    id="workspace-heartbeat-message"
                    rows={10}
                    value={draftMessage}
                    onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                      setDraftMessage(event.target.value);
                      setDraftDirty(true);
                    }}
                    disabled={isSaving}
                    className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent mt-3 min-h-[240px] w-full resize-y rounded-md border p-3 text-sm leading-relaxed focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-[320px]"
                    placeholder={globalDefaultPrompt ?? HEARTBEAT_DEFAULT_MESSAGE_BODY}
                    aria-label="Heartbeat message"
                  />
                </div>
              </div>

              {errorMessages.length > 0 && (
                <div className="bg-danger-soft/10 text-danger-soft space-y-1 rounded-md p-3 text-sm">
                  {errorMessages.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="border-border flex justify-end gap-2 border-t px-6 py-4">
              <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={() => void handleSave()} disabled={hasBlockingError}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
