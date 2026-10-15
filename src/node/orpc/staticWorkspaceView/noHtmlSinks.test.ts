import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

// SECURITY AUDIT: the static workspace view draws attacker-controlled transcript text. This folder
// builds DOM nodes only; any API that parses a string as HTML would be an injection sink. Case
// does not matter, so React's srcDoc and dangerouslySetInnerHTML count too.
const SINKS =
  /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc|DOMParser|createContextualFragment|dangerouslySetInnerHTML)\b/i;

test("no HTML sink in the static workspace view", async () => {
  const files = (await fs.readdir(__dirname)).filter(
    (f) => /\.tsx?$/.test(f) && !f.includes(".test.")
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = await fs.readFile(path.join(__dirname, file), "utf8");
    expect({ file, sink: SINKS.exec(source)?.[0] ?? null }).toEqual({ file, sink: null });
  }
});
