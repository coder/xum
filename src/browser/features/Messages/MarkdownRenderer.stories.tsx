import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { UserMessageContent } from "./UserMessageContent";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Messages/MarkdownRenderer",
  component: MarkdownRenderer,
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;

type Story = StoryObj<typeof meta>;

function AssistantMarkdownCanvas(props: { content: string }) {
  return (
    <div className="bg-background flex min-h-screen justify-center p-6">
      <div className="w-full max-w-3xl overflow-x-hidden">
        <MarkdownRenderer content={props.content} />
      </div>
    </div>
  );
}

function UserMarkdownCanvas(props: { content: string }) {
  return (
    <div className="bg-background flex min-h-screen justify-center p-6">
      <div className="w-full max-w-3xl overflow-x-hidden px-4 py-3">
        <UserMessageContent content={props.content} variant="sent" />
      </div>
    </div>
  );
}

const TABLE_CONTENT = `Here are markdown table examples:

## Simple table

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value A  | Value B  | Value C  |
| Value D  | Value E  | Value F  |

## Alignment table

| Left | Center | Right |
|:-----|:------:|------:|
| L    | C      | R     |
| Text | Text   | Text  |

## Code in table cells

| Feature | Status | Notes |
|---------|--------|-------|
| \`markdown\` | ✅ Done | Full GFM |
| **Bold** | ✅ Done | Works |`;

const CODE_BLOCK_CONTENT = `Single-line block:

\`\`\`bash
npm install mux
\`\`\`

Multi-line block:

\`\`\`typescript
import { verifyToken } from "../auth/jwt";

export async function getUser(req: Request, res: Response) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.json({ ok: true });
}
\`\`\``;

const BLOCKQUOTE_CONTENT = `Simple quote:

> This is a simple blockquote.

Quote with inline formatting:

> **Important:** Inline \`code\`, **bold**, and *italic* should render correctly.

Nested quote:

> Outer quote
>
> > Inner quote
>
> Outer quote again.`;

const LONG_LINE_CONTENT = `Long lines should stay inside the message container.

\`\`\`
const reallyLongVariableName = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive, argumentSix, argumentSeven, argumentEight, argumentNine, argumentTen);
\`\`\`

This is a very long paragraph without manual line breaks that should wrap within the message content area instead of forcing horizontal overflow in the surrounding layout.`;

/** Markdown tables */
export const Tables: Story = {
  render: () => <AssistantMarkdownCanvas content={TABLE_CONTENT} />,
};

/** Code blocks with both single-line and multi-line examples */
export const CodeBlocks: Story = {
  render: () => <AssistantMarkdownCanvas content={CODE_BLOCK_CONTENT} />,
};

/** Blockquotes with nested and inline-formatted content */
export const Blockquotes: Story = {
  render: () => <AssistantMarkdownCanvas content={BLOCKQUOTE_CONTENT} />,
};

/** Long-line rendering in user message markdown content */
export const LongLines: Story = {
  render: () => <UserMarkdownCanvas content={LONG_LINE_CONTENT} />,
};

const WIDE_FLOWCHART_CONTENT = `\`\`\`mermaid
flowchart LR
A[Request]-->B[Parse]-->C[Plan]-->D[Build]-->E[Test]-->F[Ship]
\`\`\``;

// Mirror Pixel's named viewports so each story's globals pin the width that CI snapshots.
const MERMAID_VIEWPORTS = {
  options: {
    phone390: { name: "Phone 390", styles: { width: "390px", height: "844px" }, type: "mobile" },
    laptop1200: {
      name: "Laptop 1200",
      styles: { width: "1200px", height: "900px" },
      type: "desktop",
    },
  },
};

// The column has a fixed width because the test runner plays every story at desktop width.
function MermaidColumn(props: { width: number }) {
  return (
    <div className="bg-background min-h-screen p-4">
      <div style={{ width: props.width }}>
        <MarkdownRenderer content={WIDE_FLOWCHART_CONTENT} />
      </div>
    </div>
  );
}

/** Waits until the diagram has rendered at the column's width with the expected shape. */
async function waitForDiagram(canvasElement: HTMLElement, shape: "tall" | "wide") {
  return waitFor(
    () => {
      const svg = canvasElement.querySelector<SVGSVGElement>(".mermaid-container > svg.pele");
      if (!svg) throw new Error("The diagram has not rendered yet");
      const box = svg.getBoundingClientRect();
      const isTall = box.height > box.width;
      if (isTall !== (shape === "tall")) {
        throw new Error(`Expected a ${shape} diagram, got ${box.width}x${box.height}`);
      }
      return svg;
    },
    { timeout: 10_000 }
  );
}

/** Below 640 px a left-to-right flowchart turns top-to-bottom and drops the height cap. */
export const MermaidPhone: Story = {
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: { matrix: { viewports: ["phone"] } } },
  render: () => <MermaidColumn width={358} />,
  play: async ({ canvasElement, parameters, globals }) => {
    // The pinned Pixel variant and the local viewport must stay paired, or this story
    // snapshots the wide layout.
    await expect(parameters).toMatchObject({ pixel: { matrix: { viewports: ["phone"] } } });
    await expect(globals).toMatchObject({ viewport: { value: "phone390" } });

    const svg = await waitForDiagram(canvasElement, "tall");
    const container = svg.parentElement!;
    await expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 2);
    await expect(getComputedStyle(svg).maxHeight).toBe("none");
  },
};

/** At 640 px and wider the same flowchart keeps its left-to-right layout. */
export const MermaidLaptop: Story = {
  globals: { viewport: { value: "laptop1200", isRotated: false } },
  parameters: { viewport: MERMAID_VIEWPORTS, pixel: { matrix: { viewports: ["laptop"] } } },
  render: () => <MermaidColumn width={768} />,
  play: async ({ canvasElement }) => {
    await waitForDiagram(canvasElement, "wide");
  },
};
