import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import {
  validateStaticTree,
  type StaticElement,
  type StaticNode,
} from "@/common/staticWorkspaceView/tree";
import { markdownMayContainMath } from "./MarkdownCore";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { UserMessageContent } from "./UserMessageContent";

type ParsedNode = DefaultTreeAdapterMap["childNode"];

function toStaticNode(node: ParsedNode): StaticNode | null {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (!("tagName" in node)) return null; // a comment or doctype is not ours
  const attributes = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]));
  const element: StaticElement = [node.tagName, attributes];
  for (const child of node.childNodes) {
    const converted = toStaticNode(child);
    if (converted === null) return null;
    element.push(converted);
  }
  return element;
}

/**
 * The static view tree of one row: the live row content (UserMessageContent for user rows,
 * TypewriterMarkdown as AssistantMessage renders it) rendered on the server, or null when the row is outside
 * the static subset. Rendering the live components keeps the first paint equal to the live view by
 * construction; a hand-written markdown subset kept drifting from it (#6833).
 * Rows with math get null: KaTeX loads later and replaces the code block, and its lazy chunk
 * imports CSS, which the server cannot load.
 */
export function renderRowTree(markdown: string, isUser: boolean): StaticNode | null {
  if (markdownMayContainMath(markdown)) return null;
  const html = renderToStaticMarkup(
    <ThemeProvider forcedTheme="dark">
      {isUser ? (
        <UserMessageContent content={markdown} variant="sent" />
      ) : (
        <TypewriterMarkdown content={markdown} isComplete streamKey="static" />
      )}
    </ThemeProvider>
  );
  const nodes = parseFragment(html).childNodes;
  if (nodes.length !== 1) return null;
  const tree = toStaticNode(nodes[0]);
  return tree === null ? null : validateStaticTree(tree);
}
