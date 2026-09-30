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

    // A provider without a catalog still accepts arbitrary model IDs.
    await userEvent.click(canvas.getByRole("combobox", { name: "Provider" }));
    await userEvent.click(within(document.body).getByRole("option", { name: /Anthropic/ }));
    const input = canvas.getByRole("combobox", { name: "Model ID" });
    await userEvent.click(input);
    await expect(canvas.queryByRole("listbox")).toBeNull();
    await userEvent.type(input, "custom/manual-model");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await canvas.findByText("custom/manual-model");
    await expect(input).toHaveValue("");
  },
};

// The Coder catalog never adds rows by itself: unconfigured catalog entries
// are suggestions in the same field used for manual IDs. Picking one persists
// through providers.setModels exactly like the free-text Add button.
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

export const CoderCatalogDiscovered: Story = {
  render: () => (
    <SettingsSectionStory setup={setupCoderCatalogStory}>
      <ModelsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("anthropic/claude-x");
    await expect(canvas.queryByText(/claude-y/)).toBeNull();
    const input = canvas.getByRole("combobox", { name: "Model ID" });
    await userEvent.click(input);
    const list = await canvas.findByRole("listbox");
    await expect(within(list).getAllByRole("option")).toHaveLength(2);
    await expect(within(list).queryByRole("option", { name: /claude-x/ })).toBeNull();

    // Typing filters suggestions, but Enter must not silently replace a manual ID.
    await userEvent.type(input, "anthropic/claude");
    await expect(within(list).getAllByRole("option")).toHaveLength(1);
    // Switching providers clears a previous keyboard selection.
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.click(canvas.getByRole("combobox", { name: "Provider" }));
    await userEvent.click(within(document.body).getByRole("option", { name: /Anthropic/ }));
    await userEvent.click(input);
    await expect(canvas.queryByRole("listbox")).toBeNull();
    await userEvent.click(canvas.getByRole("combobox", { name: "Provider" }));
    await userEvent.click(within(document.body).getByRole("option", { name: /Coder/ }));
    await userEvent.click(input);
    await userEvent.keyboard("{Enter}");
    await canvas.findByText("anthropic/claude");
    await expect(coderSetModelsCalls.at(-1)?.models).toEqual([
      "anthropic/claude-x",
      "anthropic/claude",
    ]);
    await expect(input).toHaveValue("");

    // Rejected duplicates keep the typed ID and do not persist another entry.
    await userEvent.type(input, "anthropic/claude{Enter}");
    await canvas.findByText(/already exists for this provider/);
    await expect(input).toHaveValue("anthropic/claude");
    await expect(coderSetModelsCalls).toHaveLength(1);
    await userEvent.clear(input);
    await userEvent.click(input);

    // Pointer selection adds immediately via the same persistence path.
    await userEvent.click(canvas.getByRole("option", { name: "anthropic/claude-y" }));
    await canvas.findByText("anthropic/claude-y");
    await expect(coderSetModelsCalls).toHaveLength(2);
    await expect(input).toHaveValue("");

    // Escape keeps the query without adding; explicit arrow navigation selects.
    await userEvent.type(input, "gpt");
    await userEvent.keyboard("{ArrowDown}{Escape}");
    await expect(canvas.queryByRole("listbox")).toBeNull();
    await expect(input).toHaveValue("gpt");
    await expect(coderSetModelsCalls).toHaveLength(2);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await canvas.findByText("openai/gpt-z");
    await expect(coderSetModelsCalls.at(-1)).toEqual({
      provider: "coder",
      models: ["anthropic/claude-x", "anthropic/claude", "anthropic/claude-y", "openai/gpt-z"],
    });
    await userEvent.click(input);
    await expect(canvas.queryByRole("listbox")).toBeNull();
    // The same field remains usable when every discovered entry is configured.
    await userEvent.type(input, "custom/after-catalog{Enter}");
    await canvas.findByText("custom/after-catalog");
  },
};

export const CoderCatalogDiscoveredPhone: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    docs: {
      description: {
        story:
          "Pins the phone-width contract for the add row: the single model field and its suggestions fit without right-edge overflow.",
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

    const input = canvas.getByRole("combobox", { name: "Model ID" });
    const row = input.parentElement?.parentElement;
    if (!row) throw new Error("Expected the model field in the add row");
    await expect(row.getBoundingClientRect().width).toBeLessThanOrEqual(390);
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    await userEvent.click(input);
    const list = await canvas.findByRole("listbox");
    await expect(within(list).getAllByRole("option")).toHaveLength(2);
    await expect(list.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right
    );
    await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  },
};
