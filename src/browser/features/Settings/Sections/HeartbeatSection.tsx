import React, { useCallback, useEffect, useRef, useState } from "react";

import { Input } from "@/browser/components/Input/Input";
import { useAPI, useLiveAPI } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import {
  clampIntervalMinutes,
  formatIntervalMinutes,
  HEARTBEAT_MAX_INTERVAL_MINUTES,
  HEARTBEAT_MIN_INTERVAL_MINUTES,
  intervalMinutesToMs,
  parseIntervalMinutes,
} from "@/browser/utils/heartbeatIntervalMinutes";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
} from "@/constants/heartbeat";
import { ConfigSwitchSetting, type SettingsApi } from "./ConfigSwitchSetting";

const loadAgentHeartbeatsEnabled = async (api: SettingsApi) =>
  (await api.config.getConfig()).agentHeartbeatsEnabled;
const saveAgentHeartbeatsEnabled = (api: SettingsApi, enabled: boolean) =>
  api.config.updateAgentHeartbeatsEnabled({ enabled });

/**
 * True when a config load may replace the field: no newer load or edit started since `nonce`,
 * and the user has no unsaved value typed since the last load.
 */
function isUneditedLoad(
  nonce: number,
  nonceRef: { current: number },
  editedSinceLoadRef: { current: boolean }
): boolean {
  return nonce === nonceRef.current && !editedSinceLoadRef.current;
}

/**
 * Offline (the field was disabled while focused) a blur does not save: drop the edit mark, so the
 * reload after the reconnect shows the saved value again instead of an unsaved one.
 */
function forgetOfflineEdit(offline: boolean, editedSinceLoadRef: { current: boolean }): void {
  if (offline) editedSinceLoadRef.current = false;
}

/**
 * After a save that the lost connection cut off, drop the edit mark (unless the user typed again
 * since `nonce`). The reload after the reconnect then shows the saved value again: an unsaved
 * value kept on screen would look saved.
 */
function forgetLostEdit(
  error: unknown,
  nonce: number,
  nonceRef: { current: number },
  editedSinceLoadRef: { current: boolean }
): void {
  if (isConnectionLostError(error) && nonce === nonceRef.current) {
    editedSinceLoadRef.current = false;
  }
}

