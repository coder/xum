import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { TodoToolCall } from "@/browser/features/Tools/TodoToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { TodoItem } from "@/common/types/tools";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Todo",
  component: TodoToolCall,
} satisfies Meta<typeof TodoToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const LONG_TODOS: TodoItem[] = [
  {
    content:
      "Create British-themed layout (HTML) matching reference: left nav, hero section, decorative flourishes, and a deliberately overlong description to force truncation in narrow layouts",
    status: "pending",
  },
  {
    content:
      "Implement grotesque Great Britain pride styling (Union Jack, red/white/blue palette, overly ornate typography) with enough detail to overflow a single line",
    status: "in_progress",
  },
  {
    content:
      "Add small JS for interactions (active nav, mobile drawer, hover effects, focus states, keyboard shortcuts, and more) — again intentionally verbose",
    status: "pending",
  },
  {
    content:
      "Run a local server and verify layout + responsiveness across breakpoints; include a comically long note about testing on multiple devices and ensuring no horizontal overflow",
    status: "pending",
  },
];

/**
 * Story showing a todo_write tool call with very long todo items.
 * Regression test for todo rows overflowing their container in the chat window.
 */
export const TodoWriteWithLongTodos: Story = {
  args: {
    args: { todos: LONG_TODOS },
    result: { success: true, count: 4 },
    status: "completed",
  },
  render: (args) => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div data-testid="todo-card-container" className="w-full max-w-2xl">
        <TodoToolCall {...args} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    if (!canvas.queryByText(/Create British-themed layout \(HTML\)/)) {
      await waitFor(() => {
        if (canvas.getAllByText("▶").length === 0) {
          throw new Error("Tool expand icon not found");
        }
      });

      await userEvent.click(canvas.getAllByText("▶")[0]);
    }

    const firstTodo = await canvas.findByText(/Create British-themed layout \(HTML\)/);
    if (!firstTodo.classList.contains("truncate")) {
      throw new Error("Expected todo row to have Tailwind 'truncate' class");
    }

    const container = canvasElement.querySelector('[data-testid="todo-card-container"]');
    if (!(container instanceof HTMLElement)) {
      throw new Error("Todo story container not found");
    }

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    if (container.scrollWidth > container.clientWidth) {
      throw new Error("Todo tool card has horizontal overflow");
    }
  },
  parameters: {
    docs: {
      description: {
        story:
          "Regression test for long todo text overflowing its container. " +
          "Todo rows should truncate with ellipsis and the message window should not horizontally scroll.",
      },
    },
  },
};
