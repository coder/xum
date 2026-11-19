import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type { ApiServerStatus } from "@/common/orpc/types";
import { ServerAccessSection } from "./ServerAccessSection.js";
import {
  MOCK_SERVER_AUTH_SESSIONS,
  SettingsSectionStory,
  setupSettingsStory,
} from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ServerAccessSection",
  component: ServerAccessSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

/** The server listens on a LAN and a Tailscale address next to its loopback base URL. */
const PAIRED_SERVER_STATUS: ApiServerStatus = {
  running: true,
  baseUrl: "http://127.0.0.1:8462",
  bindHost: "0.0.0.0",
  port: 8462,
  networkBaseUrls: ["http://192.168.1.42:8462", "http://devbox.tail4e2c.ts.net:8462"],
  tailscaleBindHosts: [{ interfaceName: "utun3", address: "100.64.0.2", family: "IPv4" }],
  token: "xum-pair-demo-token-9f3ab2c1d4e5f607",
  configuredBindHost: "0.0.0.0",
  configuredPort: 8462,
  configuredServeWebUi: true,
};

const LOOPBACK_ONLY_SERVER_STATUS: ApiServerStatus = {
  running: true,
  baseUrl: "http://127.0.0.1:8462",
  bindHost: "127.0.0.1",
  port: 8462,
  networkBaseUrls: [],
  tailscaleBindHosts: [],
  token: "xum-pair-demo-token-9f3ab2c1d4e5f607",
  configuredBindHost: null,
  configuredPort: null,
  configuredServeWebUi: false,
};

export const ServerAccess: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          serverAuthSessions: MOCK_SERVER_AUTH_SESSIONS,
        })
      }
    >
      <ServerAccessSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Server access sessions/i);
    await canvas.findByText(/Safari on iPhone \(Current\)/i);
    await canvas.findByText(/Chrome on Mac/i);
    await canvas.findByText(/Firefox on Android/i);
    await canvas.findByRole("button", { name: /^Refresh$/i });
    await canvas.findByRole("button", { name: /Revoke other sessions/i });
  },
};

export const PairDevice: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          serverAuthSessions: MOCK_SERVER_AUTH_SESSIONS,
          apiServerStatus: PAIRED_SERVER_STATUS,
        })
      }
    >
      <ServerAccessSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Pair device/i);
    // The default address is the LAN one, not the loopback base URL.
    await canvas.findByText(/192\.168\.1\.42/);
    // The token stays hidden until the user reveals the pairing code.
    await canvas.findByText(/token=\u2022\u2022\u2022\u2022/i);
    await userEvent.click(canvas.getByRole("button", { name: /Show pairing code/i }));
    await canvas.findByRole("img", { name: /Pairing QR code/i });
    await canvas.findByText(/token=xum-pair-demo-token/i);
  },
};

export const PairDeviceLoopbackOnly: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          serverAuthSessions: MOCK_SERVER_AUTH_SESSIONS,
          apiServerStatus: LOOPBACK_ONLY_SERVER_STATUS,
        })
      }
    >
      <ServerAccessSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/Pair device/i);
    await canvas.findByText(/only listens on localhost/i);
    await canvas.findByText(/Expose API server on LAN\/VPN/i);
  },
};
