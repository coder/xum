import { startWaitBudget } from "./waitBudget";

describe("startWaitBudget", () => {
  test("ends 15 s before the test's limit", () => {
    const remaining = startWaitBudget(60_000, () => 1_000_000);

    expect(remaining()).toBe(45_000);
  });

  test("shrinks by the time that passes after the test starts", () => {
    let clock = 1_000_000;
    const remaining = startWaitBudget(120_000, () => clock);

    clock += 12_345;

    expect(remaining()).toBe(105_000 - 12_345);
  });

  test("stays at 1 ms once the budget is spent, so the next wait fails at once", () => {
    let clock = 1_000_000;
    const remaining = startWaitBudget(60_000, () => clock);

    clock += 45_000;
    expect(remaining()).toBe(1);

    clock += 100_000;
    expect(remaining()).toBe(1);
  });

  test("counts from the call, not from the first read", () => {
    let clock = 1_000_000;
    const remaining = startWaitBudget(60_000, () => clock);

    clock += 20_000;
    expect(remaining()).toBe(25_000);
    expect(remaining()).toBe(25_000);
  });
});
