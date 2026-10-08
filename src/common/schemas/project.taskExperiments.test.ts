import { describe, expect, test } from "bun:test";
import {
  aliasLegacyPtcExclusive,
  withLegacyPtcExclusiveMirror,
} from "@/common/constants/experiments";

describe("withLegacyPtcExclusiveMirror", () => {
  test("mirrors an enabled PTC onto the legacy exclusive key for downgrades", () => {
    expect(withLegacyPtcExclusiveMirror({ programmaticToolCalling: true, rlm: true })).toEqual({
      programmaticToolCalling: true,
      rlm: true,
      programmaticToolCallingExclusive: true,
    });
  });

  test("leaves PTC-off and undefined snapshots untouched", () => {
    expect(withLegacyPtcExclusiveMirror({ programmaticToolCalling: false })).toEqual({
      programmaticToolCalling: false,
    });
    expect(withLegacyPtcExclusiveMirror(undefined)).toBeUndefined();
  });
});

describe("aliasLegacyPtcExclusive", () => {
  test("legacy exclusive true activates merged PTC, winning over an explicit false", () => {
    expect(
      aliasLegacyPtcExclusive({
        programmaticToolCalling: false,
        programmaticToolCallingExclusive: true,
        rlm: true,
      })
    ).toEqual({
      programmaticToolCalling: true,
      programmaticToolCallingExclusive: true,
      rlm: true,
    });
  });

  test("legacy exclusive false and absent flags pass through untouched", () => {
    expect(aliasLegacyPtcExclusive({ programmaticToolCallingExclusive: false })).toEqual({
      programmaticToolCallingExclusive: false,
    });
    expect(aliasLegacyPtcExclusive(undefined)).toBeUndefined();
  });
});
