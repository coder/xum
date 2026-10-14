import React from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/common/lib/utils";

const DOCS_BASE_URL = "https://mux.coder.com";

interface DocsLinkProps {
  /** Path relative to docs root (e.g., "/runtime/local") */
  path: string;
  /** Link text (defaults to "docs") */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A styled link to mux documentation.
 * Renders as a small badge with an external link icon.
 */
export function DocsLink({ path, children = "docs", className }: DocsLinkProps) {
  return (
    <a
      href={`${DOCS_BASE_URL}${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "text-muted hover:text-accent-text inline-flex items-center gap-1 text-[10px] transition-colors",
        className
      )}
    >
      {children}
      <ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}
