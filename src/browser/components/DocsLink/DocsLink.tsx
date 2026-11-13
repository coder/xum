import React from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/common/lib/utils";

const DOCS_BASE_URL = "https://mux.coder.com";

interface DocsLinkProps extends Omit<
  React.ComponentPropsWithoutRef<"a">,
  "href" | "target" | "rel"
> {
  /** Path relative to docs root (e.g., "/runtime/local") */
  path: string;
  /** Link text (defaults to "docs") */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A styled link to mux documentation.
 * Renders as a small badge with an external link icon. Other anchor props and the ref pass
 * through, so it can be a tooltip's trigger.
 */
export const DocsLink = React.forwardRef<HTMLAnchorElement, DocsLinkProps>(
  function DocsLink(props, ref) {
    const { path, children = "docs", className, ...anchorProps } = props;
    return (
      <a
        {...anchorProps}
        ref={ref}
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
);
