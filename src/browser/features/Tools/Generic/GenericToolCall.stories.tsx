import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { APIProvider } from "@/browser/contexts/API";
import { GenericToolCall } from "@/browser/features/Tools/GenericToolCall";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Generic",
  component: GenericToolCall,
} satisfies Meta<typeof GenericToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Generic tool call with JSON-highlighted arguments and results */
export const GenericTool: Story = {
  args: {
    toolName: "fetch_data",
    args: {
      endpoint: "/api/users",
      params: { limit: 100, offset: 0 },
    },
    result: {
      success: true,
      // Generate 100+ line result to test line number alignment
      data: Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        name: `User ${i + 1}`,
        email: `user${i + 1}@example.com`,
        active: i % 3 !== 0,
      })),
      total: 500,
      page: 1,
    },
    status: "completed",
  },
  parameters: {
    docs: {
      description: {
        story: "Generic tool call with JSON syntax highlighting and 100+ lines.",
      },
    },
  },
};

// MCP Apps (artifacts experiment): an expanded call with a ui:// view shows the view inline.
// The view is opaque-origin, so the play test reads progress from the height it reports
// (184px once tool-result arrived).
const DICE_VIEW_HTML = `<!doctype html>
<html>
<head>
<style>
  body { font: 13px system-ui, sans-serif; margin: 0; padding: 12px; color: #e6e6e6; background: #1e1e1e; }
  .dice { display: flex; gap: 6px; margin-top: 8px; }
  .die { width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid #444; border-radius: 6px; font-weight: 600; }
</style>
</head>
<body>
  <strong id="title">Dice board</strong>
  <div class="dice" id="dice"></div>
  <script>
    const send = (message) => window.parent.postMessage(message, "*");
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.id === 1 && message.result) {
        send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      } else if (message.method === "ui/notifications/tool-result") {
        const data = message.params.structuredContent;
        document.getElementById("title").textContent = data.count + "d" + data.sides + " = " + data.total;
        document.getElementById("dice").replaceChildren(...data.rolls.map((n) => {
          const die = document.createElement("div");
          die.className = "die";
          die.textContent = String(n);
          return die;
        }));
        send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 184 } });
      } else if (message.method === "ui/resource-teardown") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {
      protocolVersion: "2026-01-26", appInfo: { name: "dice", version: "1.0.0" }, appCapabilities: {},
    } });
  </script>
</body>
</html>`;

const DICE_RESULT = {
  content: [{ type: "text", text: "Rolled 4d6: 4, 6, 4, 1 (total 15)." }],
  structuredContent: { count: 4, sides: 6, rolls: [4, 6, 4, 1], total: 15 },
};

function renderMcpAppCall() {
  getAppConfigStore().setClient(
    createMockORPCClient({ experiments: { [EXPERIMENT_IDS.ARTIFACTS]: true } })
  );
  return (
    <APIProvider
      client={createMockORPCClient({
        mcpApps: {
          views: {
            "call-dice-1": {
              html: DICE_VIEW_HTML,
              csp: {},
              prefersBorder: true,
              resultAvailable: true,
              result: DICE_RESULT,
              invocation: null,
            },
          },
        },
      })}
    >
      <GenericToolCall
        toolName="demo_app_show_dice_board"
        args={{ count: 4, sides: 6, label: "4d6 roll" }}
        result={DICE_RESULT}
        status="completed"
        workspaceId="ws-generic-mcp-app"
        toolCallId="call-dice-1"
        mcpServer={{
          connection: { key: "demo-app", transport: "stdio" },
          identity: { name: "mcp-app-prototype", version: "0.1.0" },
          source: "connection",
          app: { resourceUri: "ui://prototype/board.html" },
        }}
      />
    </APIProvider>
  );
}

const playMcpAppCall = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText("demo_app_show_dice_board"));
  const frame = await canvas.findByTestId("mcp-app-frame");
  await waitFor(() => expect(frame.style.height).toBe("184px"), { timeout: 5000 });
  await expect(canvas.queryByText("Arguments")).toBeNull();
  await userEvent.click(canvas.getByRole("button", { name: "Show input/output" }));
  await canvas.findByText("Arguments");
  // The JSON opens below the view without reloading it.
  await expect(canvas.getByTestId("mcp-app-frame")).toBe(frame);
};

/** Expanded MCP Apps call: the view inline, the raw JSON behind a toggle. */
export const McpAppInline: Story = {
  args: { toolName: "demo_app_show_dice_board" },
  parameters: { pixel: PIXEL_DISABLED },
  render: () => renderMcpAppCall(),
  play: ({ canvasElement }) => playMcpAppCall(canvasElement),
};

/**
 * Phone width. The test runner plays at desktop size and ignores `globals.viewport`, so the
 * story pins the width itself (AGENTS.md, Storybook responsive validation).
 */
export const McpAppInlinePhone: Story = {
  args: { toolName: "demo_app_show_dice_board" },
  globals: { viewport: { value: "phone390", isRotated: false } },
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <div data-testid="phone-width" style={{ width: 358 }}>
      {renderMcpAppCall()}
    </div>
  ),
  play: async ({ canvasElement }) => {
    await playMcpAppCall(canvasElement);
    // The header action stays inside the card instead of pushing past its right edge.
    const canvas = within(canvasElement);
    const card = canvas.getByTestId("phone-width").getBoundingClientRect();
    const action = canvas
      .getByRole("button", { name: "Open in Artifacts" })
      .getBoundingClientRect();
    await expect(action.right).toBeLessThanOrEqual(card.right);
  },
};