export function HeartbeatSection() {
  const { api } = useAPI();
  // Offline the fields are disabled: a save could not reach the server.
  const liveApi = useLiveAPI();
  const offline = liveApi == null;
  const [heartbeatDefaultPrompt, setHeartbeatDefaultPrompt] = useState("");
  const [heartbeatDefaultPromptLoaded, setHeartbeatDefaultPromptLoaded] = useState(false);
  const [heartbeatDefaultPromptLoadedOk, setHeartbeatDefaultPromptLoadedOk] = useState(false);
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState(
    formatIntervalMinutes(HEARTBEAT_DEFAULT_INTERVAL_MS)
  );
  const [heartbeatDefaultIntervalLoaded, setHeartbeatDefaultIntervalLoaded] = useState(false);
  const [heartbeatDefaultIntervalLoadedOk, setHeartbeatDefaultIntervalLoadedOk] = useState(false);
  const heartbeatDefaultPromptLoadNonceRef = useRef(0);
  const heartbeatDefaultIntervalLoadNonceRef = useRef(0);
  const heartbeatDefaultPromptUpdateChainRef = useRef<Promise<void>>(Promise.resolve());
  const heartbeatDefaultIntervalUpdateChainRef = useRef<Promise<void>>(Promise.resolve());
  const heartbeatDefaultPromptEditedSinceLoadRef = useRef(false);
  const heartbeatDefaultIntervalEditedSinceLoadRef = useRef(false);

  useEffect(() => {
    const configPromise = api?.config?.getConfig();
    if (!configPromise) {
      return;
    }

    // A new client (reconnect) reloads behind the shown values: the fields stay enabled (no
    // `Loaded` reset), and a value the user typed since the last load stays (no edit-mark reset).
    // Until the reload confirms the shown values, a blur without an edit must not save them.
    setHeartbeatDefaultPromptLoadedOk(false);
    setHeartbeatDefaultIntervalLoadedOk(false);
    const heartbeatDefaultPromptNonce = ++heartbeatDefaultPromptLoadNonceRef.current;
    const heartbeatDefaultIntervalNonce = ++heartbeatDefaultIntervalLoadNonceRef.current;

    void configPromise
      .then((cfg) => {
        if (
          isUneditedLoad(
            heartbeatDefaultPromptNonce,
            heartbeatDefaultPromptLoadNonceRef,
            heartbeatDefaultPromptEditedSinceLoadRef
          )
        ) {
          setHeartbeatDefaultPrompt(cfg.heartbeatDefaultPrompt ?? "");
          setHeartbeatDefaultPromptLoaded(true);
          setHeartbeatDefaultPromptLoadedOk(true);
          heartbeatDefaultPromptEditedSinceLoadRef.current = false;
        }

        if (
          isUneditedLoad(
            heartbeatDefaultIntervalNonce,
            heartbeatDefaultIntervalLoadNonceRef,
            heartbeatDefaultIntervalEditedSinceLoadRef
          )
        ) {
          setDraftIntervalMinutes(formatIntervalMinutes(cfg.heartbeatDefaultIntervalMs));
          setHeartbeatDefaultIntervalLoaded(true);
          setHeartbeatDefaultIntervalLoadedOk(true);
          heartbeatDefaultIntervalEditedSinceLoadRef.current = false;
        }
      })
      .catch(() => {
        if (heartbeatDefaultPromptNonce === heartbeatDefaultPromptLoadNonceRef.current) {
          // Keep the field editable after load failures, but avoid clearing an existing saved
          // prompt unless the user has actively typed a replacement in this session.
          setHeartbeatDefaultPromptLoaded(true);
        }

        if (heartbeatDefaultIntervalNonce === heartbeatDefaultIntervalLoadNonceRef.current) {
          // Keep the field editable after load failures, but avoid overwriting a saved default
          // interval unless the user has actively typed a replacement in this session.
          setHeartbeatDefaultIntervalLoaded(true);
        }
      });
  }, [api]);

  const handleHeartbeatDefaultPromptBlur = useCallback(() => {
    if (!heartbeatDefaultPromptLoaded || !liveApi?.config?.updateHeartbeatDefaultPrompt) {
      forgetOfflineEdit(offline, heartbeatDefaultPromptEditedSinceLoadRef);
      return;
    }

    const trimmedDefaultPrompt = heartbeatDefaultPrompt.trim();
    if (!heartbeatDefaultPromptLoadedOk && !heartbeatDefaultPromptEditedSinceLoadRef.current) {
      return;
    }
    const nonce = heartbeatDefaultPromptLoadNonceRef.current;

    setHeartbeatDefaultPrompt(trimmedDefaultPrompt);

    heartbeatDefaultPromptUpdateChainRef.current = heartbeatDefaultPromptUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() =>
        liveApi.config.updateHeartbeatDefaultPrompt({
          defaultPrompt: trimmedDefaultPrompt || null,
        })
      )
      .then(() => {
        setHeartbeatDefaultPromptLoadedOk(true);
        heartbeatDefaultPromptEditedSinceLoadRef.current = false;
      })
      .catch((error: unknown) => {
        // Best-effort persistence.
        forgetLostEdit(
          error,
          nonce,
          heartbeatDefaultPromptLoadNonceRef,
          heartbeatDefaultPromptEditedSinceLoadRef
        );
      });
  }, [
    liveApi,
    offline,
    heartbeatDefaultPrompt,
    heartbeatDefaultPromptLoaded,
    heartbeatDefaultPromptLoadedOk,
  ]);

  const handleHeartbeatDefaultIntervalBlur = useCallback(() => {
    if (!heartbeatDefaultIntervalLoaded || !liveApi?.config?.updateHeartbeatDefaultIntervalMs) {
      forgetOfflineEdit(offline, heartbeatDefaultIntervalEditedSinceLoadRef);
      return;
    }

    if (!heartbeatDefaultIntervalLoadedOk && !heartbeatDefaultIntervalEditedSinceLoadRef.current) {
      return;
    }
    const nonce = heartbeatDefaultIntervalLoadNonceRef.current;
    const onSaveError = (error: unknown) =>
      forgetLostEdit(
        error,
        nonce,
        heartbeatDefaultIntervalLoadNonceRef,
        heartbeatDefaultIntervalEditedSinceLoadRef
      );

    const parsedMinutes = parseIntervalMinutes(draftIntervalMinutes);

    // Empty or invalid input: clear the global override so the hardcoded default applies.
    if (parsedMinutes == null) {
      setDraftIntervalMinutes("");

      heartbeatDefaultIntervalUpdateChainRef.current =
        heartbeatDefaultIntervalUpdateChainRef.current
          .catch(() => {
            /* Best-effort. */
          })
          .then(() => liveApi.config.updateHeartbeatDefaultIntervalMs({ intervalMs: null }))
          .then(() => {
            setHeartbeatDefaultIntervalLoadedOk(true);
            heartbeatDefaultIntervalEditedSinceLoadRef.current = false;
          })
          // Best-effort.
          .catch(onSaveError);
      return;
    }

    const clampedMinutes = clampIntervalMinutes(parsedMinutes);
    const clampedMinutesValue = String(clampedMinutes);
    if (clampedMinutesValue !== draftIntervalMinutes) {
      setDraftIntervalMinutes(clampedMinutesValue);
    }

    heartbeatDefaultIntervalUpdateChainRef.current = heartbeatDefaultIntervalUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() =>
        liveApi.config.updateHeartbeatDefaultIntervalMs({
          intervalMs: intervalMinutesToMs(clampedMinutes),
        })
      )
      .then(() => {
        setHeartbeatDefaultIntervalLoadedOk(true);
        heartbeatDefaultIntervalEditedSinceLoadRef.current = false;
      })
      // Best-effort persistence.
      .catch(onSaveError);
  }, [
    liveApi,
    offline,
    draftIntervalMinutes,
    heartbeatDefaultIntervalLoaded,
    heartbeatDefaultIntervalLoadedOk,
  ]);

  return (
    <div className="flex flex-col gap-6">
      <ConfigSwitchSetting
        title="Let agents set up their own heartbeats"
        description="Give agents a heartbeat tool to schedule recurring follow-ups. Each heartbeat runs a billed agent turn."
        help={
          <>
            When on, an agent can turn on, change, or turn off its workspace&apos;s heartbeat
            without asking you. Each heartbeat starts a new agent turn while the workspace is idle,
            so model usage and cost keep accruing until the heartbeat is turned off. Sub-agents
            never get this tool.
          </>
        }
        ariaLabel="Let agents set up their own heartbeats"
        placeholderChecked={false}
        load={loadAgentHeartbeatsEnabled}
        save={saveAgentHeartbeatsEnabled}
        saveErrorMessage="Failed to update agent heartbeats"
      />

      <div>
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="heartbeat-default-threshold" className="min-w-0 flex-1">
            <div className="text-foreground text-sm font-medium">Default interval</div>
            <div className="text-muted mt-0.5 text-xs">
              Minutes between heartbeats for workspaces without their own interval. Range:{" "}
              {HEARTBEAT_MIN_INTERVAL_MINUTES}–{HEARTBEAT_MAX_INTERVAL_MINUTES}.
            </div>
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="heartbeat-default-threshold"
              type="number"
              inputMode="numeric"
              min={HEARTBEAT_MIN_INTERVAL_MINUTES}
              max={HEARTBEAT_MAX_INTERVAL_MINUTES}
              step={1}
              value={draftIntervalMinutes}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                heartbeatDefaultIntervalLoadNonceRef.current++;
                heartbeatDefaultIntervalEditedSinceLoadRef.current = true;
                setHeartbeatDefaultIntervalLoaded(true);
                setDraftIntervalMinutes(event.target.value);
              }}
              onBlur={handleHeartbeatDefaultIntervalBlur}
              disabled={offline}
              className="border-border-medium bg-background-secondary h-9 w-24 text-right"
              aria-label="Default heartbeat threshold in minutes"
            />
            <span className="text-muted text-sm">min</span>
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="heartbeat-default-prompt" className="block">
          <div className="text-foreground text-sm font-medium">Default prompt</div>
          <div className="text-muted mt-0.5 text-xs">
            Used for workspace heartbeats when a workspace does not set its own message.
          </div>
        </label>
        <textarea
          id="heartbeat-default-prompt"
          rows={4}
          value={heartbeatDefaultPrompt}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
            heartbeatDefaultPromptLoadNonceRef.current++;
            heartbeatDefaultPromptEditedSinceLoadRef.current = true;
            setHeartbeatDefaultPromptLoaded(true);
            setHeartbeatDefaultPrompt(event.target.value);
          }}
          onBlur={handleHeartbeatDefaultPromptBlur}
          disabled={offline}
          className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent mt-3 min-h-[120px] w-full resize-y rounded-md border p-3 text-sm leading-relaxed focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={HEARTBEAT_DEFAULT_MESSAGE_BODY}
          aria-label="Default heartbeat prompt"
        />
      </div>
    </div>
  );
}
