import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { suggestSshHosts } from "./sshHostMatches";

/**
 * Hosts from `~/.ssh/config` under the SSH host field: the hosts a user has already named are
 * the ones they are most likely to run on, and typing an alias from memory is error-prone.
 * Picking one fills the field. Nothing is shown when the config names no (matching) host.
 */
export function SshHostSuggestions(props: {
  typed: string;
  disabled: boolean;
  onPick: (host: string) => void;
}) {
  const { api } = useAPI();
  const [configHosts, setConfigHosts] = useState<string[]>([]);

  // Read once per mount: the field mounts when SSH is picked, and the config rarely changes.
  useEffect(() => {
    if (!api) return;
    let active = true;
    api.projects.listSshConfigHosts().then(
      (result) => {
        if (active) setConfigHosts(result.hosts);
      },
      // Suggestions are a convenience: without them the field still takes any host.
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [api]);

  const suggestions = suggestSshHosts(configHosts, props.typed);
  if (suggestions.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Hosts from ~/.ssh/config"
      className="border-border-light flex flex-col rounded-md border p-[3px]"
    >
      <span className="text-muted-light px-[7px] pt-1 pb-0.5 font-mono text-[10px] font-medium tracking-[0.06em] uppercase">
        From ~/.ssh/config
      </span>
      {suggestions.map((host) => (
        <button
          key={host}
          type="button"
          disabled={props.disabled}
          onClick={() => props.onPick(host)}
          className="hover:bg-hover focus-visible:bg-hover text-foreground truncate rounded px-[7px] py-[5px] text-left font-mono text-xs outline-none disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
        >
          {host}
        </button>
      ))}
    </div>
  );
}
