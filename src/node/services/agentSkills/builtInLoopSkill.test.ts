import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { getBuiltInSkillDescriptors } from "./builtInSkillDefinitions";

describe("built-in loop skill", () => {
  const name = SkillNameSchema.parse("loop");

  test("is registered as a model-invoked built-in skill", () => {
    const descriptor = getBuiltInSkillDescriptors().find((d) => d.name === name);

    expect(descriptor).toBeDefined();
    expect(descriptor!.scope).toBe("built-in");
    expect(descriptor!.advertise).not.toBe(false);
  });
});
