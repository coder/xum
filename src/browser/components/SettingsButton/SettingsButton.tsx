import { Settings } from "lucide-react";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";

interface SettingsButtonProps {
  onBeforeOpenSettings?: () => void;
}

export function SettingsButton(props: SettingsButtonProps) {
  const { open } = useSettings();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            props.onBeforeOpenSettings?.();
            open();
          }}
          className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"
          aria-label="Open settings"
          data-testid="settings-button"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{`Open settings (${formatKeybind(KEYBINDS.OPEN_SETTINGS)})`}</TooltipContent>
    </Tooltip>
  );
}
