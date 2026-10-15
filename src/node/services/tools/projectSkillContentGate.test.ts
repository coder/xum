import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { z } from "zod";

import type {
  PreDispatchConsentGate,
  PreDispatchConsentGateContext,
} from "@/node/services/streamManager";

import {
  contextProjectSkillContentWithheld,
  observeProjectSkillContentInToolOutputs,
  toolExcludesProjectSkillContent,
  withToolDescriptionProvenance,
} from "./projectSkillContentGate";

describe("toolExcludesProjectSkillContent", () => {
  it("combines the assembly-time verdict with a trust re-read at the call, failing closed", async () => {
    // Unrouted turn: nothing to exclude. Untrusted routed turn: excluded
    // regardless of the re-read. Trusted routed turn: the re-read decides —
    // a revocation between assembly and the call excludes, a throwing
    // re-read excludes too.
    expect(await toolExcludesProjectSkillContent({})).toBe(false);
    expect(await toolExcludesProjectSkillContent({ excludeProjectSkillContent: true })).toBe(true);
    expect(
      await toolExcludesProjectSkillContent({
        excludeProjectSkillContent: true,
        projectSkillContentStillReadable: () => Promise.resolve(true),
      })
    ).toBe(true);
    expect(
      await toolExcludesProjectSkillContent({
        projectSkillContentStillReadable: () => Promise.resolve(true),
      })
    ).toBe(false);
    expect(
      await toolExcludesProjectSkillContent({
        projectSkillContentStillReadable: () => Promise.resolve(false),
      })
    ).toBe(true);
    expect(
      await toolExcludesProjectSkillContent({
        projectSkillContentStillReadable: () => Promise.reject(new Error("trust unreadable")),
      })
    ).toBe(true);
  });
});

describe("contextProjectSkillContentWithheld", () => {
  it("refuses only when the context carries project content AND the turn excludes it at the call", async () => {
    // Exclusion alone (clean context) never refuses; a live read this stream
    // (projectSkillContentInContext) or request rows under trust do, when the
    // assembly verdict or the trust re-read excludes.
    expect(await contextProjectSkillContentWithheld({ excludeProjectSkillContent: true })).toBe(
      false
    );
    expect(
      await contextProjectSkillContentWithheld({
        excludeProjectSkillContent: true,
        projectSkillContentInContext: () => true,
      })
    ).toBe(true);
    expect(
      await contextProjectSkillContentWithheld({
        memoryWriteCarriesProjectSkillContent: true,
        projectSkillContentStillReadable: () => Promise.resolve(true),
      })
    ).toBe(false);
    expect(
      await contextProjectSkillContentWithheld({
        memoryWriteCarriesProjectSkillContent: true,
        projectSkillContentStillReadable: () => Promise.resolve(false),
      })
    ).toBe(true);
  });
});

describe("withToolDescriptionProvenance", () => {
  it("arms the gate on the context-less start call and per-step calls only when descriptors are retained", async () => {
    const seen: Array<PreDispatchConsentGateContext | undefined> = [];
    const gate: PreDispatchConsentGate = (context) => {
      seen.push(context);
      return Promise.resolve(null);
    };
    expect(withToolDescriptionProvenance(undefined, true)).toBeUndefined();
    expect(withToolDescriptionProvenance(gate, false)).toBe(gate);
    const armed = withToolDescriptionProvenance(gate, true);
    if (armed === undefined) throw new Error("expected an armed gate");
    await armed();
    await armed({ midStream: true, stepMessages: [] });
    expect(seen).toEqual([
      { toolDescriptionsCarryProjectSkillContent: true },
      { midStream: true, stepMessages: [], toolDescriptionsCarryProjectSkillContent: true },
    ]);
  });
});

describe("observeProjectSkillContentInToolOutputs", () => {
  it("flags the live provenance the moment a tool returns project skill content", async () => {
    let flagged = 0;
    const providerDefined = tool({ inputSchema: z.object({}) });
    const tools = observeProjectSkillContentInToolOutputs(
      {
        memory: tool({
          inputSchema: z.object({}),
          execute: () => Promise.resolve({ carriesProjectSkillContent: true, output: "quoted" }),
        }),
        bash: tool({
          inputSchema: z.object({}),
          execute: () => Promise.resolve({ output: "ok" }),
        }),
        web_search: providerDefined,
      },
      () => {
        flagged++;
      }
    );
    const options = { toolCallId: "call", messages: [], context: undefined };
    expect(await tools.bash.execute({}, options)).toEqual({ output: "ok" });
    expect(flagged).toBe(0);
    expect(await tools.memory.execute({}, options)).toEqual({
      carriesProjectSkillContent: true,
      output: "quoted",
    });
    expect(flagged).toBe(1);
    // Tools without an execute function (provider-executed) pass through untouched.
    expect(tools.web_search).toBe(providerDefined);
  });
});
