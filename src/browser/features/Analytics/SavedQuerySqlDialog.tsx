import { AlertTriangle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { TIME_FILTER_PLACEHOLDER } from "./sqlTimeFilter";

interface SavedQuerySqlDialogProps {
  open: boolean;
  label: string;
  sql: string;
  saving: boolean;
  saveDisabled: boolean;
  error: string | null;
  onSqlChange: (nextSql: string) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
}

export function SavedQuerySqlDialog(props: SavedQuerySqlDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent maxWidth="900px" maxHeight="80vh" showCloseButton={!props.saving}>
        <DialogHeader>
          <DialogTitle>{`Edit SQL — ${props.label}`}</DialogTitle>
          <DialogDescription>
            Saving updates this panel and reruns it with the edited query. Use{" "}
            <code className="text-foreground">{TIME_FILTER_PLACEHOLDER}</code> in a WHERE clause to
            filter by the dashboard&apos;s selected date range.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Saved query SQL"
            value={props.sql}
            onChange={(event) => props.onSqlChange(event.target.value)}
            spellCheck={false}
            autoFocus
            className="border-border-medium bg-background text-foreground focus:border-accent focus:ring-accent min-h-[220px] w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed focus:ring-1 focus:outline-none"
            placeholder="SELECT * FROM events LIMIT 10;"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (!props.saveDisabled) {
                  props.onSave();
                }
              }
            }}
          />
          <div className="text-muted text-[10px]">Ctrl/Cmd+Enter to save</div>
        </div>

        {props.error && (
          <div className="border-danger-soft bg-danger-soft/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="flex-1 font-mono whitespace-pre-wrap">{props.error}</div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => props.onOpenChange(false)}
            disabled={props.saving}
          >
            Cancel
          </Button>
          <Button onClick={props.onSave} disabled={props.saveDisabled}>
            {props.saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
