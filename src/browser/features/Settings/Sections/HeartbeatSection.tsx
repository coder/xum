import React, { useCallback, useEffect, useRef, useState } from "react";

import { Input } from "@/browser/components/Input/Input";
import { useAPI } from "@/browser/contexts/API";
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

export function HeartbeatSection() {
  const { api } = useAPI();
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

    setHeartbeatDefaultPromptLoaded(false);
    setHeartbeatDefaultPromptLoadedOk(false);
    setHeartbeatDefaultIntervalLoaded(false);
    setHeartbeatDefaultIntervalLoadedOk(false);
    heartbeatDefaultPromptEditedSinceLoadRef.current = false;
    heartbeatDefaultIntervalEditedSinceLoadRef.current = false;

    const heartbeatDefaultPromptNonce = ++heartbeatDefaultPromptLoadNonceRef.current;
    const heartbeatDefaultIntervalNonce = ++heartbeatDefaultIntervalLoadNonceRef.current;

    void configPromise
      .then((cfg) => {
        if (heartbeatDefaultPromptNonce === heartbeatDefaultPromptLoadNonceRef.current) {
          setHeartbeatDefaultPrompt(cfg.heartbeatDefaultPrompt ?? "");
          setHeartbeatDefaultPromptLoaded(true);
          setHeartbeatDefaultPromptLoadedOk(true);
          heartbeatDefaultPromptEditedSinceLoadRef.current = false;
        }

        if (heartbeatDefaultIntervalNonce === heartbeatDefaultIntervalLoadNonceRef.current) {
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
    if (!heartbeatDefaultPromptLoaded || !api?.config?.updateHeartbeatDefaultPrompt) {
      return;
    }

    const trimmedDefaultPrompt = heartbeatDefaultPrompt.trim();
    if (!heartbeatDefaultPromptLoadedOk && !heartbeatDefaultPromptEditedSinceLoadRef.current) {
      return;
    }

    setHeartbeatDefaultPrompt(trimmedDefaultPrompt);

    heartbeatDefaultPromptUpdateChainRef.current = heartbeatDefaultPromptUpdateChainRef.current
      .catch(() => {
        // Best-effort only.
      })
      .then(() =>
        api.config.updateHeartbeatDefaultPrompt({
          defaultPrompt: trimmedDefaultPrompt || null,
        })
      )
      .then(() => {
        setHeartbeatDefaultPromptLoadedOk(true);
        heartbeatDefaultPromptEditedSinceLoadRef.current = false;
      })
      .catch(() => {
        // Best-effort persistence.
      });
  }, [api, heartbeatDefaultPrompt, heartbeatDefaultPromptLoaded, heartbeatDefaultPromptLoadedOk]);

  const handleHeartbeatDefaultIntervalBlur = useCallback(() => {
    if (!heartbeatDefaultIntervalLoaded || !api?.config?.updateHeartbeatDefaultIntervalMs) {
      return;
    }

    if (!heartbeatDefaultIntervalLoadedOk && !heartbeatDefaultIntervalEditedSinceLoadRef.current) {
      return;
    }

    const parsedMinutes = parseIntervalMinutes(draftIntervalMinutes);

    // Empty or invalid input: clear the global override so the hardcoded default applies.
    if (parsedMinutes == null) {
      setDraftIntervalMinutes("");

      heartbeatDefaultIntervalUpdateChainRef.current =
        heartbeatDefaultIntervalUpdateChainRef.current
          .catch(() => {
            /* Best-effort. */
          })
          .then(() => api.config.updateHeartbeatDefaultIntervalMs({ intervalMs: null }))
          .then(() => {
            setHeartbeatDefaultIntervalLoadedOk(true);
            heartbeatDefaultIntervalEditedSinceLoadRef.current = false;
          })
          .catch(() => {
            /* Best-effort. */
          });
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
        api.config.updateHeartbeatDefaultIntervalMs({
          intervalMs: intervalMinutesToMs(clampedMinutes),
        })
      )
      .then(() => {
        setHeartbeatDefaultIntervalLoadedOk(true);
        heartbeatDefaultIntervalEditedSinceLoadRef.current = false;
      })
      .catch(() => {
        // Best-effort persistence.
      });
  }, [api, draftIntervalMinutes, heartbeatDefaultIntervalLoaded, heartbeatDefaultIntervalLoadedOk]);

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
            <div className="text-foreground text-sm font-medium">Default threshold</div>
            <div className="text-muted mt-0.5 text-xs">
              Default heartbeat cadence in minutes for new workspaces.
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
          className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent mt-3 min-h-[120px] w-full resize-y rounded-md border p-3 text-sm leading-relaxed focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={HEARTBEAT_DEFAULT_MESSAGE_BODY}
          aria-label="Default heartbeat prompt"
        />
      </div>
    </div>
  );
}
