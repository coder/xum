import { expect, test } from "bun:test";
import { expectReproFailure } from "./formalRepro.testHarness";

async function outcome(repro: () => unknown): Promise<string> {
  try {
    await expectReproFailure(repro, { matcher: "toBe", expected: "false", received: "true" });
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message.split(":")[0] : String(error);
  }
}

test("expectReproFailure accepts only a failure at the target assertion", async () => {
  expect(await outcome(() => expect(true).toBe(false))).toBe("accepted");
  expect(await outcome(async () => expect(await Promise.resolve(true)).toBe(false))).toBe(
    "accepted"
  );
  expect(await outcome(() => expect(false).toBe(false))).toBe("repro passed");
  expect(await outcome(() => expect(false).toBe(true))).toBe("repro failed elsewhere; wanted");
  expect(await outcome(() => expect(1).toEqual(2))).toBe("repro failed elsewhere; wanted");
  const typo = () => (undefined as unknown as { dead: boolean }).dead;
  expect(await outcome(typo)).toBe("repro failed elsewhere; wanted");
});

test("expectReproFailure accepts Jest's matcher message format", async () => {
  const jestFailure = (received: string) => () => {
    throw new Error(
      `expect(received).toBe(expected) // Object.is equality\n\nExpected: false\nReceived: ${received}`
    );
  };
  expect(await outcome(jestFailure("true"))).toBe("accepted");
  expect(await outcome(jestFailure("trueish"))).toBe("repro failed elsewhere; wanted");
});
