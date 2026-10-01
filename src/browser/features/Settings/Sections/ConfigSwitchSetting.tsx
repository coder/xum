import React, { useEffect, useRef, useState } from "react";

import { Switch } from "@/browser/components/Switch/Switch";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/browser/components/Tooltip/Tooltip";
import { useAPI } from "@/browser/contexts/API";

export type SettingsApi = NonNullable<ReturnType<typeof useAPI>["api"]>;

interface ConfigSwitchSettingProps {
  title: string;
  description: React.ReactNode;
  /** Optional help tooltip next to the title. */
  help?: React.ReactNode;
  ariaLabel: string;
  /** Shown (disabled) until the saved value loads. */
  placeholderChecked: boolean;
  load: (api: SettingsApi) => Promise<boolean>;
  save: (api: SettingsApi, enabled: boolean) => Promise<void>;
  saveErrorMessage: string;
}

/** A switch backed by one boolean in the backend config. */
export function ConfigSwitchSetting(props: ConfigSwitchSettingProps) {
  const { api } = useAPI();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Serialize writes so rapid toggles persist the last choice, and roll back only when the
  // latest selection fails, to the last value the backend accepted.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestChangeRef = useRef(0);
  const savedRef = useRef(props.placeholderChecked);
  const load = props.load;

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    load(api)
      .then((value) => {
        if (cancelled) return;
        savedRef.current = value;
        setEnabled(value);
      })
      .catch(() => {
        // Keep the switch disabled; the next settings visit retries the read.
      });
    return () => {
      cancelled = true;
    };
  }, [api, load]);

  const handleChange = (next: boolean) => {
    if (!api) return;
    const change = ++latestChangeRef.current;
    setEnabled(next);
    setError(null);
    writeChainRef.current = writeChainRef.current.then(async () => {
      try {
        await props.save(api, next);
        savedRef.current = next;
      } catch (err) {
        if (change !== latestChangeRef.current) return;
        setEnabled(savedRef.current);
        setError(err instanceof Error ? err.message : props.saveErrorMessage);
      }
    });
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="text-foreground text-sm font-medium">{props.title}</h3>
          {props.help != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpIndicator aria-label={`${props.title} help`}>?</HelpIndicator>
              </TooltipTrigger>
              <TooltipContent>
                <div className="max-w-[280px]">{props.help}</div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="text-content-secondary mt-1 text-xs">{props.description}</p>
        {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
      </div>
      <Switch
        checked={enabled ?? props.placeholderChecked}
        disabled={enabled === null}
        onCheckedChange={handleChange}
        aria-label={props.ariaLabel}
      />
    </div>
  );
}
