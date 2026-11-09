import type { ComponentType } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta";
import { createMockORPCClient } from "./mocks/orpc";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";
import { collapseLeftSidebar, collapseRightSidebar, selectWorkspace } from "./helpers/uiState";

// The existing transcript phone scene covers search snapshots. Keep these behavior stories play-only.
export default {
  ...appMeta,
  title: "App/ChatSearch",
  parameters: { ...appMeta.parameters, pixel: PIXEL_DISABLED },
};

const workspace = createWorkspace({
  id: "ws-chat-search",
  name: "chat-search",
  projectName: "mux",
});

const phoneWorkspace = createWorkspace({
  id: "ws-chat-search-phone",
  name: "chat-search-phone",
  projectName: "mux",
});

function setup(selectedWorkspace = workspace, hasOlderHistory = false) {
  const workspace = selectedWorkspace;
  selectWorkspace(workspace);
  collapseLeftSidebar();
  collapseRightSidebar();
  return createMockORPCClient({
    projects: groupWorkspacesByProject([workspace]),
    workspaces: [workspace],
    onChat: (_workspaceId, emit) => {
      for (let index = 0; index < 100; index++) {
        const text =
          index === 1
            ? "The original [needle] reply."
            : index === 99
              ? "The latest [NEEDLE] reply."
              : `Conversation message ${index}.`;
        const createMessage = index % 2 === 0 ? createUserMessage : createAssistantMessage;
        emit(createMessage(`search-${index}`, text, { historySequence: index + 1 }));
      }
      const multipart = createAssistantMessage("search-multipart", "An unrelated opening.", {
        historySequence: 101,
      });
      multipart.parts.push(
        { type: "reasoning", text: "An intermediate step." },
        { type: "text", text: "The multipart search marker appears in this row." }
      );
      emit(multipart);
      emit(
        createUserMessage("search-plan", "The plan preview search marker.", {
          historySequence: 102,
          synthetic: true,
          muxMetadata: { type: "plan-display", path: "/tmp/plan.md" },
        })
      );
      emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory });
    },
  });
}

async function verifySearchComposition(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const input = canvas.getByRole("searchbox", { name: "Search chat" });
  const status = canvas.getByRole("status", { name: "Matching messages" });
  const selectedResult = status.textContent;
  for (const key of ["Enter", "Escape"]) {
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...composition,
      });
      input.dispatchEvent(event);
      await expect(event.defaultPrevented).toBe(false);
      await expect(canvas.getByRole("searchbox", { name: "Search chat" })).toBe(input);
      await expect(status.textContent).toBe(selectedResult);
    }
  }
}

