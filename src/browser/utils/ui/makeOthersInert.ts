/**
 * Makes every element outside `element` inert (no focus, pointer input or accessibility tree),
 * walking up to <body> and marking the siblings at each level. Returns the undo. Elements that
 * were already inert are left alone, and so are elements whose `inert` someone else changes
 * meanwhile. Nodes added later (portaled menus and tooltips opened from inside `element`) stay
 * interactive.
 *
 * Used by views that cover the window (or, with `root`, the workspace shell) without moving into
 * a portal (Artifacts fullscreen, App View maximize, the phone full-screen right sidebar): a
 * portal would remount their content.
 *
 * The views can nest (Artifacts fullscreen inside the full-screen sidebar), and either can end
 * first (widening the window ends the sidebar's). So the elements this module made inert are
 * counted per caller: an element becomes interactive again only when its last holder undoes.
 */
// Elements this module made inert -> how many active callers hold them.
const holds = new Map<HTMLElement, number>();

/**
 * Makes the siblings of `node` (children of `parent`) inert for one more holder, and adds them to
 * `marked`. A sibling someone else made inert is left alone.
 */
function holdSiblings(node: HTMLElement, parent: HTMLElement, marked: Set<HTMLElement>): void {
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
}

/**
 * `root` bounds the walk: only content inside it goes inert. A view pinned over the workspace
 * shell passes the shell, so the left sidebar outside it stays usable (pinOverWorkspace in pinnedView.ts).
 */
export function makeOthersInert(
  element: HTMLElement,
  root: HTMLElement = document.body
): () => void {
  // The walk climbs from `element` to `root`; anything else means the walk is wrong.
  if (element === root || !root.contains(element)) {
    throw new Error("makeOthersInert: element is not inside root");
  }
  const marked = new Set<HTMLElement>();
  for (let node: HTMLElement = element; node !== root; ) {
    const parent = node.parentElement;
    if (parent == null) throw new Error("makeOthersInert: element is not inside root");
    holdSiblings(node, parent, marked);
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
