import React, { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  WarningBox,
  WarningTitle,
  WarningText,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  description?: string;
  /** Items listed under the description, e.g. the files a removal would delete. */
  details?: { label: string; items: string[] };
  /** Warning message shown in red warning box */
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive" | "secondary" | "outline" | "ghost" | "link";
  /** Called when user confirms. Can be async - buttons will be disabled during execution. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Reusable confirmation modal for destructive actions
 */
export const ConfirmationModal: React.FC<ConfirmationModalProps> = (props) => {
  const [isConfirming, setIsConfirming] = useState(false);

  // Extract callbacks to satisfy exhaustive-deps rule
  const onConfirm = props.onConfirm;
  const onCancel = props.onCancel;

  const handleConfirm = useCallback(async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    try {
      await onConfirm();
    } finally {
      setIsConfirming(false);
    }
  }, [isConfirming, onConfirm]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isConfirming) {
        onCancel();
      }
    },
    [isConfirming, onCancel]
  );

  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEditableElement(e.target)) return;

      // Block all global shortcuts while dialog is active.
      // Radix handles Escape in capture phase (via onEscapeKeyDown) before this fires.
      stopKeyboardPropagation(e);

      if (isConfirming) return;

      if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_YES)) {
        e.preventDefault();
        void handleConfirm();
      } else if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_NO)) {
        e.preventDefault();
        onCancel();
      }
    },
    [isConfirming, handleConfirm, onCancel]
  );

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent maxWidth="450px" showCloseButton={false} onKeyDown={handleDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>

        {props.details && props.details.items.length > 0 && (
          <section aria-label={props.details.label} className="min-w-0 space-y-2 text-sm">
            <p>{props.details.label}:</p>
            <ul className="text-muted max-h-48 space-y-1 overflow-y-auto font-mono text-xs">
              {props.details.items.map((item) => (
                <li key={item} className="break-all">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}

        {props.warning && (
          <WarningBox>
            <WarningTitle>Warning</WarningTitle>
            <WarningText>{props.warning}</WarningText>
          </WarningBox>
        )}

        <DialogFooter className="justify-center">
          <Button variant="secondary" onClick={onCancel} disabled={isConfirming}>
            {props.cancelLabel ?? "Cancel"}
            <span
              aria-hidden="true"
              className="ml-2 inline-flex items-center rounded border border-current/25 px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-60"
            >
              N
            </span>
          </Button>
          <Button
            variant={props.confirmVariant ?? "destructive"}
            onClick={() => void handleConfirm()}
            disabled={isConfirming}
          >
            {isConfirming ? "Processing..." : (props.confirmLabel ?? "Confirm")}
            <span
              aria-hidden="true"
              className="ml-2 inline-flex items-center rounded border border-current/25 px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-60"
            >
              Y
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
