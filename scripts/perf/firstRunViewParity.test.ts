import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { FIRST_RUN_VIEW_ID } from "@/common/constants/firstRunView";
import { FIRST_RUN_VIEW_HTML } from "@/node/orpc/firstRunView";
import { parityFailures, withFirstRunView } from "./firstRunViewParity";

// Catches a hand-made test page that puts the view inside #root (React clears #root, so the view
// would vanish before the handoff), adds it twice, or patches an HTML it cannot place it in.
test("the test page gets the constant once, outside #root", async () => {
  const served = '<html><body><div id="root"><main>Loading</main></div>\n</body></html>';
  const window = new Window();
  window.document.write(withFirstRunView(served, FIRST_RUN_VIEW_HTML));
  const views = window.document.querySelectorAll(`#${FIRST_RUN_VIEW_ID}`);
  expect(views).toHaveLength(1);
  expect(views[0].closest("#root")).toBeNull();
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
