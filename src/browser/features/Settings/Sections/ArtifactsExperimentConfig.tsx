import { Switch } from "@/browser/components/Switch/Switch";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY } from "@/common/constants/storage";

/** Per-user settings for the Artifacts experiment, shown under its row in Experiments. */
export function ArtifactsExperimentConfig() {
  // Same key and default as SandboxedArtifactFrame, which listens for changes.
  const [allowCdn, setAllowCdn] = usePersistedState<boolean>(
    ARTIFACTS_ALLOW_CDN_SCRIPTS_KEY,
    true,
    {
      listener: true,
    }
  );
  return (
    <div className="bg-background-secondary flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex-1">
        <div className="text-foreground text-sm">Allow CDN scripts in artifacts</div>
        <div className="text-muted text-xs">
          HTML and SVG artifacts run in a sandbox whose content policy blocks network requests,
          except scripts from a few public CDNs (cdnjs, unpkg, jsDelivr, jQuery, Tailwind) and
          Google Fonts. This is not a full network block: a hostile artifact could still leak data,
          for example through WebRTC or the paths of those CDN requests. Turn this off to block
          every CDN.
        </div>
      </div>
      <Switch
        checked={allowCdn}
        onCheckedChange={setAllowCdn}
        aria-label="Toggle CDN scripts in artifacts"
      />
    </div>
  );
}
