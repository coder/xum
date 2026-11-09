import type { ComponentType } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { appMeta, AppWithMocks, PIXEL_DISABLED, type AppStory } from "./meta";
import { createMockORPCClient } from "./mocks/orpc";
import { createAssistantMessage, createUserMessage } from "./mocks/messages";
import { createWorkspace, groupWorkspacesByProject } from "./mocks/workspaces";
import { collapseLeftSidebar, collapseRightSidebar, selectWorkspace } from "./helpers/uiState";

export default { ...appMeta, title: "App/ChatSearch" };

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
      emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory });
    },
  });
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

  // Leave a matching result open for the desktop and phone snapshots.
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
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } } },
  play: async (context) => {
    await searchChat(context);
    const search = within(context.canvasElement).getByRole("search", { name: "Chat search" });
    await expect(search.getBoundingClientRect().width).toBeLessThanOrEqual(390);
  },
};
