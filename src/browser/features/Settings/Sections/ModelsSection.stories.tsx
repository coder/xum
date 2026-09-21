/**
 * NOTE: ModelsSection contains an in-app CTA ("Go to Agent defaults") that calls
 * openSettings("tasks"). In isolated section stories the CTA navigates to the
 * agents section via settings context, but the visual section swap is only
 * exercised in the SettingsPage smoke story.
 */
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY } from "@/common/constants/storage";
import type { ProviderModelEntry } from "@/common/orpc/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import { ModelsSection } from "./ModelsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ModelsSection",
  component: ModelsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ModelsEmpty: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
          },
        })
      }
    >
      <ModelsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        if (canvas.queryAllByText(/Built-in Models/i).length === 0) {
          throw new Error("Expected Built-in Models to render");
        }
      },
      { timeout: 5000 }
    );
  },
};

export const ModelsConfigured: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() => {
        window.localStorage.setItem(
          "provider_options_anthropic",
          JSON.stringify({ use1MContextModels: ["anthropic:claude-sonnet-4-20250514"] })
        );

        return setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-8"],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
            xai: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: false,
              baseUrl: "",
              models: ["grok-beta"],
            },
          },
        });
      }}
    >
      <ModelsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        if (canvas.queryAllByText(/claude-sonnet-4-20250514/i).length === 0) {
          throw new Error("Expected claude-sonnet-4-20250514 to render");
        }
      },
      { timeout: 5000 }
    );

    await waitFor(
      () => {
        if (canvas.queryAllByText(/^gpt-4o$/i).length === 0) {
          throw new Error("Expected gpt-4o to render");
        }
      },
      { timeout: 5000 }
    );

    // No provider here has a discovered catalog, so the add row stays free-text only.
    await expect(canvas.queryByRole("button", { name: /Discovered models/ })).toBeNull();
  },
};

// The Coder catalog never adds rows by itself: unconfigured catalog entries
// are offered in the add row's "Discovered models…" dropdown, and picking one
// persists through providers.setModels exactly like the free-text Add button.
const CODER_DISCOVERED_MODELS = ["anthropic/claude-x", "anthropic/claude-y", "openai/gpt-z"];
const coderSetModelsCalls: Array<{ provider: string; models: ProviderModelEntry[] }> = [];

function setupCoderCatalogStory() {
  const client = setupSettingsStory({
    providersConfig: {
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        baseUrl: "",
        models: [],
      },
      coder: {
        apiKeySet: false,
        coderOauthSet: true,
        isEnabled: true,
        isConfigured: true,
        models: ["anthropic/claude-x"],
        discoveredModels: CODER_DISCOVERED_MODELS,
      },
    },
    providersList: ["anthropic", "coder"],
  });
  // The add row targets the persisted provider; seed Coder after the story
  // reset so the catalog dropdown renders without clicking through the Select.
  updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "coder");
  coderSetModelsCalls.length = 0;
  client.providers.setModels = (input) => {
    coderSetModelsCalls.push(input);
    return Promise.resolve({ success: true, data: undefined });
  };
  return client;
}

async function pickDiscoveredModel(canvasElement: HTMLElement, label: RegExp): Promise<void> {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: /Discovered models/ }));
  // Radix portals the popover list to document.body.
  const dialog = await within(document.body).findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: label }));
  await waitFor(() => {
    if (within(document.body).queryByRole("dialog") !== null) {
      throw new Error("Expected the dropdown to close after picking a model");
    }
  });
}

export const CoderCatalogDiscovered: Story = {
  render: () => (
    <SettingsSectionStory setup={setupCoderCatalogStory}>
      <ModelsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Only the explicitly configured entry is a row; the catalog adds none.
    await canvas.findByText("anthropic/claude-x");
    await expect(canvas.queryByText(/claude-y/)).toBeNull();
    await expect(canvas.queryByText(/gpt-z/)).toBeNull();

    // The dropdown offers the catalog minus configured IDs.
    await userEvent.click(canvas.getByRole("button", { name: /Discovered models/ }));
    const dialog = await within(document.body).findByRole("dialog");
    const options = within(dialog).getAllByRole("button");
    await expect(options).toHaveLength(2);
    await expect(within(dialog).queryByRole("button", { name: /claude-x/ })).toBeNull();
    await expect(within(dialog).getByRole("button", { name: /claude-y/ })).toBeVisible();
    await expect(within(dialog).getByRole("button", { name: /gpt-z/ })).toBeVisible();

    // Picking an entry adds it immediately and persists the full list.
    await userEvent.click(within(dialog).getByRole("button", { name: /claude-y/ }));
    await canvas.findByText("anthropic/claude-y");
    await expect(coderSetModelsCalls).toEqual([
      { provider: "coder", models: ["anthropic/claude-x", "anthropic/claude-y"] },
    ]);

    // The remaining entry keeps the dropdown; configuring it too hides the dropdown.
    await pickDiscoveredModel(canvasElement, /gpt-z/);
    await canvas.findByText("openai/gpt-z");
    await expect(coderSetModelsCalls).toHaveLength(2);
    await expect(coderSetModelsCalls[1]).toEqual({
      provider: "coder",
      models: ["anthropic/claude-x", "anthropic/claude-y", "openai/gpt-z"],
    });
    await waitFor(() => {
      if (canvas.queryByRole("button", { name: /Discovered models/ }) !== null) {
        throw new Error("Expected the dropdown to disappear once the catalog is fully configured");
      }
    });
  },
};

export const CoderCatalogDiscoveredPhone: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    docs: {
      description: {
        story:
          "Pins the phone-width contract for the add row: the provider select and discovered-models dropdown share the first line and the free-text input wraps below without right-edge overflow.",
      },
    },
  },
  // The test-runner ignores viewport globals; the wrapper enforces the width there too.
  render: () => (
    <div style={{ width: 390, maxWidth: "100%" }}>
      <SettingsSectionStory setup={setupCoderCatalogStory}>
        <ModelsSection />
      </SettingsSectionStory>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("anthropic/claude-x");

    const trigger = canvas.getByRole("button", { name: /Discovered models/ });
    const input = canvas.getByPlaceholderText("model-id");
    // The add row is the wrapping flex container two levels above the trigger
    // (trigger → min-width wrapper → row).
    const row = trigger.parentElement?.parentElement;
    if (!row?.contains(input)) {
      throw new Error("Expected the dropdown and the model-id input to share the add row");
    }
    await expect(row.getBoundingClientRect().width).toBeLessThanOrEqual(390);
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    // Wrapped: the free-text input starts below the dropdown instead of overflowing.
    await expect(input.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      trigger.getBoundingClientRect().bottom
    );
  },
};
