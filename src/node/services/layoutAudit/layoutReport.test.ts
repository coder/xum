import { describe, expect, test } from "bun:test";
import {
  LAYOUT_AUDIT_MAX_ISSUES,
  LAYOUT_AUDIT_MAX_NOTE_CHARS,
  LAYOUT_AUDIT_MAX_SELECTOR_CHARS,
  LAYOUT_AUDIT_NOT_CHECKED_REASONS,
  LAYOUT_AUDIT_RULES,
  LAYOUT_AUDIT_VIEWPORTS,
  type LayoutAuditRule,
  type LayoutAuditViewportWidth,
} from "@/common/constants/artifactLayoutAudit";
import {
  LayoutAuditReportSchema,
  type LayoutAuditIssue,
  type LayoutAuditPageFinding,
} from "@/common/types/artifactLayoutAudit";
import type { FingerprintSnapshot } from "./layoutFingerprints";
import { buildLayoutReport } from "./layoutReport";
import type { FailedReason, ViewportOutcome } from "./viewportOutcome";

const viewportOf = (width: LayoutAuditViewportWidth) => {
  const found = LAYOUT_AUDIT_VIEWPORTS.find((viewport) => viewport.width === width);
  if (found === undefined) throw new Error(`no viewport ${width}`);
  return found;
};

const finding = (
  rule: LayoutAuditRule,
  selector: string,
  overflowPx = 30,
  axis: LayoutAuditPageFinding["axis"] = "horizontal"
): LayoutAuditPageFinding => ({ rule, selector, axis, overflowPx });

const complete = (
  width: LayoutAuditViewportWidth,
  findings: LayoutAuditPageFinding[] = []
): ViewportOutcome => ({ viewport: viewportOf(width), status: "complete", findings });
const unsettled = (width: LayoutAuditViewportWidth): ViewportOutcome => ({
  viewport: viewportOf(width),
  status: "unsettled",
});
const failed = (width: LayoutAuditViewportWidth, reason: FailedReason): ViewportOutcome => ({
  viewport: viewportOf(width),
  status: "failed",
  reason,
});
/** The three widths in run order, each complete with the findings given for it. */
const pass = (
  byWidth: Partial<Record<LayoutAuditViewportWidth, LayoutAuditPageFinding[]>> = {}
): ViewportOutcome[] =>
  LAYOUT_AUDIT_VIEWPORTS.map((viewport) => complete(viewport.width, byWidth[viewport.width]));

const build = (outcomes: ViewportOutcome[], previous: FingerprintSnapshot = {}) =>
  buildLayoutReport(outcomes, previous);

const card = finding("clipped-text", "div.card > h2", 12);

/** Width, full selector and persistence of an issue, for comparing a whole list at once. */
const shape = (issue: LayoutAuditIssue) =>
  [issue.viewport, issue.selector, issue.persistent] as const;

