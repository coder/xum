/**
 * Property test for the cookie header reader. A cookie value has no shape of its own, so the
 * reader ends it only at the end of its frame; this composes values out of the characters that
 * once ended a value early (quotes, brackets, `;`, the marker, color codes, backslash runs) and
 * wraps them in the frames tools print headers in. The secret's characters come from an alphabet
 * the scaffolding never uses, so any one left in the output is a leak.
 */
import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";

import { mulberry32, pick, randInt, type Rng } from "@/common/utils/testing/fuzzHelpers";

import { addsSecretLike, containsSecretLike, redactSecretLike } from "./memorySecretRedaction";

const SEED = 0xc00c1e;
const ITERATIONS = 3_000;
const SECRET_CHARS = ["ξ", "ψ", "ω", "λ"];
const SECRET_CHAR = /[ξψωλ]/u;

const secret = (rng: Rng): string =>
  Array.from({ length: 1 + randInt(rng, 6) }, () => pick(rng, SECRET_CHARS)).join("");

const VALUE_PIECES: ReadonlyArray<(rng: Rng) => string> = [
  (rng) => `sid=${secret(rng)}`,
  (rng) => `a="${secret(rng)}"`,
  (rng) => `"${secret(rng)}"`,
  (rng) => `[${secret(rng)}]`,
  () => "; ",
  () => ";",
  () => " ",
  () => "[",
  () => "]",
  () => "[redacted]",
  () => "Path=/",
  () => "\x1b[31m",
  () => "\x1b[0m",
  (rng) => "\\".repeat(1 + randInt(rng, 3)),
];

function cookieValue(rng: Rng): string {
  // A secret first, so every value holds one.
  const pieces = [`sid=${secret(rng)}`];
  for (let count = randInt(rng, 6); count > 0; count--) pieces.push(pick(rng, VALUE_PIECES)(rng));
  // Shuffle the leading pair in: the secret may sit anywhere in the value.
  pieces.splice(randInt(rng, pieces.length), 0, pieces.shift() ?? "");
  return pieces.join("");
}

const headerName = (rng: Rng): string => {
  const name = pick(rng, ["Cookie", "Set-Cookie", "cookie", "set-cookie"]);
  return randInt(rng, 4) === 0 ? `\x1b[1m${name}\x1b[0m` : name;
};

const shellDoubleQuoted = (text: string): string => text.replace(/[\\"]/g, (char) => `\\${char}`);

// What Python's repr() makes of bytes: escapes, and the quote it picked escaped inside.
function pythonRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replaceAll("\x1b", "\\x1b")
    .replaceAll(quote, `\\${quote}`);
  return `b${quote}${escaped}${quote}`;
}

// The frames a header is printed in. Each takes a name and a value, and the second value of a list.
const HEADER_FRAMES: ReadonlyArray<(name: string, value: string, other: string) => string> = [
  (name, value) => `GET / HTTP/1.1\nHost: h\n${name}: ${value}\nAccept: */*`,
  (name, value) => `GET / HTTP/1.1\r\nHost: h\r\n${name}: ${value}\r\nAccept: */*`,
  (_name, value) => JSON.stringify({ headers: { cookie: value, host: "h" } }),
  (_name, value, other) => JSON.stringify({ "set-cookie": [value, other], host: "h" }),
  (_name, value, other) => JSON.stringify({ "set-cookie": [value, other], host: "h" }, null, 2),
  (_name, value) => inspect({ host: "h", cookie: value, accept: "*/*" }),
  (name, value) => `curl -H "${name}: ${shellDoubleQuoted(value)}" https://h`,
  (name, value) => `curl -H '${name}: ${value}' https://h`,
  (name, value) => `- **${name}: ${value}**`,
  (name, value) => `Send \`${name}: ${value}\` with it.`,
  (name, value) => `> GET /\n> ${name}: ${value}\n< HTTP/1.1 200 OK`,
  (name, value) => `map[Accept:[*/*] ${name}:[${value}]]`,
  (name, value) => `msg="req" ${name}: ${value}`,
  (name, value) => pythonRepr(`GET /\r\n${name}: ${value}\r\nHost: h\r\n`),
  (name, value) => pythonRepr(`${name}: ${value}`),
  (_name, value) => pythonRepr(inspect({ host: "h", cookie: value })),
];

// What a tool wraps printed text in: a JSON string, once per layer. Python's repr is a header frame
// only: around JSON it doubles backslashes but not quotes, so a run's depth is no longer one scheme's.
const CONTAINERS: ReadonlyArray<(text: string) => string> = [
  (text) => JSON.stringify({ output: text }),
  (text) => JSON.stringify(text),
];

function framedHeader(rng: Rng): string {
  const frame = pick(rng, HEADER_FRAMES);
  let text = frame(headerName(rng), cookieValue(rng), cookieValue(rng));
  for (let layers = randInt(rng, 3); layers > 0; layers--) text = pick(rng, CONTAINERS)(text);
  return text;
}

describe("cookie header redaction fuzz", () => {
  test(`no secret character survives, and redaction is a fixed point (seed=${SEED})`, () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const text = framedHeader(rng);
      const redacted = redactSecretLike(text);
      const failure = [
        SECRET_CHAR.test(redacted) && "a secret character survived",
        redactSecretLike(redacted) !== redacted && "a second pass changed the text",
        containsSecretLike(redacted) && "the redacted text still holds a secret",
        addsSecretLike(text, text) && "the text adds a secret to itself",
      ].find(Boolean);
      if (failure) {
        throw new Error(
          `${failure} (seed=${SEED}, iteration ${i})\ninput:  ${JSON.stringify(text)}\noutput: ${JSON.stringify(redacted)}`
        );
      }
    }
    expect(true).toBe(true);
  });
});
