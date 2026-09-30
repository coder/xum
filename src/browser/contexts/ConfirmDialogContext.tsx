import React, { createContext, useContext, useRef, useState, useCallback } from "react";
import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";

type ConfirmVariant = "default" | "destructive" | "secondary" | "outline" | "ghost" | "link";

export interface ConfirmDialogOptions {
  title: string;
  description?: string;
  /** Items listed under the description, e.g. the files a removal would delete. */
  details?: { label: string; items: string[] };
  /** Warning message shown in red warning box */
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ConfirmVariant;
}

interface ConfirmDialogContextValue {
  confirm: (opts: ConfirmDialogOptions) => Promise<boolean>;
}

const ConfirmDialogContext = createContext<ConfirmDialogContextValue | null>(null);

export function useConfirmDialog(): ConfirmDialogContextValue {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) {
    throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  }
  return ctx;
}

export function ConfirmDialogProvider(props: { children: React.ReactNode }) {
  const [dialogState, setDialogState] = useState<
    (ConfirmDialogOptions & { isOpen: boolean }) | null
  >(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmDialogOptions): Promise<boolean> => {
    // If a dialog is already open, auto-cancel it (self-healing)
    if (resolverRef.current) {
      resolverRef.current(false);
      resolverRef.current = null;
    }

    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setDialogState({ ...opts, isOpen: true });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    resolverRef.current?.(true);
    resolverRef.current = null;
    setDialogState(null);
  }, []);

  const handleCancel = useCallback(() => {
    resolverRef.current?.(false);
    resolverRef.current = null;
    setDialogState(null);
  }, []);

  return (
    <ConfirmDialogContext.Provider value={{ confirm }}>
      {props.children}
      {dialogState && (
        <ConfirmationModal
          isOpen={dialogState.isOpen}
          title={dialogState.title}
          description={dialogState.description}
          details={dialogState.details}
          warning={dialogState.warning}
          confirmLabel={dialogState.confirmLabel}
          cancelLabel={dialogState.cancelLabel}
          confirmVariant={dialogState.confirmVariant}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmDialogContext.Provider>
  );
}