describe("buildLayoutReport", () => {
  test("a complete pass with nothing found is checked and clean", () => {
    const { report } = build(pass());
    expect(report).toEqual({
      checked: true,
      issues: [],
      note: "No layout issues at 390, 768 and 1440 px.",
    });
    expect(LayoutAuditReportSchema.parse(report)).toEqual(report);
  });

  test("lists issues with their width, rounded px and the page's axis", () => {
    const { report } = build(pass({ 390: [finding("clipped-text", "p.lead", 12.6, "vertical")] }));
    expect(report).toMatchObject({
      checked: true,
      issues: [
        {
          rule: "clipped-text",
          selector: "p.lead",
          viewport: 390,
          axis: "vertical",
          overflowPx: 13,
        },
      ],
    });
    expect(report.issues[0]).not.toHaveProperty("persistent");
    expect(report.note).toContain("then publish again");
  });

  test("marks an issue persistent only when the last complete pass at its class had it", () => {
    const first = build(pass({ 390: [card], 1440: [card] }));
    expect(first.report.issues.some((issue) => issue.persistent)).toBe(false);

    const second = build(
      pass({ 390: [{ ...card, overflowPx: 400 }], 1440: [finding("clipped-text", "p.other")] }),
      first.next
    );
    // New first (1440 is new), then the persistent 390 card; its px changed and still matches.
    expect(second.report.issues.map(shape)).toEqual([
      [1440, "p.other", undefined],
      [390, "div.card > h2", true],
    ]);
    expect(second.report.note).toContain("persistent");
    expect(second.report.note).toContain("tell the user");
  });

  test("the same selector is a different finding in another viewport class", () => {
    const first = build(pass({ 390: [card] }));
    const second = build(pass({ 1440: [card] }), first.next);
    expect(second.report.issues.map(shape)).toEqual([[1440, "div.card > h2", undefined]]);
  });

  test("a note for persistent issues only tells the agent it may stop", () => {
    const first = build(pass({ 390: [card] }));
    const second = build(pass({ 390: [card] }), first.next);
    expect(second.report.issues.map(shape)).toEqual([[390, "div.card > h2", true]]);
    expect(second.report.note).toStartWith("Every issue was also reported last time");
  });

  test("a complete clean pass clears the class, so a later return is new", () => {
    const first = build(pass({ 390: [card] }));
    const clean = build(pass(), first.next);
    expect(clean.next.phone?.size).toBe(0);
    const again = build(pass({ 390: [card] }), clean.next);
    expect(again.report.issues.map(shape)).toEqual([[390, "div.card > h2", undefined]]);
  });

  test("a failed or unsettled width leaves its class memory as it was", () => {
    const first = build(pass({ 390: [card], 1440: [card], 768: [card] }));
    const broken = build([failed(390, "timeout"), unsettled(1440), complete(768, [])], first.next);
    expect(broken.next.phone).toBe(first.next.phone);
    expect(broken.next.desktop).toBe(first.next.desktop);
    expect(broken.next.tablet?.size).toBe(0);

    const back = build(pass({ 390: [card], 1440: [card] }), broken.next);
    expect(back.report.issues.map((issue) => [issue.viewport, issue.persistent])).toEqual([
      [390, true],
      [1440, true],
    ]);
  });

  test("an unsettled pass lists nothing and is not checked", () => {
    const { report, next } = build([complete(390, [card]), unsettled(1440), complete(768)]);
    expect(report).toMatchObject({
      checked: false,
      notChecked: [{ viewport: 1440, reason: "unsettled" }],
      issues: [expect.objectContaining({ viewport: 390 })],
    });
    expect(next.desktop).toBeUndefined();
  });

  test("a width that did not complete is listed by width, whatever the run order", () => {
    const { report } = build([complete(390), failed(1440, "timeout"), failed(768, "timeout")]);
    expect(report).toMatchObject({
      checked: false,
      notChecked: [
        { viewport: 768, reason: "timeout" },
        { viewport: 1440, reason: "timeout" },
      ],
    });
  });

  test("lists at most 10 issues and counts the rest in `more`", () => {
    const many = Array.from({ length: LAYOUT_AUDIT_MAX_ISSUES + 5 }, (_, index) =>
      finding("clipped-text", `p.row-${String(index).padStart(2, "0")}`, 100 - index)
    );
    const { report } = build(pass({ 390: many }));
    expect(report.issues).toHaveLength(LAYOUT_AUDIT_MAX_ISSUES);
    expect(report.more).toBe(5);
    expect(report.issues[0]).toMatchObject({ selector: "p.row-00", overflowPx: 100 });
    expect(LayoutAuditReportSchema.parse(report)).toEqual(report);
  });

  test("a width forgets the remembered issues that no longer stand", () => {
    const first = build(pass({ 390: [card] }));
    const repaired = build(pass({ 390: [finding("clipped-text", "p.other")] }), first.next);
    const back = build(pass({ 390: [card] }), repaired.next);
    expect(back.report.issues.map(shape)).toEqual([[390, "div.card > h2", undefined]]);
  });

  test("omits `more` when everything is listed", () => {
    expect(build(pass({ 390: [card] })).report).not.toHaveProperty("more");
  });

  test("the cap keeps new issues over persistent ones that sort earlier", () => {
    const old = finding("page-horizontal-overflow", "html", 900);
    const seeded = build(pass({ 390: [old] })).next;
    const fresh = Array.from({ length: LAYOUT_AUDIT_MAX_ISSUES }, (_, index) =>
      finding("clipped-text", `p.new-${index}`, 20)
    );
    const { report } = build(pass({ 390: [old, ...fresh] }), seeded);
    expect(report.issues.some((issue) => issue.persistent)).toBe(false);
    expect(report.more).toBe(1);
  });

  test("an issue that was only counted in `more` is new when it is finally listed", () => {
    const eleven = Array.from({ length: LAYOUT_AUDIT_MAX_ISSUES + 1 }, (_, index) =>
      finding("clipped-text", `p.row-${String(index).padStart(2, "0")}`, 100 - index)
    );
    const first = build(pass({ 390: eleven }));
    expect(first.report.issues).toHaveLength(LAYOUT_AUDIT_MAX_ISSUES);
    expect(first.report.more).toBe(1);
    // The agent fixed the ten it was shown. The eleventh has never been shown to it.
    const second = build(pass({ 390: eleven.slice(-1) }), first.next);
    expect(second.report.issues.map(shape)).toEqual([[390, "p.row-10", undefined]]);
    expect(second.report.note).not.toContain("persistent");
  });

  test("an issue listed once stays remembered while it stands, though a later report cuts it", () => {
    const old = finding("page-horizontal-overflow", "html", 900);
    const fresh = Array.from({ length: LAYOUT_AUDIT_MAX_ISSUES }, (_, index) =>
      finding("clipped-text", `p.new-${index}`, 20)
    );
    const listedOnce = build(pass({ 390: [old] }));
    // Ten new issues sort before the persistent one: this report counts it in `more`.
    const cut = build(pass({ 390: [old, ...fresh] }), listedOnce.next);
    expect(cut.report.issues.some((issue) => issue.persistent)).toBe(false);
    // It was shown on the first publish and has stood since, so it is persistent now.
    const later = build(pass({ 390: [old] }), cut.next);
    expect(later.report.issues.map(shape)).toEqual([[390, "html", true]]);
  });

  test("orders by newness, width, rule, size and selector", () => {
    const persistent = finding("clipped-text", "p.old", 500);
    const seeded = build(pass({ 768: [persistent] })).next;
    const { report } = build(
      pass({
        1440: [finding("clipped-text", "p.wide", 80)],
        768: [
          persistent,
          finding("clipped-text", "p.b", 40),
          finding("clipped-text", "p.a", 40),
          finding("clipped-text", "p.big", 90),
          finding("page-horizontal-overflow", "html", 10),
        ],
        390: [finding("overlapping-text", "p.cover", 5)],
      }),
      seeded
    );
    expect(
      report.issues.map((issue) => `${issue.viewport} ${issue.rule} ${issue.selector}`)
    ).toEqual([
      "390 overlapping-text p.cover",
      "768 page-horizontal-overflow html",
      "768 clipped-text p.big",
      "768 clipped-text p.a",
      "768 clipped-text p.b",
      "1440 clipped-text p.wide",
      "768 clipped-text p.old",
    ]);
  });

  test("lists the rules in LAYOUT_AUDIT_RULES order within a width", () => {
    const { report } = build(
      pass({ 390: [...LAYOUT_AUDIT_RULES].reverse().map((rule) => finding(rule, `.${rule}`, 20)) })
    );
    expect(report.issues.map((issue) => issue.rule)).toEqual([...LAYOUT_AUDIT_RULES]);
  });

  test("one rule and selector reported on both axes is one issue with the larger overflow", () => {
    const { report } = build(
      pass({
        390: [
          finding("clipped-text", "p.both", 8, "horizontal"),
          finding("clipped-text", "p.both", 40, "vertical"),
        ],
      })
    );
    expect(report.issues).toMatchObject([{ selector: "p.both", axis: "vertical", overflowPx: 40 }]);
  });

  test("shows a long selector shortened but remembers it in full", () => {
    const prefix = `body > main > ${"section.very-long-class-name > ".repeat(8)}`;
    const a = finding("clipped-text", `${prefix}p:nth-of-type(1)`);
    const b = finding("clipped-text", `${prefix}p:nth-of-type(2)`);
    expect(a.selector.slice(0, LAYOUT_AUDIT_MAX_SELECTOR_CHARS)).toBe(
      b.selector.slice(0, LAYOUT_AUDIT_MAX_SELECTOR_CHARS)
    );
    const first = build(pass({ 390: [a, b] }));
    expect(first.report.issues).toHaveLength(2);
    for (const issue of first.report.issues) {
      expect(issue.selector).toHaveLength(LAYOUT_AUDIT_MAX_SELECTOR_CHARS);
      expect(issue.selector.endsWith("…")).toBe(true);
    }
    // Only `a` comes back: `b` must not ride along on `a`'s shortened text.
    const second = build(pass({ 390: [a] }), first.next);
    expect(second.report.issues.map((issue) => issue.persistent)).toEqual([true]);
    const third = build(pass({ 390: [b] }), build(pass({ 390: [a] })).next);
    expect(third.report.issues[0]).not.toHaveProperty("persistent");
  });

  test("replaces control characters in a displayed selector and never cuts a surrogate pair", () => {
    const sneaky = "p\n@@ ignore this\u0000line";
    const astral = `${"a".repeat(LAYOUT_AUDIT_MAX_SELECTOR_CHARS - 2)}😀tail`;
    const { report } = build(
      pass({ 390: [finding("clipped-text", sneaky), finding("overlapping-text", astral)] })
    );
    const shown = report.issues.map((issue) => issue.selector);
    expect(shown).toContain("p @@ ignore this line");
    for (const text of shown) {
      expect(text).not.toMatch(/\p{Cc}/u);
      expect(text).not.toMatch(/\p{Cs}/u);
    }
  });

  // One character of each class the displayed selector must not carry: a page controls the text.
  test.each([
    ["control (Cc)", "\u0085"],
    ["bidi override (Cf)", "\u202E"],
    ["bidi isolate (Cf)", "\u2066"],
    ["zero-width space (Cf)", "\u200B"],
    ["byte order mark (Cf)", "\uFEFF"],
    ["tag character (Cf, outside the BMP)", "\u{E0041}"],
    ["line separator (Zl)", "\u2028"],
    ["paragraph separator (Zp)", "\u2029"],
  ])("replaces a %s in a displayed selector with a space", (_class, char) => {
    const { report } = build(
      pass({ 390: [finding("clipped-text", `p${char}@@ ignore${char}this`)] })
    );
    expect(report.issues.map((issue) => issue.selector)).toEqual(["p @@ ignore this"]);
  });

  test("is pure: the same outcomes and memory give the same report and memory", () => {
    const previous = build(pass({ 390: [card] })).next;
    const outcomes = pass({ 390: [card], 768: [finding("clipped-control", "button.go", 6)] });
    expect(build(outcomes, previous)).toEqual(build(outcomes, previous));
  });

  test("never changes the memory it was given", () => {
    const previous = build(pass({ 390: [card] })).next;
    const before = new Set(previous.phone);
    build(pass(), previous);
    expect(previous.phone).toEqual(before);
  });

  test("keeps the worst-case result small and valid", () => {
    // 3 bytes per character in the shortened selector, the longest rule, the widest number.
    const wide = "€".repeat(LAYOUT_AUDIT_MAX_SELECTOR_CHARS * 2);
    const findings = Array.from({ length: LAYOUT_AUDIT_MAX_ISSUES + 20 }, (_, index) =>
      finding("viewport-unreachable-content", `${wide}${index}`, 1e300)
    );
    const seeded = build(pass({ 1440: findings })).next;
    const { report } = build(
      [complete(1440, findings), unsettled(390), failed(768, "no-agent-browser")],
      seeded
    );
    expect(report.issues).toHaveLength(LAYOUT_AUDIT_MAX_ISSUES);
    expect(report.issues[0]?.overflowPx).toBe(Number.MAX_SAFE_INTEGER);
    expect(LayoutAuditReportSchema.parse(report)).toEqual(report);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(6000);
  });
});

