import React, { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { getErrorMessage } from "@/common/utils/errors";

interface StartHereModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Rejects (never silently resolves) when the operation was refused, so the dialog stays open. */
  onConfirm: () => void | Promise<void>;
  /**
   * Confirmation is not currently possible (the transcript stopped being a verified copy of
   * history while the dialog was open): OK renders disabled and the confirm keybind is inert.
   */
  confirmDisabled?: boolean;
}

export const StartHereModal: React.FC<StartHereModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  confirmDisabled = false,
}) => {
  const [isExecuting, setIsExecuting] = useState(false);
  // Why the last confirmation was refused; shown until the next attempt or cancel.
  const [error, setError] = useState<string | undefined>(undefined);

  const handleCancel = useCallback(() => {
    if (!isExecuting) {
      setError(undefined);
      onClose();
    }
  }, [isExecuting, onClose]);

  const handleConfirm = useCallback(async () => {
    if (isExecuting || confirmDisabled) return;
    setIsExecuting(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (confirmError) {
      setError(getErrorMessage(confirmError));
    } finally {
      setIsExecuting(false);
    }
  }, [isExecuting, confirmDisabled, onConfirm, onClose]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isExecuting) {
        handleCancel();
      }
    },
    [isExecuting, handleCancel]
  );

  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isEditableElement(e.target)) return;

      // Block all global shortcuts while dialog is active.
      // Radix handles Escape in capture phase (via onEscapeKeyDown) before this fires.
      stopKeyboardPropagation(e);

      if (isExecuting) return;

      if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_YES)) {
        e.preventDefault();
        void handleConfirm();
      } else if (matchesKeybind(e, KEYBINDS.CONFIRM_DIALOG_NO)) {
        e.preventDefault();
        handleCancel();
      }
    },
    [isExecuting, handleConfirm, handleCancel]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} onKeyDown={handleDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>Start Here</DialogTitle>
          <DialogDescription>
            This will start a new context from this message and preserve earlier chat history.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="bg-error-bg text-error rounded p-2 px-3 text-[13px]">
            {error}
          </div>
        )}
        <DialogFooter className="justify-center">
          <Button variant="secondary" onClick={handleCancel} disabled={isExecuting}>
            Cancel
            <span
              aria-hidden="true"
              className="ml-2 inline-flex items-center rounded border border-current/25 px-1.5 py-0.5 font-mono text-[10px] leading-none opacity-60"
            >
              N
            </span>
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={isExecuting || confirmDisabled}>
            {isExecuting ? "Starting..." : "OK"}
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
