import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { getBuiltInSkillByName, getBuiltInSkillDescriptors } from "./builtInSkillDefinitions";

describe("built-in orchestrate skill", () => {
  const name = SkillNameSchema.parse("orchestrate");

  test("is registered as a built-in skill", () => {
    const descriptor = getBuiltInSkillDescriptors().find((d) => d.name === name);
    expect(descriptor).toBeDefined();
    expect(descriptor!.scope).toBe("built-in");
  });

  test("is unadvertised so it stays out of the system-prompt skill index", () => {
    // The skill is reachable via `/orchestrate` or `agent_skill_read({ name: "orchestrate" })`
    // but does not appear in the advertised skill list that primes the model.
    // This keeps the default UX uncluttered while preserving the orchestration workflow
    // for users who explicitly want it (see RFC: restore Orchestrator as a hidden skill).
    const descriptor = getBuiltInSkillDescriptors().find((d) => d.name === name);
    expect(descriptor?.advertise).toBe(false);
  });

  test("body documents the delegate-first orchestration contract", () => {
    // Spot-check load-bearing directives — these are the rules a calling agent must
    // follow when /orchestrate is invoked. We assert their substance (not exact prose)
    // so wording can drift without breaking the test, but a wholesale gutting of the
    // playbook would still fail.
    const pkg = getBuiltInSkillByName(name);
    expect(pkg).toBeDefined();

    const body = pkg!.body;
    expect(body).toMatch(/delegate-first/i);
    expect(body).toMatch(/task_apply_git_patch/);
    expect(body).toMatch(/dry[\s_-]*run/i);
    expect(body).toMatch(/Max Task Nesting Depth/i);
    // Long-horizon orchestration must route to durable workflows via the
    // workflow-authoring skill (gate/fixup loops encoded in code, resumable runs).
    expect(body).toMatch(/workflow-authoring/);
  });
});
