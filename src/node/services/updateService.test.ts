import { describe, it, expect, mock } from "bun:test";
import type { Config } from "@/node/config";
import type { UpdateChannel } from "@/common/types/project";
import { UpdateService } from "./updateService";

function createMockConfig(initialChannel: UpdateChannel) {
  const state: { channel: UpdateChannel } = { channel: initialChannel };
  const getUpdateChannel = mock(() => state.channel);
  const setUpdateChannel = mock((channel: UpdateChannel) => {
    state.channel = channel;
    return Promise.resolve();
  });

  return {
    config: {
      getUpdateChannel,
      setUpdateChannel,
    } as unknown as Config,
    getUpdateChannel,
    setUpdateChannel,
  };
}

describe("UpdateService channel persistence", () => {
  it("reads persisted channel from config during startup", () => {
    const { config, getUpdateChannel } = createMockConfig("nightly");

    const service = new UpdateService(config);

    expect(getUpdateChannel).toHaveBeenCalledTimes(1);
    expect(service.getChannel()).toBe("nightly");
    expect(getUpdateChannel).toHaveBeenCalledTimes(1);
  });

  it("persists channel changes via config service", async () => {
    const { config, setUpdateChannel } = createMockConfig("stable");

    const service = new UpdateService(config);

    await service.setChannel("nightly");
    expect(setUpdateChannel).toHaveBeenCalledWith("nightly");
    expect(service.getChannel()).toBe("nightly");

    await service.setChannel("stable");
    expect(setUpdateChannel).toHaveBeenLastCalledWith("stable");
    expect(service.getChannel()).toBe("stable");
  });

  it("restores the runtime channel when persistence fails", async () => {
    const { config, setUpdateChannel } = createMockConfig("stable");
    setUpdateChannel.mockRejectedValueOnce(new Error("disk full"));
    const service = new UpdateService(config);
    const channels: UpdateChannel[] = [];
    const internal = service as unknown as {
      impl: { setChannel(channel: UpdateChannel): void; getChannel(): UpdateChannel };
      currentStatus: { type: string };
    };
    internal.impl = {
      setChannel: (channel) => channels.push(channel),
      getChannel: () => channels.at(-1) ?? "stable",
    };
    internal.currentStatus = { type: "idle" };
    let failed = false;
    try {
      await service.setChannel("nightly");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(channels).toEqual(["nightly", "stable"]);
    expect(service.getChannel()).toBe("stable");
  });
});
