import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { UpdateStatus } from "@/common/orpc/types";
import { APIProvider } from "@/browser/contexts/API";
import { AboutDialogProvider, useAboutDialog } from "@/browser/contexts/AboutDialogContext";
import { Button } from "@/browser/components/Button/Button";
import { lightweightMeta, PIXEL_DISABLED } from "@/browser/stories/meta";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { AboutDialog } from "./AboutDialog";

function OpenAbout() {
  const about = useAboutDialog();
  return (
    <>
      <Button onClick={about.open}>Open About</Button>
      <AboutDialog />
    </>
  );
}

function ServerUpdateStory(props: { status: UpdateStatus }) {
  const [client] = useState(() =>
    createMockORPCClient({
      updateStatus: props.status,
      updateChannel: "nightly",
      updateChannels: ["stable", "nightly", "npm"],
    })
  );
  return (
    <APIProvider client={client}>
      <AboutDialogProvider>
        <OpenAbout />
      </AboutDialogProvider>
    </APIProvider>
  );
}

const meta = {
  ...lightweightMeta,
  title: "Features/About/Server updates",
  component: ServerUpdateStory,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Open About" }));
  },
} satisfies Meta<typeof ServerUpdateStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unsupported: Story = {
  args: {
    status: {
      type: "unsupported",
      reason: "Server updates require a supervisor configured to restart after exit",
    },
  },
  play: async (context) => {
    await meta.play(context);
    const dialog = await within(document.body).findByRole("dialog");
    await expect(
      within(dialog).queryByRole("button", { name: "Install & restart" })
    ).not.toBeInTheDocument();
    await expect(
      within(dialog).queryByRole("button", { name: "Check for Updates" })
    ).not.toBeInTheDocument();
  },
};

export const Downloading: Story = {
  args: { status: { type: "downloading", percent: null } },
  play: async (context) => {
    await meta.play(context);
    const dialog = await within(document.body).findByRole("dialog");
    await expect(within(dialog).getByRole("button", { name: "Check for Updates" })).toBeDisabled();
  },
};

export const RestartingClosesDialog: Story = {
  args: { status: { type: "restarting", info: { version: "0.29.0" } } },
  play: async (context) => {
    await meta.play(context);
    // The dialog hands the screen to the restart cover as soon as the restarting status lands,
    // releasing its focus trap; the mock emits that status on subscribe, right after opening.
    await waitFor(() =>
      expect(within(document.body).queryByRole("dialog")).not.toBeInTheDocument()
    );
  },
};

export const BlockedPhone: Story = {
  args: {
    status: {
      type: "install-blocked",
      info: { version: "0.28.4-next.123.g123456789" },
      blockers: [
        { kind: "pending-turns", count: 2 },
        { kind: "terminals", count: 1 },
        // #4770: held inputs name their workspaces (an archived one shows them only when opened).
        {
          kind: "held-inputs",
          count: 4,
          // Beyond three names the line collapses into a count, keeping the dialog bounded. The
          // backend cuts long names (nameRestartBlockerWorkspaces), as in the first entry.
          workspaceNames: [
            "Archived: migrate the storage layer to…",
            "Fix settings validation",
            "Rename the CLI flags",
            "Update docs",
          ],
        },
      ],
    },
  },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async (context) => {
    await meta.play(context);
    const dialog = await within(document.body).findByRole("dialog");
    const retry = within(dialog).getByRole("button", { name: "Install & restart" });
    await expect(retry).toBeEnabled();
    await expect(within(dialog).getByRole("button", { name: "Restart anyway" })).toBeEnabled();
    await expect(within(dialog).getByRole("status")).toBeVisible();
    await expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Sessions with unsent messages: 4 (Archived: migrate the storage layer to…, Fix settings validation, Rename the CLI flags and 1 more)"
    );
    const npm = within(dialog).getByRole("radio", { name: "Newest npm" });
    await userEvent.click(npm);
    await expect(npm).toHaveAttribute("aria-checked", "true");
    if (window.innerWidth <= 440) {
      await expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
      await expect(npm.getBoundingClientRect().right).toBeLessThanOrEqual(
        dialog.getBoundingClientRect().right
      );
      await expect(retry.getBoundingClientRect().right).toBeLessThanOrEqual(
        dialog.getBoundingClientRect().right
      );
    }
  },
};

/**
 * #5052: two long titles that the backend cut to the same text keep their disambiguating ID
 * (nameRestartBlockerWorkspaces cuts before appending it). Visual evidence only: Pixel is off
 * because the snapshot budget is at its cap, and BlockedPhone already covers this layout.
 */
export const BlockedDuplicateNames: Story = {
  args: {
    status: {
      type: "install-blocked",
      info: { version: "0.28.4-next.123.g123456789" },
      blockers: [
        {
          kind: "held-inputs",
          count: 2,
          workspaceNames: [
            "Migrate the storage layer to the new sc… (a1b2c3d4e5)",
            "Migrate the storage layer to the new sc… (f6a7b8c9d0)",
          ],
        },
      ],
    },
  },
  parameters: { pixel: PIXEL_DISABLED },
};
