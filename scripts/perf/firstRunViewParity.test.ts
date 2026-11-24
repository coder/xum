import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import { FIRST_RUN_VIEW_HTML } from "@/node/orpc/firstRunView";
import { parityFailures, shellDiff, withFirstRunView } from "./firstRunViewParity";

// Catches a hand-made test page that puts the view inside #root (React clears #root, so the view
// would vanish before the handoff), adds it twice, or patches an HTML it cannot place it in.
test("the test page gets the constant once, outside #root", async () => {
  const served = '<html><body><div id="root"><main>Loading</main></div>\n</body></html>';
  const window = new Window();
  window.document.write(withFirstRunView(served, FIRST_RUN_VIEW_HTML));
  const views = window.document.querySelectorAll(`#${FIRST_RUN_VIEW_ID}`);
  expect(views).toHaveLength(1);
  expect(views[0].closest("#root") === null).toBe(true); // a compact failure, not an element dump
  expect(window.document.getElementById("root")?.textContent).toBe("Loading");
  expect(() => withFirstRunView("<html><body>", FIRST_RUN_VIEW_HTML)).toThrow("</body>");
  await window.happyDOM.close();
});

// Catches a rule that checks only the position (a paragraph 3 px wider passes), uses a tolerance
// other than 2 px, or lets a second <main> landmark through.
test("parity allows 2 px of drift in position and size, and exactly one main", () => {
  const live = { x: 20, y: 300, width: 351, height: 60 };
  expect(parityFailures({ ...live, x: 22, height: 58 }, live, 1)).toEqual([]);
  expect(parityFailures({ ...live, y: 302.5 }, live, 1)).toEqual(["y off by 2.5 px"]);
  expect(parityFailures({ ...live, width: 354 }, live, 1)).toEqual(["width off by 3 px"]);
  expect(parityFailures(live, live, 2)).toEqual(["2 main landmarks in the static phase"]);
  expect(parityFailures(live, live, 0)).toEqual(["0 main landmarks in the static phase"]);
});

// The shell check (owner decision 10-14): pixels outside the dialog box grown by 4 CSS px whose
// color differs by more than 16. Catches a threshold of 16 or 17, a smaller or unscaled margin, a
// dialog that is not excluded, an alpha channel that counts, and screenshots of different sizes.
test("the shell check counts color changes over 16 outside the dialog and its 4 px margin", () => {
  const image = (width: number, height: number) => ({
    data: new Uint8Array(width * height * 4).fill(200),
    width,
    height,
    channels: 4,
  });
  const set = (img: ReturnType<typeof image>, x: number, y: number, rgba: number[]) =>
    img.data.set(rgba, (y * img.width + x) * 4);
  const dialog = { x: 5, y: 2, width: 4, height: 4 }; // excluded: x 1-12, y 0-9 at scale 1
  const [a, b] = [image(20, 10), image(20, 10)];
  set(b, 0, 0, [217, 200, 200, 200]); // off by 17: counted
  set(b, 12, 5, [0, 0, 0, 200]); // inside the margin: not counted
  set(b, 13, 5, [200, 183, 200, 200]); // off by 17 just outside the margin: counted
  set(b, 15, 5, [216, 184, 216, 0]); // off by 16, and an alpha change: not counted
  expect(shellDiff(a, b, dialog, 1)).toEqual({
    pixels: 2,
    bbox: { x: 0, y: 0, width: 14, height: 6 },
  });
  const [a2, b2] = [image(40, 20), image(40, 20)];
  set(b2, 25, 10, [0, 0, 0, 200]); // CSS x 12.5: inside the margin at scale 2
  set(b2, 26, 10, [0, 0, 0, 200]); // CSS x 13: outside
  expect(shellDiff(a2, b2, dialog, 2).pixels).toBe(1);
  expect(() => shellDiff(a, image(20, 11), dialog, 1)).toThrow("size");
});