const searchChat: AppStory["play"] = async ({ canvasElement, step }) => {
  const canvas = within(canvasElement);
  const transcript = await waitFor(
    async () => {
      const element = canvasElement.querySelector<HTMLElement>(
        '[data-testid="message-window"][data-loaded="true"]'
      );
      await expect(element).not.toBeNull();
      return element!;
    },
    { timeout: 15_000 }
  );
  const row = (id: string) => transcript.querySelector<HTMLElement>(`[data-message-id="${id}"]`);

  await step("Find reveals a reply outside the displayed history limit", async () => {
    await expect(row("search-1")).toBeNull();
    transcript.focus();
    await userEvent.keyboard("{Control>}f{/Control}");
    const input = await canvas.findByRole("searchbox", { name: "Search chat" });
    await expect(input).toHaveFocus();
    await userEvent.type(input, "needle");
    await waitFor(() =>
      expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent("1 / 2")
    );
    await waitFor(() => expect(row("search-1")).toHaveClass("timeline-reveal-highlight"));
    await expect(row("search-1")).toHaveTextContent("The original [needle] reply.");
  });

  await step("Enter, Shift+Enter, and buttons navigate and wrap matching messages", async () => {
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent("2 / 2")
    );
    await waitFor(() => expect(row("search-99")).toHaveClass("timeline-reveal-highlight"));
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent(
      "1 / 2"
    );
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent(
      "2 / 2"
    );
    await userEvent.click(canvas.getByRole("button", { name: "Previous matching message" }));
    await expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent(
      "1 / 2"
    );
  });

  await step("IME Enter and Escape keep the search selection and input", async () => {
    await verifySearchComposition(canvasElement);
  });

  await step("Find selects the query, and missing queries disable navigation", async () => {
    await userEvent.keyboard("{Control>}f{/Control}");
    const input = canvas.getByRole("searchbox", { name: "Search chat" });
    await expect(input).toHaveFocus();
    await userEvent.keyboard("absent-search-term");
    await expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent(
      "0 / 0"
    );
    await expect(canvas.getByRole("button", { name: "Next matching message" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Previous matching message" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("searchbox", { name: "Search chat" })).toBeNull();
    await expect(transcript).toHaveFocus();
  });

  await step("Find also opens from chat footer controls", async () => {
    const footer = canvas.getByTestId("workspace-footer-bar");
    const control = Array.from(footer.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getClientRects().length > 0 && !button.disabled
    );
    await expect(control).toBeDefined();
    control!.focus();
    await userEvent.keyboard("{Control>}f{/Control}");
    await expect(await canvas.findByRole("searchbox", { name: "Search chat" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(control!).toHaveFocus();
  });

  await step("Search reveals the matching reply part and visible plan preview", async () => {
    await userEvent.keyboard("{Control>}f{/Control}");
    const input = await canvas.findByRole("searchbox", { name: "Search chat" });
    await userEvent.type(input, "multipart search marker");
    await waitFor(() =>
      expect(
        transcript.querySelector('[data-displayed-message-id="search-multipart-2"]')
      ).toHaveClass("timeline-reveal-highlight")
    );
    await expect(
      transcript.querySelector('[data-displayed-message-id="search-multipart-0"]')
    ).not.toHaveClass("timeline-reveal-highlight");
    await userEvent.keyboard("{Control>}f{/Control}");
    await userEvent.keyboard("plan preview search marker");
    await waitFor(() => expect(row("search-plan")).toHaveClass("timeline-reveal-highlight"));
    await userEvent.keyboard("{Escape}");
  });

  // Leave a matching result open for visual checks.
  await userEvent.keyboard("{Control>}f{/Control}");
  await userEvent.type(await canvas.findByRole("searchbox", { name: "Search chat" }), "needle");
  await waitFor(() => expect(row("search-1")).toHaveClass("timeline-reveal-highlight"));
  const search = canvas.getByRole("search", { name: "Chat search" });
  await expect(search.scrollWidth).toBeLessThanOrEqual(search.clientWidth);
};

export const SearchChat: AppStory = {
  render: () => <AppWithMocks setup={setup} />,
  play: searchChat,
};

function setupOlderHistory() {
  const olderWorkspace = createWorkspace({
    id: "ws-search-older",
    name: "search-older",
    projectName: "mux",
  });
  const client = setup(olderWorkspace, true);
  let failNextLoad = true;
  client.workspace.history = {
    ...client.workspace.history,
    loadMore: () => {
      if (failNextLoad) {
        failNextLoad = false;
        return Promise.reject(new Error("History load failed"));
      }
      return Promise.resolve({
        messages: [
          createAssistantMessage("older-match", "An archived reply before the current page.", {
            historySequence: 0,
          }),
        ],
        nextCursor: null,
        hasOlder: false,
      });
    },
  };
  return client;
}

export const SearchOlderHistory: AppStory = {
  parameters: { pixel: PIXEL_DISABLED },
  render: () => <AppWithMocks setup={setupOlderHistory} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("The latest [NEEDLE] reply.", {}, { timeout: 15_000 });
    const transcript = canvasElement.querySelector<HTMLElement>('[data-testid="message-window"]')!;
    transcript.focus();
    await userEvent.keyboard("{Control>}f{/Control}");
    await userEvent.type(await canvas.findByRole("searchbox", { name: "Search chat" }), "archived");
    await expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent(
      "0 / 0"
    );
    await userEvent.click(canvas.getByRole("button", { name: "Load older messages to search" }));
    await canvas.findByRole("alert");
    await userEvent.click(canvas.getByRole("button", { name: "Load older messages to search" }));
    await waitFor(() =>
      expect(canvas.getByRole("status", { name: "Matching messages" })).toHaveTextContent("1 / 1")
    );
    await waitFor(() =>
      expect(transcript.querySelector('[data-message-id="older-match"]')).toHaveClass(
        "timeline-reveal-highlight"
      )
    );
    await expect(
      canvas.queryByRole("button", { name: "Load older messages to search" })
    ).toBeNull();
  },
};

function Phone(Story: ComponentType) {
  return (
    <div style={{ width: 390, height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}

const setupPhone = () => setup(phoneWorkspace);

export const SearchChatPhone: AppStory = {
  render: () => <AppWithMocks setup={setupPhone} />,
  decorators: [Phone],
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: {
    pixel: { ...PIXEL_DISABLED, matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => {
    await searchChat(context);
    const search = within(context.canvasElement).getByRole("search", { name: "Chat search" });
    await expect(search.getBoundingClientRect().width).toBeLessThanOrEqual(390);
  },
};
