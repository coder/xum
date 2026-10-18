import { cn } from "@/common/lib/utils";
import { PROJECT_ICONS } from "@/browser/utils/ui/projectIcons";
import {
  isProjectIconName,
  PROJECT_ICON_NAMES,
  type ProjectIconName,
} from "@/common/constants/projectIcons";

const TILE_CLASSES = "flex h-[22px] w-[22px] items-center justify-center rounded-md";

function tileStateClasses(isSelected: boolean): string {
  return isSelected ? "bg-hover text-foreground" : "text-muted hover:bg-hover hover:text-foreground";
}

/** The project menu's icon panel: the initial plus every pickable lucide icon. */
export function ProjectIconPicker(props: {
  /** Stored icon name; a missing or unknown name selects the initial tile. */
  icon: string | undefined;
  monogram: string;
  onSelect: (icon: ProjectIconName | null) => void;
}) {
  const selectedIcon = isProjectIconName(props.icon) ? props.icon : null;
  return (
    <div className="bg-background border-border mx-1 my-1 rounded border p-2">
      <div
        role="group"
        aria-label="Project icon"
        className="flex max-h-48 flex-wrap gap-0.5 overflow-y-auto"
      >
        <button
          type="button"
          aria-label="Use project initial"
          aria-pressed={selectedIcon === null}
          className={cn(
            TILE_CLASSES,
            "text-[11px] leading-none font-bold",
            tileStateClasses(selectedIcon === null)
          )}
          onClick={() => props.onSelect(null)}
        >
          {props.monogram}
        </button>
        {PROJECT_ICON_NAMES.map((name) => {
          const { Icon, label } = PROJECT_ICONS[name];
          return (
            <button
              key={name}
              type="button"
              aria-label={`Set project icon to ${label}`}
              aria-pressed={selectedIcon === name}
              className={cn(TILE_CLASSES, tileStateClasses(selectedIcon === name))}
              onClick={() => props.onSelect(name)}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
