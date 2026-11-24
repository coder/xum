import React, { useCallback, useEffect, useState } from "react";
import { Input } from "@/browser/components/Input/Input";
import { useAPI, useLiveAPI } from "@/browser/contexts/API";
import { SettingRow, SettingsGroup } from "../Components/SettingsLayout";

/** Parent folder for new projects and clones (moved from General to Runtimes). */
export function DefaultProjectDirSetting() {
  const { api } = useAPI();
  const offline = useLiveAPI() == null;
  const [defaultProjectDir, setDefaultProjectDir] = useState("");
  const [cloneDirLoaded, setCloneDirLoaded] = useState(false);
  // Track whether the initial load succeeded to prevent saving empty string
  // (which would clear the config) when the initial fetch failed.
  const [cloneDirLoadedOk, setCloneDirLoadedOk] = useState(false);

  useEffect(() => {
    if (!api) {
      return;
    }

    void api.projects
      .getDefaultProjectDir()
      .then((dir) => {
        setDefaultProjectDir(dir);
        setCloneDirLoaded(true);
        setCloneDirLoadedOk(true);
      })
      .catch(() => {
        // Best-effort only. Keep the input editable if load fails,
        // but don't mark as successfully loaded to prevent clearing config on blur.
        setCloneDirLoaded(true);
      });
  }, [api]);

  const handleCloneDirBlur = useCallback(() => {
    // Only persist once the initial load has completed (success or failure).
    // After a failed load, allow saves only if the user has actively typed
    // a non-empty value, so we never silently clear a configured directory.
    if (!cloneDirLoaded || !api) {
      return;
    }

    const trimmedProjectDir = defaultProjectDir.trim();
    if (!cloneDirLoadedOk && !trimmedProjectDir) {
      return;
    }

    void api.projects
      .setDefaultProjectDir({ path: defaultProjectDir })
      .then(() => {
        // A successful save means subsequent clears are safe, even if the
        // initial getDefaultProjectDir() request failed earlier in this session.
        setCloneDirLoadedOk(true);
      })
      .catch(() => {
        // Best-effort save: keep current UI state on failure.
      });
  }, [api, cloneDirLoaded, cloneDirLoadedOk, defaultProjectDir]);

  return (
    <SettingsGroup title="Projects">
      <SettingRow id="default-project-dir">
        <Input
          value={defaultProjectDir}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setDefaultProjectDir(e.target.value)
          }
          onBlur={handleCloneDirBlur}
          placeholder="~/.xum/projects"
          disabled={!cloneDirLoaded || offline}
          aria-label="Default project directory"
          className="border-border-medium bg-surface-primary h-9 w-80 max-w-full"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
