import { useEffect, useState } from "react";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { createArtifactAssetLoader, toImageDataUrl } from "./artifactAssets";
import { findRelativeMarkdownImages, mapMarkdownImageUrls } from "./markdownImages";
import { Notice } from "./SourceText";
import { useArtifactAssetReader } from "./useArtifactAssetReader";

/**
 * Markdown artifact. Relative image links resolve against the artifact's folder and are read
 * through the artifacts API (base64 -> data: URL); remote images keep MarkdownRenderer's usual
 * handling. Images that cannot be read are left as written.
 */
export function MarkdownArtifact(props: { content: string; path: string; workspaceId: string }) {
  const read = useArtifactAssetReader(props.workspaceId);
  const relativeImages = findRelativeMarkdownImages(props.content);
  const hasRelativeImages = relativeImages.length > 0;
  const [resolved, setResolved] = useState<{ source: string; rendered: string } | null>(null);

  useEffect(() => {
    if (!hasRelativeImages || read == null) return;
    let cancelled = false;
    const loader = createArtifactAssetLoader(props.path, read);
    const refs = findRelativeMarkdownImages(props.content);
    Promise.all(
      refs.map((ref) =>
        loader.load(ref).then((asset) => {
          const dataUrl = asset.status === "ok" ? toImageDataUrl(asset.result) : null;
          return [ref, dataUrl] as const;
        })
      )
    )
      .then((pairs) => {
        if (cancelled) return;
        const urls = new Map(pairs.filter((pair): pair is [string, string] => pair[1] != null));
        setResolved({
          source: props.content,
          rendered: mapMarkdownImageUrls(props.content, (url) => urls.get(url) ?? null),
        });
      })
      .catch(() => {
        if (!cancelled) setResolved({ source: props.content, rendered: props.content });
      });
    return () => {
      cancelled = true;
    };
  }, [hasRelativeImages, props.content, props.path, read]);

  let content = props.content;
  if (hasRelativeImages && read != null) {
    if (resolved?.source !== props.content) return <Notice>Loading…</Notice>;
    content = resolved.rendered;
  }
  return (
    <div className="p-3 text-sm">
      <MarkdownRenderer content={content} />
    </div>
  );
}
