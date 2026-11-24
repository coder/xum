/**
 * Cost of the Cyber check every config save runs before it decides to clone and encode.
 * Run: make bench BENCH=cyberReasoningModeDisk
 *
 * The doc is synthetic and in-memory, in the on-disk shape saveConfig builds: 19 projects, every
 * workspace with aiSettings and aiSettingsByAgent {exec, plan, explore}, and a few agent defaults.
 * No slot holds Cyber, so the check walks every slot. Never point it at real data.
 * Keep helpers in this file: bench-compare resolves imports from each side's own tree.
 */
import { bench, do_not_optimize } from "mitata";
import { hasCyberReasoningMode } from "@/node/config/cyberReasoningModeDisk";

/** 4,712 is the live-shaped size; the others show how the row scales. */
const SIZES = [50, 500, 5000, 4712];
const PROJECT_COUNT = 19;

/** mitata passes this to generator benchmarks; get() returns the current .args() value. */
interface BenchState {
  get(name: string): unknown;
}

function makeDoc(count: number): Record<string, unknown> {
  const projects: Array<[string, { workspaces: Array<Record<string, unknown>> }]> = [];
  for (let p = 0; p < PROJECT_COUNT; p++) {
    projects.push([`/bench/projects/project-${p}`, { workspaces: [] }]);
  }
  for (let i = 0; i < count; i++) {
    const name = `feature-${i}`;
    projects[i % PROJECT_COUNT][1].workspaces.push({
      id: `ws${i.toString(36).padStart(6, "0")}`,
      name,
      path: `/bench/src/project-${i % PROJECT_COUNT}/${name}`,
      aiSettings: { model: "openai:gpt-6.1-sol", thinkingLevel: "high", reasoningMode: "pro" },
      aiSettingsByAgent: {
        exec: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
        plan: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
        explore: { model: "anthropic:claude-sonnet-5-5", thinkingLevel: "medium" },
      },
    });
  }
  return {
    projects,
    agentAiDefaults: {
      exec: {
        model: "anthropic:claude-opus-5-5",
        thinkingLevel: "high",
        subagent: { model: "openai:gpt-6.1-sol", reasoningMode: "standard" },
      },
      plan: { model: "anthropic:claude-opus-5-5", thinkingLevel: "high" },
      explore: { model: "anthropic:claude-sonnet-5-5", thinkingLevel: "medium" },
    },
  };
}

bench("hasCyberReasoningMode, no Cyber slot ($workspaces)", function* (state: BenchState) {
  const doc = makeDoc(state.get("workspaces") as number);
  if (hasCyberReasoningMode(doc)) throw new Error("fixture must hold no Cyber slot");
  yield () => do_not_optimize(hasCyberReasoningMode(doc));
}).args("workspaces", SIZES);
