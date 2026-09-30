import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { getBuiltInSkillDescriptors } from "./builtInSkillDefinitions";

describe("built-in spawn skill", () => {
  const name = SkillNameSchema.parse("spawn");

  test("is registered as a built-in skill", () => {
    const descriptor = getBuiltInSkillDescriptors().find((d) => d.name === name);
    expect(descriptor).toBeDefined();
    expect(descriptor!.scope).toBe("built-in");
  });

  test("is unadvertised so it stays out of the system-prompt skill index", () => {
    // Reachable via `/spawn` or `agent_skill_read({ name: "spawn" })`, but not surfaced
    // in the advertised skill list that primes the model.
    const descriptor = getBuiltInSkillDescriptors().find((d) => d.name === name);
    expect(descriptor?.advertise).toBe(false);
  });
});
