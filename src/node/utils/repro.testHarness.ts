import { stripVTControlCharacters } from "node:util";

/**
 * Runs a repro of a known finding that must still fail, and only at its target assertion.
 * `test.failing` passes on any thrown error, so a repro broken by a typo or a changed fixture
 * still looked like it reproduced its finding (#5399). This passes only when `repro` throws
 * the expect() mismatch in `target`; once the finding is fixed it fails, so the repro becomes
 * a regular test.
 */
export async function expectReproFailure(
  repro: () => unknown,
  target: { matcher: string; expected: string; received: string }
) {
  try {
    await repro();
  } catch (error) {
    // Bun colors matcher output under FORCE_COLOR; compare the plain text.
    // Jest (tests/ui) appends a matcher comment such as ` // Object.is equality` to the header
    // and does not end the message with a newline; normalize both to Bun's form.
    const message =
      stripVTControlCharacters(error instanceof Error ? error.message : String(error)).replace(
        /\(expected\) \/\/ [^\n]*\n/g,
        "(expected)\n"
      ) + "\n";
    const want = `.${target.matcher}(expected)\n\nExpected: ${target.expected}\nReceived: ${target.received}\n`;
    if (message.includes(want)) return;
    throw new Error(`repro failed elsewhere; wanted:\n${want}\ngot:\n${message}`, { cause: error });
  }
  throw new Error("repro passed: its finding looks fixed, so make it a regular test");
}