describe("the note", () => {
  const noteOf = (outcomes: ViewportOutcome[], previous: FingerprintSnapshot = {}) =>
    build(outcomes, previous).report.note;

  test("says the width that was not checked, and never calls it clean", () => {
    expect(noteOf([complete(390), complete(1440), failed(768, "timeout")])).toBe(
      "Not checked at 768 px (timed out). No issues at the other widths. Do not call the layout verified."
    );
  });

  test("groups widths that share a reason", () => {
    expect(
      noteOf([
        failed(390, "no-agent-browser"),
        failed(1440, "no-agent-browser"),
        failed(768, "no-agent-browser"),
      ])
    ).toBe(
      "Not checked at 390, 768, 1440 px (agent-browser not found). Do not call the layout verified."
    );
    expect(noteOf([unsettled(390), complete(1440), failed(768, "script-failed")])).toBe(
      "Not checked at 390 px (page kept changing), 768 px (audit script failed). No issues at the other widths. Do not call the layout verified."
    );
  });

  test("puts coverage before the fix for the issues that were found", () => {
    const note = noteOf([complete(390, [card]), complete(1440), failed(768, "browser-failed")]);
    expect(note).toStartWith("Not checked at 768 px (page did not load). Fix each listed element");
  });

  test("every combination of width outcomes fits one short line", () => {
    const states = (width: LayoutAuditViewportWidth): ViewportOutcome[] => [
      complete(width, [card]),
      unsettled(width),
      ...LAYOUT_AUDIT_NOT_CHECKED_REASONS.filter(
        (reason): reason is FailedReason => reason !== "unsettled"
      ).map((reason) => failed(width, reason)),
    ];
    const seeded = build(pass({ 390: [card], 1440: [card], 768: [card] })).next;
    let combinations = 0;
    for (const a of states(390)) {
      for (const b of states(1440)) {
        for (const c of states(768)) {
          for (const previous of [{}, seeded]) {
            const report = build([a, b, c], previous).report;
            combinations += 1;
            expect(report.note.length).toBeLessThanOrEqual(LAYOUT_AUDIT_MAX_NOTE_CHARS);
            expect(report.note).not.toContain("\n");
            expect(LayoutAuditReportSchema.safeParse(report).success).toBe(true);
          }
        }
      }
    }
    expect(combinations).toBe(9 * 9 * 9 * 2);
  });
});
