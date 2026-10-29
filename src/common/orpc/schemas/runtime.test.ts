import { describe, expect, test } from "bun:test";
import { RuntimeAvailabilityStatusSchema } from "./runtime";
import { getDevcontainerConfigs, type RuntimeAvailabilityStatus } from "@/common/types/runtime";

describe("RuntimeAvailabilityStatusSchema", () => {
  test("preserves configs field when parsing devcontainer availability", () => {
    const input = {
      available: true,
      configs: [
        { path: ".devcontainer/devcontainer.json", label: "Default" },
        { path: ".devcontainer/backend/devcontainer.json", label: "Backend" },
      ],
      cliVersion: "0.81.1",
    };

    const result = RuntimeAvailabilityStatusSchema.parse(input);

    expect(result.available).toBe(true);
    expect("configs" in result).toBe(true);
    if ("configs" in result) {
      expect(result.configs).toHaveLength(2);
      expect(result.configs[0].path).toBe(".devcontainer/devcontainer.json");
      expect(result.configs[1].path).toBe(".devcontainer/backend/devcontainer.json");
    }
    expect("cliVersion" in result && result.cliVersion).toBe("0.81.1");
  });

  test("parses plain available status without configs", () => {
    const input = { available: true };

    const result = RuntimeAvailabilityStatusSchema.parse(input);

    expect(result.available).toBe(true);
    expect("configs" in result).toBe(false);
  });

  test("parses unavailable status with reason", () => {
    const input = { available: false, reason: "Docker daemon not running" };

    const result = RuntimeAvailabilityStatusSchema.parse(input);

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe("Docker daemon not running");
    }
  });
});

describe("getDevcontainerConfigs", () => {
  test("extracts configs from availability status with configs", () => {
    const status: RuntimeAvailabilityStatus = {
      available: true,
      configs: [
        { path: ".devcontainer/devcontainer.json", label: "Default" },
        { path: ".devcontainer/backend/devcontainer.json", label: "Backend" },
      ],
      cliVersion: "0.81.1",
    };

    const configs = getDevcontainerConfigs(status);

    expect(configs).toHaveLength(2);
    expect(configs[0].path).toBe(".devcontainer/devcontainer.json");
  });

  test("returns empty array for plain available status", () => {
    const status: RuntimeAvailabilityStatus = { available: true };

    const configs = getDevcontainerConfigs(status);

    expect(configs).toEqual([]);
  });

  test("returns empty array for unavailable status", () => {
    const status: RuntimeAvailabilityStatus = {
      available: false,
      reason: "No devcontainer.json found",
    };

    const configs = getDevcontainerConfigs(status);

    expect(configs).toEqual([]);
  });
});
