import React, { useRef } from "react";
import { Paperclip } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";

interface AttachFileButtonProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export const AttachFileButton: React.FC<AttachFileButtonProps> = (props) => {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleClick() {
    // Reset so re-selecting the same file still triggers onChange
    if (inputRef.current) {
      inputRef.current.value = "";
    }
    inputRef.current?.click();
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      props.onFiles(files);
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            disabled={props.disabled ?? false}
            aria-label="Attach file"
            className={cn(
              "inline-flex items-center justify-center rounded p-0.5 transition-colors duration-150",
              "focus-visible:ring-accent focus-visible:ring-1",
              "disabled:cursor-not-allowed disabled:opacity-40",
              "text-muted/50 hover:text-muted"
            )}
          >
            <Paperclip className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <strong>Attach any file</strong>. Images and PDFs attach directly. Other files are saved
          to the workspace.
        </TooltipContent>
      </Tooltip>
      {/* Kept outside Tooltip to avoid stray DOM children. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleChange}
        tabIndex={-1}
      />
    </>
  );
};
