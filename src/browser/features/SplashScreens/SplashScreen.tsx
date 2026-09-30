import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";

interface SplashScreenProps {
  title: string;
  children: React.ReactNode;
  onDismiss: () => void;
  primaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  /** Defaults to true (primary action dismisses the splash). */
  dismissOnPrimaryAction?: boolean;
  /** Defaults to "Got it". Set to null to hide the dismiss button entirely. */
  dismissLabel?: string | null;
  /** Optional custom footer content (replaces primary + dismiss buttons). */
  footer?: React.ReactNode;
  /** Optional class name for the DialogFooter container. */
  footerClassName?: string;
}

export function SplashScreen(props: SplashScreenProps) {
  const handlePrimaryAction = () => {
    if (!props.primaryAction) {
      return;
    }

    props.primaryAction.onClick();

    if (props.dismissOnPrimaryAction !== false) {
      props.onDismiss();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onDismiss()}>
      {/* aria-describedby={undefined}: splash bodies are rich content, not a short description. */}
      {/* Cap height and scroll the body (footer pinned) so tall steps keep Next/Skip clickable. */}
      <DialogContent
        maxWidth="500px"
        aria-describedby={undefined}
        className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">{props.children}</div>
        <DialogFooter className={props.footerClassName}>
          {props.footer ?? (
            <>
              {props.primaryAction && (
                <Button
                  onClick={handlePrimaryAction}
                  disabled={props.primaryAction.disabled === true}
                >
                  {props.primaryAction.label}
                </Button>
              )}
              {props.dismissLabel !== null && (
                <Button variant="secondary" onClick={props.onDismiss}>
                  {props.dismissLabel ?? "Got it"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
