import { describe, expect, test } from "bun:test";
import { LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import { createFakeLayoutPage } from "./fakeLayoutPage.testHarness";
import type { SettleSignals } from "./layoutPage";
import { runLayoutAudit } from "./settle";

const PHONE = { viewport: { width: 390, height: 844 } };
const OFF_LEFT = (id: string) => `<button id="${id}" data-box="-60 10 100 30">Menu</button>`;
const FINDING: LayoutAuditPageFinding = {
  rule: "viewport-unreachable-control",
  selector: "button#late",
  axis: "horizontal",
  overflowPx: 60,
};

describe("runLayoutAudit", () => {
  test("waits for fonts, layout, animations and frames, samples twice, then once more when quiet", async () => {
    using fake = createFakeLayoutPage("<p>hello</p>", PHONE);
    await runLayoutAudit(fake.page, fake.signals);
    expect(fake.calls).toEqual([
      "fonts",
      "layoutQuiet",
      "animations",
      "frames",
      "measure", // sample A
      "sleep",
      "frames",
      "measure", // sample B
      "domQuiet",
      "measure", // sample C, taken only because the DOM was quiet
      "documentComplete",
      "measure", // the viewport width of the result
    ]);
  });

  test("takes no third sample when the DOM never went quiet", async () => {
    using fake = createFakeLayoutPage("<p>hello</p>", { ...PHONE, settle: { domQuiet: false } });
    await runLayoutAudit(fake.page, fake.signals);
    expect(fake.calls.filter((call) => call === "measure")).toHaveLength(3); // A, B, width
    expect(fake.calls.indexOf("domQuiet")).toBeGreaterThan(fake.calls.lastIndexOf("sleep"));
  });

  test("reports the viewport width the page has at the end", async () => {
    using fake = createFakeLayoutPage("<p>hello</p>", { viewport: { width: 768, height: 1024 } });
    expect(await runLayoutAudit(fake.page, fake.signals)).toEqual({
      complete: true,
      viewportWidth: 768,
      findings: [],
    });
  });

  // The control appears just before sample B (during the pause) or just before sample C (while
  // the DOM waits to go quiet): the page was still moving.
  function signalsThatAdd(
    fake: ReturnType<typeof createFakeLayoutPage>,
    moment: "pause" | "quiet"
  ) {
    const add = () => fake.page.document.body.insertAdjacentHTML("beforeend", OFF_LEFT("late"));
    const signals: SettleSignals = {
      ...fake.signals,
      sleep: async (ms) => {
        if (moment === "pause") add();
        await fake.signals.sleep(ms);
      },
      domQuiet: (quietMs, maxMs) => {
        if (moment === "quiet") add();
        return fake.signals.domQuiet(quietMs, maxMs);
      },
    };
    return signals;
  }

  test("a finding that appears after the first sample is reported when the DOM then went quiet", async () => {
    using fake = createFakeLayoutPage("<p>hello</p>", PHONE);
    const result = await runLayoutAudit(fake.page, signalsThatAdd(fake, "pause"));
    // Samples: A without it, B and C with it. Stable = B and C.
    expect(result).toEqual({ complete: true, viewportWidth: 390, findings: [FINDING] });
  });

  test("it is not reported when the DOM never went quiet, because sample A did not see it", async () => {
    using fake = createFakeLayoutPage("<p>hello</p>", { ...PHONE, settle: { domQuiet: false } });
    const result = await runLayoutAudit(fake.page, signalsThatAdd(fake, "pause"));
    expect(result).toEqual({ complete: false, viewportWidth: 390, findings: [] });
  });

  test("a finding that appears only after the DOM went quiet is not stable", async () => {
    using fake = createFakeLayoutPage("<p>hello</p>", PHONE);
    const result = await runLayoutAudit(fake.page, signalsThatAdd(fake, "quiet"));
    expect(result.findings).toEqual([]);
  });

  test("a finding present in both samples of an unquiet page is kept, but the pass is incomplete", async () => {
    using fake = createFakeLayoutPage(OFF_LEFT("late"), { ...PHONE, settle: { domQuiet: false } });
    const result = await runLayoutAudit(fake.page, fake.signals);
    expect(result).toEqual({ complete: false, viewportWidth: 390, findings: [FINDING] });
  });

  test.each([
    ["the finite animations did not settle", { animationsSettled: false }],
    ["the document is not complete", { documentComplete: false }],
    ["the DOM never went quiet", { domQuiet: false }],
  ])("the pass is incomplete when %s", async (_name, settle) => {
    using fake = createFakeLayoutPage("<p>hello</p>", { ...PHONE, settle });
    expect((await runLayoutAudit(fake.page, fake.signals)).complete).toBe(false);
  });

  test("a layout that never went quiet does not make the pass incomplete", async () => {
    using fake = createFakeLayoutPage("<p>hello</p>", { ...PHONE, settle: { layoutQuiet: false } });
    expect((await runLayoutAudit(fake.page, fake.signals)).complete).toBe(true);
  });

  const manyButtons = (count: number) =>
    Array.from({ length: count }, (_, i) => OFF_LEFT(`b${i}`)).join("");

  test("a pass lists at most as many findings as the result schema allows, and counts the rest", async () => {
    using fake = createFakeLayoutPage(manyButtons(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS + 10), PHONE);
    const result = await runLayoutAudit(fake.page, fake.signals);
    expect(result.findings).toHaveLength(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS);
    expect(result.findings[0].selector).toBe("button#b0");
    expect(result.omittedFindings).toBe(10);
  });

  test("a pass at the cap, not over it, leaves nothing out", async () => {
    using fake = createFakeLayoutPage(manyButtons(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS), PHONE);
    const result = await runLayoutAudit(fake.page, fake.signals);
    expect(result.findings).toHaveLength(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS);
    expect(result).not.toHaveProperty("omittedFindings");

    using over = createFakeLayoutPage(manyButtons(LAYOUT_AUDIT_MAX_FINDINGS_PER_PASS + 1), PHONE);
    expect((await runLayoutAudit(over.page, over.signals)).omittedFindings).toBe(1);
  });
});
