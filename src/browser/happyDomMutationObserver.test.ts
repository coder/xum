import { expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * happy-dom 20.0.11 holds each MutationObserver's report callback only through a WeakRef, so after
 * a garbage collection the observer stops reporting without an error (a cause of the #5989
 * flake). patches/happy-dom@20.0.11.patch holds it strongly. bun applies that patch only while
 * the installed version matches its key, and says nothing when it does not (#6348), so this
 * test fails loudly if happy-dom moves to an unpatched version. An upgrade to a version that
 * holds the callback upstream (20.11.15 or later) passes without the patch.
 */
test("a happy-dom MutationObserver keeps reporting after a garbage collection", async () => {
  const window = new Window();
  const target = window.document.createElement("div");
  const batches: number[] = [];
  const observer = new window.MutationObserver((records) => batches.push(records.length));
  observer.observe(target, { childList: true });
  try {
    // A WeakRef keeps its target alive until the current job ends, so collect after this one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
    target.appendChild(window.document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(batches).toEqual([1]);
  } finally {
    observer.disconnect();
    await window.happyDOM.close();
  }
});
