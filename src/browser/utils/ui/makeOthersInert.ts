/**
 * Makes every element outside `element` inert (no focus, pointer input or accessibility tree),
 * walking up to <body> and marking the siblings at each level. Returns the undo. Elements that
 * were already inert are left alone, and so are elements whose `inert` someone else changes
 * meanwhile. Nodes added later (portaled menus and tooltips opened from inside `element`) stay
 * interactive.
 *
 * Used by views that cover the window without moving into a portal (Artifacts fullscreen, the
 * phone full-screen right sidebar): a portal would remount their content.
 *
 * The views can nest (Artifacts fullscreen inside the full-screen sidebar), and either can end
 * first (widening the window ends the sidebar's). So the elements this module made inert are
 * counted per caller: an element becomes interactive again only when its last holder undoes.
 */
// Elements this module made inert -> how many active callers hold them.
const holds = new Map<HTMLElement, number>();

export function makeOthersInert(element: HTMLElement): () => void {
  const marked = new Set<HTMLElement>();
  for (let node: HTMLElement = element; node !== document.body; ) {
    const parent = node.parentElement;
    // The element must be attached under <body>; anything else means the walk is wrong.
    if (parent == null) throw new Error("makeOthersInert: element is not inside <body>");
    for (const sibling of parent.children) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      const count = holds.get(sibling);
      if (count !== undefined) {
        holds.set(sibling, count + 1);
      } else if (sibling.inert) {
        continue;
      } else {
        sibling.inert = true;
        holds.set(sibling, 1);
      }
      marked.add(sibling);
    }
    node = parent;
  }
  // Another component that sets or clears `inert` on one of these meanwhile (ChatPane does under
  // immersive review) owns it from then on: the undo must not clear its state (#5715).
  const forget = (records: MutationRecord[]) => {
    for (const record of records) {
      if (!(record.target instanceof HTMLElement)) continue;
      marked.delete(record.target);
      holds.delete(record.target);
    }
  };
  const observer = new MutationObserver(forget);
  for (const sibling of marked) observer.observe(sibling, { attributeFilter: ["inert"] });
  return () => {
    forget(observer.takeRecords());
    observer.disconnect();
    for (const sibling of marked) {
      const count = holds.get(sibling);
      // Another holder's observer saw an outside change first: that owner has it now.
      if (count === undefined) continue;
      if (count > 1) {
        holds.set(sibling, count - 1);
      } else {
        holds.delete(sibling);
        sibling.inert = false;
      }
    }
  };
}
