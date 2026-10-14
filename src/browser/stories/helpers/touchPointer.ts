/**
 * Storybook plays run without a coarse pointer, so the touch-only rules in globals.css (the 44px
 * button minimum) never apply there. This copies the app's own `pointer: coarse` rules into an
 * unconditional stylesheet so a play can check the touch layout. The returned function removes it,
 * so Pixel snapshots taken after the play keep the normal layout.
 */
export function applyTouchPointerRules(doc: Document): () => void {
  const css: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("pointer: coarse")) {
        for (const inner of Array.from(rule.cssRules)) css.push(inner.cssText);
      } else if (rule instanceof CSSGroupingRule) {
        visit(rule.cssRules);
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) visit(sheet.cssRules);
  // Without a copied rule a play would check the desktop layout and pass for no reason.
  if (css.length === 0) throw new Error("No pointer: coarse rules found in the loaded CSS");
  const style = doc.createElement("style");
  style.textContent = css.join("\n");
  doc.head.appendChild(style);
  return () => style.remove();
}
