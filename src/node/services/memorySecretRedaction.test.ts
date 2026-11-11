import { describe, expect, it } from "bun:test";

import {
  addsSecretLike,
  containsSecretLike,
  redactSecretLike,
  redactWithinCap,
} from "./memorySecretRedaction";

describe("redactSecretLike", () => {
  const FAKE = {
    github: `gho_${"Q7w3".repeat(9)}`,
    pat: `github_pat_${"A1b2".repeat(8)}`,
    slack: "xoxb-1234567890-abcdefghij",
    aws: "AKIAABCDEFGHIJKLMNOP",
    openai: `sk-${"k3J9".repeat(6)}`,
    bearer: "tok_live_abcdefghijklmnop",
    jwt: `eyJ${"h".repeat(12)}.eyJ${"p".repeat(12)}.${"s".repeat(12)}`,
    stripeLive: `sk_live_${"4eC3".repeat(6)}`,
    stripeTest: `sk_test_${"9aZ1".repeat(6)}`,
    stripeRestricted: `rk_live_${"7qW2".repeat(6)}`,
    gitlab: `glpat-${"x9Y8".repeat(5)}`,
    google: `AIza${"Sy7_".repeat(8)}abc`,
    npm: `npm_${"Ab3d".repeat(9)}`,
    slackHook: `T${"0".repeat(8)}/B${"1".repeat(8)}/${"Xz9k".repeat(6)}`,
    urlPassword: "s3cr3t-pw",
    signature: "Zk3%2Bq9Lw%2FPd7%3D",
    sharedAccessKey: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MCtB/xYz+Q==",
  };
  const SERVICE_BUS =
    "Endpoint=sb://demo.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey";

  it.each([
    ["a GitHub OAuth token", `token in env: ${FAKE.github}`, FAKE.github],
    ["a fine-grained GitHub token", `using ${FAKE.pat}`, FAKE.pat],
    ["a Slack token", `slack ${FAKE.slack}`, FAKE.slack],
    ["an AWS access key id", `id ${FAKE.aws}`, FAKE.aws],
    ["an OpenAI-style key", `key ${FAKE.openai}`, FAKE.openai],
    ["a bearer header", `Authorization: Bearer ${FAKE.bearer}`, FAKE.bearer],
    ["a JWT", `jwt ${FAKE.jwt}`, FAKE.jwt],
    ["an env assignment", "DB_PASSWORD=hunter2 npm start", "hunter2"],
    ["a quoted JSON pair with spaces", '{"client_secret": "two words here"}', "two words"],
    [
      "a JSON pair inside an escaped string",
      String.raw`{"out":"{\"api_key\": \"abc123xyz\"}"}`,
      "abc123xyz",
    ],
    ["a YAML pair", "password: s3cret-value\nname: demo", "s3cret-value"],
    ["a basic auth header", "authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    [
      "a PEM private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
    ],
    [
      "a PGP private key block",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQdGBF4hBkcBEADdzx3k\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----",
      "lQdGBF4hBkcBEADdzx3k",
    ],
    [
      "an unterminated PGP private key block",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF4hBkcBEADdzx3k",
      "lQdGBF4hBkcBEADdzx3k",
    ],
    [
      "an Azure storage connection string",
      "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=Eby8vdM02xNOcqFlqUwJ+PEx/3x==;EndpointSuffix=core.windows.net",
      "Eby8vdM02xNOcqFlqUwJ+PEx/3x==",
    ],
    ["an account key in a JSON pair", '{"accountKey": "Eby8vdM02xNOc"}', "Eby8vdM02xNOc"],
    [
      "a Service Bus connection string with the key in the middle",
      `${SERVICE_BUS};SharedAccessKey=${FAKE.sharedAccessKey};EntityPath=orders`,
      FAKE.sharedAccessKey,
    ],
    [
      "a Service Bus connection string that ends in the key",
      `${SERVICE_BUS};SharedAccessKey=${FAKE.sharedAccessKey}`,
      FAKE.sharedAccessKey,
    ],
    [
      "a Service Bus connection string in an environment line",
      `AZURE_SERVICEBUS_CONNECTION_STRING=${SERVICE_BUS};SharedAccessKey=${FAKE.sharedAccessKey}\nPORT=8080`,
      FAKE.sharedAccessKey,
    ],
    [
      "a Service Bus connection string in a quoted environment value",
      `export EVENTHUB_CONNECTION_STRING="${SERVICE_BUS};SharedAccessKey=${FAKE.sharedAccessKey};EntityPath=hub"`,
      FAKE.sharedAccessKey,
    ],
    [
      "a Service Bus connection string in a JSON value",
      JSON.stringify({
        connectionString: `${SERVICE_BUS};SharedAccessKey=${FAKE.sharedAccessKey}`,
      }),
      FAKE.sharedAccessKey,
    ],
    [
      "a Service Bus connection string in JSON that a tool printed as JSON",
      JSON.stringify({
        out: JSON.stringify({ cs: `${SERVICE_BUS};SharedAccessKey=${FAKE.sharedAccessKey}` }),
      }),
      FAKE.sharedAccessKey,
    ],
    [
      "a shared access key in a JSON pair",
      JSON.stringify({ SharedAccessKey: FAKE.sharedAccessKey, SharedAccessKeyName: "root" }),
      FAKE.sharedAccessKey,
    ],
    [
      "a shared access key in snake case",
      `shared_access_key: ${FAKE.sharedAccessKey}`,
      FAKE.sharedAccessKey,
    ],
    ["a bearer assignment", "curl -d bearer=abc123def456 https://example.com", "abc123def456"],
    ["a bearer JSON pair", '{"bearer": "abc123def456"}', "abc123def456"],
    [
      "an unterminated PEM private key",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg",
      "MIIEvQIBADANBg",
    ],
    [
      "an unterminated quoted value",
      '{"password": "unterminated-secret-va',
      "unterminated-secret-va",
    ],
    [
      "URL userinfo",
      `clone https://deploy:${FAKE.urlPassword}@git.example.com/org/repo.git`,
      FAKE.urlPassword,
    ],
    [
      "URL userinfo with an empty user",
      `redis://:${FAKE.urlPassword}@cache:6379/0`,
      FAKE.urlPassword,
    ],
    ["a live Stripe key", `STRIPE=${FAKE.stripeLive}`, FAKE.stripeLive],
    ["a test Stripe key", `using ${FAKE.stripeTest}`, FAKE.stripeTest],
    ["a restricted Stripe key", `using ${FAKE.stripeRestricted}`, FAKE.stripeRestricted],
    ["a GitLab token", `glab auth ${FAKE.gitlab}`, FAKE.gitlab],
    ["a Google API key", `maps ${FAKE.google}`, FAKE.google],
    ["an npm token", `//registry.npmjs.org/:_authToken ${FAKE.npm}`, FAKE.npm],
    [
      "a Slack webhook URL",
      `curl https://hooks.slack.com/services/${FAKE.slackHook}`,
      FAKE.slackHook,
    ],
    [
      "a bracketed environment assignment",
      'os.environ["API_KEY"] = "abc123xyz-value"',
      "abc123xyz-value",
    ],
    ["a bracketed single-quoted assignment", "env['DB_PASSWORD']= 'hunter2x'", "hunter2x"],
    [
      "a bracketed assignment in JSON-escaped text",
      String.raw`{"c":"cfg[\"token\"] = \"zz9plural\""}`,
      "zz9plural",
    ],
    [
      "an Azure SAS signature",
      `https://acct.blob.core.windows.net/c/b?sv=2022-11-02&se=2030-01-01&sig=${FAKE.signature}&sp=r`,
      FAKE.signature,
    ],
    [
      "a signature parameter",
      `https://files.example.com/d?expires=99&signature=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "an AWS presigned URL signature",
      `https://b.s3.amazonaws.com/k?X-Amz-Expires=60&X-Amz-Signature=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "a Google signed URL signature",
      `https://storage.googleapis.com/b/o?X-Goog-Expires=60&X-Goog-Signature=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "a signature parameter in any letter case",
      `https://h.example.com/p?SIG=${FAKE.signature}`,
      FAKE.signature,
    ],
    [
      "a signature parameter after an XML-escaped ampersand",
      `<Url>https://h.example.com/p?se=1&amp;sig=${FAKE.signature}&amp;sp=r</Url>`,
      FAKE.signature,
    ],
    [
      "a signed URL inside a JSON-escaped string",
      JSON.stringify({ url: `https://h.example.com/p?a=1&sig=${FAKE.signature}` }),
      FAKE.signature,
    ],
  ])("redacts %s", (_label, text, secret) => {
    const redacted = redactSecretLike(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted]");
  });

  // The value's escaped quote is not its end: what follows it was leaking to the harvest model.
  // Each input is the form `JSON.stringify` makes, once for a tool value and once more for a tool
  // that printed JSON.
  it.each([
    [
      "a JSON-stringified quote",
      JSON.stringify({ password: 'abc"DEF-SUFFIX' }),
      String.raw`{"password":[redacted]}`,
    ],
    [
      "an escaped backslash before the closing quote",
      JSON.stringify({ password: "abc\\", user: "alice" }),
      String.raw`{"password":[redacted],"user":"alice"}`,
    ],
    [
      "an escaped quote and the keys after it",
      JSON.stringify({ password: 'a"b"c', user: "alice" }),
      String.raw`{"password":[redacted],"user":"alice"}`,
    ],
    [
      "a quote inside JSON printed by a tool",
      JSON.stringify({ out: JSON.stringify({ password: 'abc"DEF-SUFFIX', user: "alice" }) }),
      String.raw`{"out":"{\"password\":[redacted],\"user\":\"alice\"}"}`,
    ],
    [
      "an escaped backslash inside JSON printed by a tool",
      JSON.stringify({ out: JSON.stringify({ password: "abc\\", user: "alice" }) }),
      String.raw`{"out":"{\"password\":[redacted],\"user\":\"alice\"}"}`,
    ],
    [
      "a backslash and a quote inside JSON printed by a tool",
      JSON.stringify({ out: JSON.stringify({ password: 'a\\"b', user: "alice" }) }),
      String.raw`{"out":"{\"password\":[redacted],\"user\":\"alice\"}"}`,
    ],
    [
      "an escaped apostrophe",
      String.raw`password = 'it\'s-secret' next`,
      "password = [redacted] next",
    ],
    ["a Windows path", String.raw`password: "C:\Users\me" next`, "password: [redacted] next"],
    [
      "an unterminated value that ends in an escaped quote",
      String.raw`{"password":"abc\"DEF`,
      '{"password":[redacted]',
    ],
    [
      "an unterminated value that ends in a backslash",
      `{"password": "abc${"\\"}`,
      '{"password": [redacted]',
    ],
  ])("redacts the whole value with %s", (_label, text, expected) => {
    expect(redactSecretLike(text)).toBe(expected);
  });

  // Text that went through JSON.stringify once more is the same text with every quote and backslash
  // escaped, so redacting it must give the escaped form of what redacting the original gives. The
  // passwords are the shapes that move the value's close: none, an escaped quote, a trailing
  // backslash, and a backslash before a quote.
  describe("a credential inside JSON that was stringified again", () => {
    const escapeOnce = (text: string): string => JSON.stringify(text).slice(1, -1);
    const escapeTimes = (text: string, times: number): string =>
      times === 0 ? text : escapeTimes(escapeOnce(text), times - 1);
    const passwords = ["plain-pw-4f9e", 'embedded"quote-7c1d', "trailing\\", 'back\\"slash-2b8a'];
    const cases = [1, 2, 3, 4, 5].flatMap((layers) =>
      passwords.map((password) => [layers, password] as const)
    );

    it.each(cases)("redacts the whole value at %i layers of escaping: %j", (layers, password) => {
      const text = JSON.stringify({ password, user: "alice" });

      expect(redactSecretLike(escapeTimes(text, layers))).toBe(
        escapeTimes('{"password":[redacted],"user":"alice"}', layers)
      );
    });

    it("redacts an unterminated value through to the end of the text", () => {
      const text = escapeTimes(JSON.stringify({ password: 'abc"cut-tail' }), 3).slice(0, -8);

      const redacted = redactSecretLike(text);

      expect(redacted).toEndWith("[redacted]");
      expect(redacted).not.toContain("cut");
    });

    it("keeps a pair after the value readable at its own depth", () => {
      const text = escapeTimes(JSON.stringify({ a: { token: "t0k3n-val", b: "kept" } }), 3);

      expect(redactSecretLike(text)).toBe(escapeTimes('{"a":{"token":[redacted],"b":"kept"}}', 3));
    });
  });

  // A session cookie is a bearer credential with no keyword and no token shape of its own. The
  // value of a `Cookie` / `Set-Cookie` header goes to the end of its frame (a raw line, a quoted
  // string, a JSON string at some depth), never to a quote or bracket of its own; the name stays.
  describe("a cookie header", () => {
    const SESSION = "s%3AopaqueSessionValue.Zm9vYmFy";
    const jsonOf = (value: unknown): string => JSON.stringify(value);

    it.each([
      [
        "a Cookie request header",
        `GET / HTTP/1.1\nHost: example.com\nCookie: connect.sid=${SESSION}; theme=dark\nAccept: */*`,
        "GET / HTTP/1.1\nHost: example.com\nCookie: [redacted]\nAccept: */*",
      ],
      [
        "a Set-Cookie header with attributes",
        `Set-Cookie: sessionid=${SESSION}; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT\nVary: Cookie`,
        "Set-Cookie: [redacted]\nVary: Cookie",
      ],
      ["a header name in any letter case", `sEt-CoOkIe: sid=${SESSION}`, "sEt-CoOkIe: [redacted]"],
      [
        "a header that ends in a carriage return",
        `Cookie: sid=${SESSION}\r\nHost: example.com`,
        "Cookie: [redacted]\r\nHost: example.com",
      ],
      [
        "a header block in a JSON string, where a line break is escaped",
        jsonOf({ output: `GET /\r\nHost: h\r\nCookie: sid=${SESSION}; a=b\r\nAccept: */*` }),
        String.raw`{"output":"GET /\r\nHost: h\r\nCookie: [redacted]\r\nAccept: */*"}`,
      ],
      [
        "a header in JSON that a tool printed as JSON",
        jsonOf({ out: jsonOf({ headers: `Set-Cookie: sid=${SESSION}; Path=/` }) }),
        String.raw`{"out":"{\"headers\":\"Set-Cookie: [redacted]\"}"}`,
      ],
      [
        "a header in a quoted command line",
        `curl -H "Cookie: sid=${SESSION}; b=2" https://example.com`,
        'curl -H "Cookie: [redacted]" https://example.com',
      ],
      [
        "a header in a single-quoted command line",
        `curl -H 'Cookie: sid=${SESSION}' https://example.com`,
        "curl -H 'Cookie: [redacted]' https://example.com",
      ],
      [
        "a header in Markdown inline code",
        `Send \`Cookie: sid=${SESSION}\` with the request.`,
        "Send `Cookie: [redacted]",
      ],
      [
        "a header as a JSON key",
        jsonOf({ headers: { cookie: `sid=${SESSION}; a=b`, host: "example.com" } }),
        '{"headers":{"cookie":"[redacted]","host":"example.com"}}',
      ],
      [
        "a header as a key of JSON that a tool printed as JSON",
        jsonOf({ out: jsonOf({ Cookie: `sid=${SESSION}`, host: "example.com" }) }),
        String.raw`{"out":"{\"Cookie\":\"[redacted]\",\"host\":\"example.com\"}"}`,
      ],
      [
        "every value of a set-cookie array",
        jsonOf({ "set-cookie": [`a=${SESSION}; Path=/`, `b=${SESSION}2`], host: "example.com" }),
        '{"set-cookie":[redacted],"host":"example.com"}',
      ],
      [
        "an array of values printed over several lines",
        `"set-cookie": [\n  "a=${SESSION}; Path=/",\n  "b=${SESSION}2"\n],\n"host": "example.com"`,
        '"set-cookie": [redacted],\n"host": "example.com"',
      ],
      [
        "a value with backslashes in it, up to the escape of a line break",
        jsonOf({ output: `Cookie: sid=a\\b\\\r\nHost: h` }),
        String.raw`{"output":"Cookie: [redacted]\r\nHost: h"}`,
      ],
      [
        "the lines of a curl trace, behind their > and < markers",
        `> GET / HTTP/1.1\n> Cookie: sid=${SESSION}\n< HTTP/1.1 200 OK\n< Set-Cookie: sid=${SESSION}; Path=/\n< Vary: Cookie`,
        "> GET / HTTP/1.1\n> Cookie: [redacted]\n< HTTP/1.1 200 OK\n< Set-Cookie: [redacted]\n< Vary: Cookie",
      ],
      [
        "an indented header and a header in a list",
        `  headers:\n    Cookie: sid=${SESSION}\n  - Set-Cookie: sid=${SESSION}`,
        "  headers:\n    Cookie: [redacted]\n  - Set-Cookie: [redacted]",
      ],
      [
        "a header after an escaped line break and an indent",
        String.raw`"GET /\r\n  Cookie: sid=${SESSION}\r\nAccept: */*"`,
        String.raw`"GET /\r\n  Cookie: [redacted]\r\nAccept: */*"`,
      ],
      [
        // No string's quote is in view, so where the value ends is unknown: the raw line goes.
        "a header after an escaped line break outside any string",
        String.raw`GET /\r\n  Cookie: sid=${SESSION}\r\nAccept: */*`,
        String.raw`GET /\r\n  Cookie: [redacted]`,
      ],
      [
        // An unquoted key is no quoted key, so its value runs to the end of the raw line.
        "a key of an object that a tool printed unquoted",
        `{ host: 'example.com', cookie: 'sid=${SESSION}', accept: '*/*' }`,
        "{ host: 'example.com', cookie: [redacted]",
      ],
      [
        "an unquoted -H argument",
        `curl -H Cookie:sid=${SESSION} https://example.com`,
        "curl -H Cookie:[redacted]",
      ],
      [
        "a value behind a long gap",
        `Cookie:${" ".repeat(60)}sid=${SESSION}\nHost: example.com`,
        `Cookie:${" ".repeat(48)}[redacted]\nHost: example.com`,
      ],
    ])("redacts %s and keeps what is around it", (_label, text, expected) => {
      const redacted = redactSecretLike(text);

      expect(redacted).toBe(expected);
      expect(redacted).not.toContain(SESSION);
      // Redacting what is already redacted changes nothing, as the guard and the renderer both run it.
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    it("leaves a word that only contains the name, and prose about cookies, readable", () => {
      const text = [
        "The cookie banner was dismissed and the cookies were cleared.",
        "cookie=none, cookies: 3, document.cookie, cookieJar.get('a')",
        "getCookie: function () {}; X-Cookie-Policy: strict; Cookie-Policy: lax",
        "Set-Cookie handling is described in RFC 6265.",
      ].join("\n");

      expect(redactSecretLike(text)).toBe(text);
    });

    // The rule judges no shape of the value, so prose after `cookie:` goes too: it fails closed.
    it("redacts the rest of a sentence that has `cookie:` in the middle of it", () => {
      const text = [
        "Note on the cookie: it expires after an hour.",
        "Session cookie: HttpOnly and Secure flags are set by the login route.",
      ].join("\n");

      expect(redactSecretLike(text)).toBe(
        "Note on the cookie: [redacted]\nSession cookie: [redacted]"
      );
    });

    // A cookie pair is a credential wherever the header sits: the frames a tool or a model wraps it
    // in (Markdown, a numbered list, one line of several headers, Go's map print) do not matter.
    it.each([
      ["Markdown emphasis in a list", `- **Cookie: sid=${SESSION}**`, "- **Cookie: [redacted]"],
      ["a numbered list", `1. Cookie: sid=${SESSION}`, "1. Cookie: [redacted]"],
      [
        "several headers on one line",
        `Host: x; Cookie: a=${SESSION}`,
        "Host: x; Cookie: [redacted]",
      ],
      // The frame is read only from right before the name, so the rest of this line goes too.
      [
        "several headers in a quoted argument",
        `curl -H "Host: x; Cookie: a=${SESSION}" url`,
        'curl -H "Host: x; Cookie: [redacted]',
      ],
      // The list only tells where the line's end may begin: the value runs to the end of the line.
      [
        "Go's map print",
        `map[Accept:[*/*] Cookie:[a=${SESSION}]]`,
        "map[Accept:[*/*] Cookie:[redacted]",
      ],
      [
        "Go's map print with a quoted value in the list",
        `map[Set-Cookie:[theme="dark"; Path=/ sid=${SESSION}]]`,
        "map[Set-Cookie:[redacted]",
      ],
      ["Go's map print closed after the marker", "map[Cookie:[redacted]]", "map[Cookie:[redacted]"],
      ["a sentence", `The cookie: a=${SESSION}`, "The cookie: [redacted]"],
      ["terminal color codes", `Cookie: \x1b[31msid=${SESSION}\x1b[0m`, "Cookie: [redacted]"],
      [
        "terminal color codes in JSON text",
        jsonOf({ out: `Cookie: \x1b[31msid=${SESSION}` }),
        '{"out":"Cookie: [redacted]"}',
      ],
      ["a list after a bare name", `Set-Cookie: ["sid=${SESSION}"]`, "Set-Cookie: [redacted]"],
      [
        "a list after a bare name in JSON text",
        jsonOf({ stdout: `Set-Cookie: ["sid=${SESSION}", "a=b"]\nVary: Cookie` }),
        String.raw`{"stdout":"Set-Cookie: [redacted]\nVary: Cookie"}`,
      ],
    ])("redacts a cookie pair in %s", (_label, text, expected) => {
      const redacted = redactSecretLike(text);

      expect(redacted).toBe(expected);
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    // Each of these ends a value at something inside it (a quote, a `]`, a marker, a color code
    // around the name) under a content-based rule, and leaves the rest of the value readable.
    it.each([
      [
        "a `]` inside a list item",
        jsonOf({ "set-cookie": ["a=foo]bar", `sid=${SESSION}`] }),
        // The regex pass ends the list at that `]`; what follows reads as more value.
        '{"set-cookie":[redacted]',
      ],
      ["a quoted pair", `Cookie: sid="${SESSION}"\nHost: h`, "Cookie: [redacted]\nHost: h"],
      [
        "a quoted pair in JSON text",
        jsonOf({ o: `Cookie: sid="${SESSION}"` }),
        '{"o":"Cookie: [redacted]"}',
      ],
      [
        "a single-quoted pair in JSON text",
        jsonOf({ o: `Cookie: sid='${SESSION}'` }),
        '{"o":"Cookie: [redacted]"}',
      ],
      ["a pair after the marker", `Cookie: [redacted]; sid=${SESSION}`, "Cookie: [redacted]"],
      ["a pair after a list", `Cookie: [x]; sid=${SESSION}`, "Cookie: [redacted]"],
      ["a pair after an empty list", `Cookie: [] sid=${SESSION}`, "Cookie: [redacted]"],
      [
        "a pair after a quoted key's value",
        `"cookie": "a"; sid=${SESSION}`,
        '"cookie": [redacted]',
      ],
      [
        "a pair after escaped quotes in a quoted argument",
        `curl -H "Cookie: a=\\"x\\"; sid=${SESSION}" url`,
        'curl -H "Cookie: [redacted]" url',
      ],
      // `C` and `S` end a color code too: the name still starts there.
      ["a name that ends a color code", `\x1b[Cookie: sid=${SESSION}`, "\x1b[Cookie: [redacted]"],
      [
        "a Set-Cookie that ends a color code",
        `\x1b[Set-Cookie: sid=${SESSION}`,
        "\x1b[Set-Cookie: [redacted]",
      ],
      // A quote behind a word closes a string: the header after it sits in raw text.
      [
        "a quoted token before the header",
        `msg="req" Cookie: sid="${SESSION}"`,
        'msg="req" Cookie: [redacted]',
      ],
      [
        "escaped quotes before the header in JSON text",
        jsonOf({ o: `say "hi" Cookie: sid="${SESSION}"` }),
        String.raw`{"o":"say \"hi\" Cookie: [redacted]`,
      ],
      // A quote before `S` or before a cookie character is the value's own, not the string's close.
      [
        "Python's bytes repr",
        `b'GET /\\r\\nSet-Cookie: sid="${SESSION}"\\r\\n'`,
        `b'GET /\\r\\nSet-Cookie: [redacted]\\r\\n'`,
      ],
      [
        "a quoted pair in a quoted argument",
        `curl -H "Cookie: sid="${SESSION}"" url`,
        'curl -H "Cookie: [redacted]" url',
      ],
      ["a single-quoted escaped key", `\\'cookie\\': sid="${SESSION}"`, "\\'cookie\\': [redacted]"],
      [
        "a name after an escaped tab",
        jsonOf({ o: `a\tCookie: sid=${SESSION}` }),
        String.raw`{"o":"a\tCookie: [redacted]"}`,
      ],
      [
        "an apostrophe in a list that is not an item's quote",
        `Set-Cookie: [it's x] ${SESSION}\nmore\nlines`,
        "Set-Cookie: [redacted]\nmore\nlines",
      ],
      // A quote at a value's start opens it, even where it could close the frame around it.
      [
        "a quoted value after a single-quoted argument's colon",
        `echo 'Cookie: ' sid=${SESSION}'`,
        "echo 'Cookie: [redacted]",
      ],
      ["a single-quoted value at the start", `'Cookie: ' sid=${SESSION}`, "'Cookie: [redacted]"],
      ["a quoted value in an assignment", `x="Cookie: " sid=${SESSION}"`, 'x="Cookie: [redacted]'],
      ["a quoted value before a comma", `"Cookie: ",${SESSION}"`, '"Cookie: [redacted]'],
      // The fail-closed cost: an empty header in a quoted argument loses the rest of its line.
      [
        "an empty header in a quoted argument",
        `curl -H "Cookie: " https://example.com/${SESSION}`,
        'curl -H "Cookie: [redacted]',
      ],
    ])("redacts the whole value with %s", (_label, text, expected) => {
      const redacted = redactSecretLike(text);

      expect(redacted).toBe(expected);
      expect(redacted).not.toContain(SESSION);
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    // Where the frame ends decides what stays readable after the value.
    it.each([
      [
        "a string closed before an escaped line break",
        jsonOf(JSON.stringify({ h: `Cookie: ${SESSION}` }, null, 2)),
        String.raw`"{\n  \"h\": \"Cookie: [redacted]\"\n}"`,
      ],
      [
        "a string that opens the text",
        `"Cookie: sid=${SESSION}" keep`,
        '"Cookie: [redacted]" keep',
      ],
      ["a string after a space", ` "Cookie: sid=${SESSION}" keep`, ' "Cookie: [redacted]" keep'],
      // Up to 16 line markers between a string's quote and the name keep the string as the frame.
      [
        "a string with 16 blanks before the name",
        `"${" ".repeat(16)}Cookie: sid=${SESSION}" keep`,
        `"${" ".repeat(16)}Cookie: [redacted]" keep`,
      ],
      [
        "a string with 17 blanks before the name",
        `"${" ".repeat(17)}Cookie: sid=${SESSION}" keep`,
        `"${" ".repeat(17)}Cookie: [redacted]`,
      ],
      [
        "a string with a comma before the name",
        `"\x1b[0m,Cookie: sid=${SESSION}" keep`,
        '"\x1b[0m,Cookie: [redacted]',
      ],
      [
        "a string with a bare escape before the name",
        `"\x1b Cookie: a" sid=${SESSION}`,
        '"\x1b Cookie: [redacted]',
      ],
      // The other quote inside a string is content: `'a'` leaves the JSON string open.
      [
        "a JSON string with single quotes before an escaped line break",
        jsonOf({ o: `'a'\nCookie: sid=${SESSION}`, p: "keep" }),
        String.raw`{"o":"'a'\nCookie: [redacted]","p":"keep"}`,
      ],
      [
        "an escaped backslash before an escaped line break",
        jsonOf({ o: `a\\\nCookie: sid=${SESSION}`, p: "keep" }),
        String.raw`{"o":"a\\\nCookie: [redacted]","p":"keep"}`,
      ],
      [
        "a quoted key's bare value in a JSON string",
        jsonOf({ p: `{"cookie": sid=${SESSION}, "a": 1}`, q: "keep" }),
        String.raw`{"p":"{\"cookie\": [redacted]","q":"keep"}`,
      ],
      [
        "a quoted key's bare value two strings deep",
        jsonOf({ o: jsonOf({ p: `{"cookie": sid=${SESSION}, "a": 1}`, q: "keep" }) }),
        String.raw`{"o":"{\"p\":\"{\\\"cookie\\\": [redacted]\",\"q\":\"keep\"}"}`,
      ],
      ["a pair after a quoted key's list", `"cookie": [a] sid=${SESSION}`, '"cookie": [redacted]'],
      [
        "an escaped bracket in a list",
        `Set-Cookie: [a\\[b] sid=${SESSION}\nHost: h`,
        "Set-Cookie: [redacted]\nHost: h",
      ],
      // A raw line break ends an unclosed item, not the list.
      [
        "an item cut by a line break",
        `Set-Cookie: ["${SESSION}\\\nb]\nHost: h`,
        "Set-Cookie: [redacted]\nHost: h",
      ],
      [
        "an item after an item cut by a line break",
        `Set-Cookie: ["${SESSION}\\\n"x[y"]\nHost: h`,
        "Set-Cookie: [redacted]\nHost: h",
      ],
      [
        "backslashes before a raw line break",
        `Cookie: sid=${SESSION}\\\\\nHost: h`,
        "Cookie: [redacted]\nHost: h",
      ],
    ])("ends the value at its frame in %s", (_label, text, expected) => {
      const redacted = redactSecretLike(text);

      expect(redacted).toBe(expected);
      expect(redacted).not.toContain(SESSION);
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    // The regex pass runs first and its marker can hide the structure after it, so these rows put
    // more blanks before the colon than the regex reads: only the reader sees the header.
    const GAP = " ".repeat(49);
    it.each([
      [
        "a nested list",
        `{"set-cookie"${GAP}:[["a"],"${SESSION}"]}`,
        `{"set-cookie"${GAP}:[redacted]}`,
      ],
      [
        "an escaped line break two strings deep",
        jsonOf({ out: jsonOf({ h: `Cookie${GAP}: sid=${SESSION}\nHost: h` }) }),
        String.raw`{"out":"{\"h\":\"Cookie${GAP}: [redacted]\\nHost: h\"}"}`,
      ],
      [
        "an unclosed list in a string at depth one",
        String.raw`{"o":"{\"h\":\"Set-Cookie${GAP}: [a, ${SESSION}\"}"}`,
        String.raw`{"o":"{\"h\":\"Set-Cookie${GAP}: [redacted]\"}"}`,
      ],
      [
        "a quoted key's list of escaped items with a `]` in one",
        jsonOf({ o: `{"set-cookie"${GAP}:["a]b","sid=${SESSION}"]}` }),
        String.raw`{"o":"{\"set-cookie\"${GAP}:[redacted]}"}`,
      ],
      // An item's quote before a blank opens it: read as its close, ` a]` would end the list.
      [
        "a list item that opens with a blank",
        `{"cookie"${GAP}:[" a]b","${SESSION}"],"host":"h"}`,
        `{"cookie"${GAP}:[redacted],"host":"h"}`,
      ],
      [
        "an escaped list item that opens with a blank",
        jsonOf({ o: `{"cookie"${GAP}:[" a]b","${SESSION}"],"host":"h"}` }),
        String.raw`{"o":"{\"cookie\"${GAP}:[redacted],\"host\":\"h\"}"}`,
      ],
      [
        "backslashes before a raw line break",
        `Cookie${GAP}: sid=${SESSION}\\\\\nHost: h`,
        `Cookie${GAP}: [redacted]\nHost: h`,
      ],
      [
        "an escaped bracket in a list",
        `Set-Cookie${GAP}: [a\\[b] sid=${SESSION}\nHost: h`,
        `Set-Cookie${GAP}: [redacted]\nHost: h`,
      ],
      [
        "an item cut by a line break",
        `Set-Cookie${GAP}: ["${SESSION}\\\nb]\nHost: h`,
        `Set-Cookie${GAP}: [redacted]\nHost: h`,
      ],
      [
        "an item after an item cut by a line break",
        `Set-Cookie${GAP}: ["${SESSION}\\\n"x[y"]\nHost: h`,
        `Set-Cookie${GAP}: [redacted]\nHost: h`,
      ],
      [
        "an apostrophe in a list that is not an item's quote",
        `Set-Cookie${GAP}: [it's x] ${SESSION}\nmore\nlines`,
        `Set-Cookie${GAP}: [redacted]\nmore\nlines`,
      ],
      [
        "a key quoted behind 31 backslashes",
        `${"\\".repeat(31)}"cookie${"\\".repeat(31)}"${GAP}: sid=${SESSION}`,
        `${"\\".repeat(31)}"cookie${"\\".repeat(31)}"${GAP}: [redacted]`,
      ],
      // A new marker takes the value's quotes with it: kept, they would not read back the same.
      ["a quoted key's quoted value", `"cookie"${GAP}:"${SESSION}"`, `"cookie"${GAP}:[redacted]`],
      // An even run before a quote escapes backslashes, not the quote: the value closes there and
      // the next field stays.
      [
        "a quoted value that ends in escaped backslashes",
        jsonOf(`"cookie"${GAP}:'${SESSION}\\\\',"safe":"SAFE"}`),
        String.raw`"\"cookie\"${GAP}:[redacted],\"safe\":\"SAFE\"}"`,
      ],
    ])("reads %s where only the reader sees the header", (_label, text, expected) => {
      const redacted = redactSecretLike(text);

      expect(redacted).toBe(expected);
      expect(redacted).not.toContain(SESSION);
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    // Each row tells one of the reader's rules apart from a near miss: where a frame closes, what
    // ends a quoted key's value, and what the reader remembers between headers.
    it.each([
      // A leading quote opens the value before the frame test: as the frame's close it would end it.
      ["a quote that opens a value", `'Cookie${GAP}: ' sid=SEKRIT'`, `'Cookie${GAP}: [redacted]`],
      // A new marker drops the value's quotes; kept, `"[redacted] "` would read back as less.
      ["a quoted key's value that a blank closes", `cookie":""r "`, `cookie":[redacted]`],
      ["a quoted key's list before a `)`", `"cookie":[])tail`, `"cookie":[redacted])tail`],
      ["a close quote before a backtick", "'Cookie: a'`tail", "'Cookie: [redacted]'`tail"],
      ["a close quote before an escaped tab", "'Cookie: a'\\ttail", "'Cookie: [redacted]'\\ttail"],
      ["a close quote at the end of the text", "'Cookie:a=b'", "'Cookie:[redacted]'"],
      [
        "a quote that opens a tuple item",
        `{"msg": "('Set-Cookie: a', 'keep=1')"}`,
        `{"msg": "('Set-Cookie: [redacted]', 'keep=1')"}`,
      ],
      // After a marker, the quote that follows it closes nothing new: `]` opens no string.
      [
        "a quote after a marker",
        '"Cookie:\'"{"`cOOkie:x"',
        '"Cookie:[redacted]"`cOOkie:[redacted]',
      ],
      // Five backslashes are no JSON depth, so the key's frame is raw and `\\"` does not close it.
      [
        "a key behind a run that is no depth",
        `"cookie${"\\".repeat(5)}"${GAP}: sid=SEKRIT\\\\" tail`,
        `"cookie${"\\".repeat(5)}"${GAP}: [redacted]`,
      ],
      [
        "a key quoted behind 63 backslashes",
        `${"\\".repeat(63)}"cookie${"\\".repeat(63)}"${GAP}: sid=SEKRIT`,
        `${"\\".repeat(63)}"cookie${"\\".repeat(63)}"${GAP}: [redacted]`,
      ],
      [
        "an escaped bracket at a value's start",
        `Cookie${GAP}: \\[a] sid=SEKRIT\nHost: h`,
        `Cookie${GAP}: [redacted]\nHost: h`,
      ],
      // A header's end clears the frame read before it: `)` keeps a hint, not the key's quote.
      [
        "a header after a quoted key's value and a `)`",
        `x 'cookie'${GAP}: 'a') Cookie: SEKRIT' keep`,
        `x 'cookie'${GAP}: [redacted]) Cookie: [redacted]`,
      ],
      // The key's own quotes close the string they open, so no string is open at the escaped tab.
      [
        "a quoted key before an escaped tab",
        `"cookie"\\tCookie:\\nsid=SEKRIT`,
        `"cookie"\\tCookie:[redacted]`,
      ],
      ["a tab after the colon", "Cookie:\ta'b", "Cookie:\t[redacted]"],
      // Blanks before the `,` after a quoted key's value still end it there.
      [
        "a quoted key's value before a blank and a comma",
        `{"cookie": "a" , "host": "h"}`,
        `{"cookie": "[redacted]" , "host": "h"}`,
      ],
      // A quote right after `[` opens an item: read as content, its `]` would end the list early.
      [
        "an item quote right after a nested list's bracket",
        `{"set-cookie"${GAP}: [["a]b"], "SEKRIT"], "host": "h"}`,
        `{"set-cookie"${GAP}: [redacted], "host": "h"}`,
      ],
      // An escaped comma starts no item, so the quote after it is content and its `]` ends the list.
      [
        "a quote after an escaped comma in a list",
        `{"set-cookie"${GAP}:[a\\,"x]y","SEKRIT"]}`,
        `{"set-cookie"${GAP}:[redacted]`,
      ],
      // A curl trace or a Markdown list between a string's quote and the name keeps the string.
      ["a trace marker inside a string", `"> Cookie: a" keep`, `"> Cookie: [redacted]" keep`],
      [
        "list and emphasis markers inside a string",
        `"1. **Cookie: a" keep`,
        `"1. **Cookie: [redacted]" keep`,
      ],
      // Markers count from the string's quote: blanks before the quote do not use them up.
      [
        "an indented string with blanks before the name",
        `${" ".repeat(16)}"  Cookie: a" keep`,
        `${" ".repeat(16)}"  Cookie: [redacted]" keep`,
      ],
      [
        "a trace's `<` inside a string",
        `"< Set-Cookie: a" keep`,
        `"< Set-Cookie: [redacted]" keep`,
      ],
      ["a list dash inside a string", `"- Cookie: a" keep`, `"- Cookie: [redacted]" keep`],
      ["a code span inside a string", '"`Cookie: a`" keep', '"`Cookie: [redacted]" keep'],
      // Any other escape before the name ends the string's hint: the value runs to the raw end.
      [
        "an escaped letter before the name",
        String.raw`"\Cookie: a" keep`,
        String.raw`"\Cookie: [redacted]`,
      ],
      // An escaped backslash before the close quote leaves the quote unescaped: it closes the string.
      [
        "a value that ends in an escaped backslash",
        jsonOf({ o: `Cookie${GAP}: a\\`, p: "keep" }),
        `{"o":"Cookie${GAP}: [redacted]","p":"keep"}`,
      ],
      // An escape after a close quote that is no line break or tab is inside the value.
      [
        "a quote before another escape",
        String.raw`echo 'Cookie${GAP}: a'\x sid=SEKRIT`,
        `echo 'Cookie${GAP}: [redacted]`,
      ],
      // An escaped tab is content: it ends no string.
      [
        "an escaped tab inside a value",
        jsonOf({ o: `Cookie${GAP}: a\tsid=SEKRIT`, p: 1 }),
        `{"o":"Cookie${GAP}: [redacted]","p":1}`,
      ],
      // A quote right after a comma opens an item, so the `]` inside it does not end the list.
      [
        "an item right after a comma",
        `{"set-cookie"${GAP}:["a","b]c","SEKRIT"],"host":"h"}`,
        `{"set-cookie"${GAP}:[redacted],"host":"h"}`,
      ],
      // Only spaces and tabs are skipped before the syntax that ends a quoted key's value.
      [
        "a form feed after a quoted key's value",
        `{"cookie": "a"\f; sid=SEKRIT}`,
        `{"cookie": [redacted]`,
      ],
      // Blanks after the value stay, so the marker reads back alone.
      ["blanks after a value", `Cookie: a"  \nHost: h`, `Cookie: [redacted]  \nHost: h`],
    ])("reads %s", (_label, text, expected) => {
      const redacted = redactSecretLike(text);

      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("SEKRIT");
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    // The reader runs on what the regex pass left, so a header the regex ended early can no longer
    // carry the next one away (the reader's frame ran from an escaped key to the next key's quote),
    // and a second pass changes nothing.
    it.each([
      [
        "a JSON string with a cookie key before a headers object",
        String.raw`s = "{\"cookie\": 1}"; h = {"cookie": "sid=SEKRIT"}`,
        String.raw`s = "{\"cookie\": [redacted]": "[redacted]"}`,
      ],
      [
        "a null cookie key before a headers object",
        String.raw`body = "{\"cookie\": null}"; headers = {"Cookie": "sid=SEKRIT"}`,
        String.raw`body = "{\"cookie\": [redacted]": "[redacted]"}`,
      ],
      [
        "two declarations",
        String.raw`const a = "{\"cookie\": 1}"; const b = {"set-cookie": "sid=SEKRIT"};`,
        String.raw`const a = "{\"cookie\": [redacted]": "[redacted]"};`,
      ],
      [
        "a quoted name after a list",
        "'Cookie: [a] Cookie': sid=SEKRIT",
        "'Cookie: [redacted]': [redacted]",
      ],
      [
        "an escaped key before a quoted name",
        String.raw`{\"Cookie\": a "Set-Cookie": sid=SEKRIT`,
        String.raw`{\"Cookie\": [redacted]": [redacted]`,
      ],
      [
        "an escaped key with two quoted values",
        String.raw`{\"cookie\": "a" "x": 1}`,
        String.raw`{\"cookie\": [redacted]": 1}`,
      ],
      [
        "an escaped key before a quoted cookie key",
        String.raw`\"cookie\": "a" "Cookie": sid=SEKRIT`,
        String.raw`\"cookie\": [redacted]": [redacted]`,
      ],
      // The regex leaves `"[redacted]` open; the reader takes the open quote with it.
      ["an unclosed quoted key value", `{"cookie": "sid=SEKRIT`, '{"cookie": [redacted]'],
    ])("redacts %s and reads the result back unchanged", (_label, text, expected) => {
      const redacted = redactSecretLike(text);

      expect(redacted).toBe(expected);
      expect(redacted).not.toContain("SEKRIT");
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    // As the regex pass does, an empty value is redacted, and the write guard refuses a note that
    // quotes an empty header, as main's does.
    it.each([
      ["an empty header", "Cookie:\nHost: example.com", "Cookie:[redacted]\nHost: example.com"],
      [
        "an empty header with a gap",
        "Cookie:   \nHost: example.com",
        "Cookie:   [redacted]\nHost: example.com",
      ],
      ["an empty quoted value", '{"cookie": "", "a": 1}', '{"cookie": "[redacted]", "a": 1}'],
    ])("redacts %s as the regex pass does", (_label, text, expected) => {
      expect(redactSecretLike(text)).toBe(expected);
      expect(redactSecretLike(expected)).toBe(expected);
      expect(addsSecretLike("", text)).toBe(true);
    });

    // Five more layers of JSON escape a key's quote with 31 backslashes, the most a key may have.
    it("redacts a quoted key five strings deep", () => {
      let text = jsonOf({ cookie: `sid=${SESSION}`, host: "h" });
      for (let layer = 0; layer < 5; layer++) text = jsonOf({ o: text });
      expect(text).toContain(`${"\\".repeat(31)}"cookie${"\\".repeat(31)}"`);
      const redacted = redactSecretLike(text);

      expect(redacted).toContain("[redacted]");
      expect(redacted).not.toContain(SESSION);
      expect(redactSecretLike(redacted)).toBe(redacted);
    });

    // A marker inside quotes covers only what it replaced: a cookie pair after it in the same quoted
    // value is a credential an earlier pass missed (partially sanitized output).
    it.each([
      ["a JSON key", `{"cookie":"[redacted]; sid=${SESSION}"}`, '{"cookie":"[redacted]"}'],
      [
        "a quoted command header",
        `curl -H 'Cookie: "[redacted]; b=2"' https://example.com`,
        "curl -H 'Cookie: [redacted]' https://example.com",
      ],
    ])("redacts a cookie pair after the marker in %s", (_label, text, expected) => {
      expect(redactSecretLike(text)).toBe(expected);
      expect(redactSecretLike(expected)).toBe(expected);
    });

    // What this rule writes, read back (the model's own notes quote what it read), stays as it is.
    // The write guard still refuses it in a text that did not hold it, as main's guard does: the
    // regex pass reports the marker it puts back.
    it.each([
      ["a header", "Cookie: [redacted]\nHost: example.com"],
      ["a quoted value", '{"cookie": "[redacted]", "a": 1}'],
      ["a list", '{"set-cookie": [redacted], "a": 1}'],
      ["Go's map print", "map[Accept:[*/*] Cookie:[redacted]"],
      ["a header with blanks after the marker", "Cookie: [redacted] \nHost: example.com"],
      // At the end of the text or a line, a quoted key's marker value ends where it closes.
      ["a quoted key's value at the end of the text", '"cookie": "[redacted]"'],
      ["a quoted key's value at the end of a line", '"cookie": "[redacted]"\nHost: h'],
    ])("leaves %s that is already redacted as it is", (_label, text) => {
      expect(redactSecretLike(text)).toBe(text);
      expect(containsSecretLike(text)).toBe(false);
      expect(addsSecretLike("", text)).toBe(true);
      expect(addsSecretLike(text, text)).toBe(false);
    });

    it.each([
      ["another key at the start of the text", "X: 1"],
      ["a header name after a dash", "X-Cookie: docs"],
      // Only the reader sees this header, and its marker value is no value to report.
      ["a marker that only the reader reads", `Cookie${" ".repeat(49)}: [redacted]`],
      ["a name inside a word at the start of the text", "xCookie: 1"],
      ["a color code's letters without its escape", "Cookie x1b[0m: 1"],
    ])("leaves %s as it is", (_label, text) => {
      expect(redactSecretLike(text)).toBe(text);
      expect(containsSecretLike(text)).toBe(false);
      expect(addsSecretLike("", text)).toBe(false);
    });
  });

  // The policy name is not a secret, and a note about the policy must stay writable: the
  // memory-write guard reuses this detector, as it does for `AccountName`.
  it("redacts a connection string's key and keeps its endpoint and policy name readable", () => {
    const text = `${SERVICE_BUS};SharedAccessKey=${FAKE.sharedAccessKey};EntityPath=orders`;

    expect(redactSecretLike(text)).toBe(
      `${SERVICE_BUS};SharedAccessKey=[redacted];EntityPath=orders`
    );
  });

  it("leaves a note about a shared access policy readable", () => {
    const text = [
      `The bus is reached with ${SERVICE_BUS}; the key is in the vault.`,
      "Rotate the shared access key every quarter: SharedAccessKeyName stays the same.",
      "Each SharedAccessKey is scoped to one namespace.",
      "shared_access_key_name=RootManageSharedAccessKey, shared-access-key-name: RootManageSharedAccessKey",
    ].join("\n");
    expect(redactSecretLike(text)).toBe(text);
  });

  it("leaves ordinary text and token counts readable", () => {
    const text =
      "max_tokens: 4096, input_tokens=120, ran 3 tests in the task-runner, name: demo, bearer scheme, account name";
    expect(redactSecretLike(text)).toBe(text);
  });

  it("leaves URLs without a password, SSH remotes, npm variable names and index lookups readable", () => {
    const text = [
      "https://user@example.com/path and http://localhost:8080/api@v2",
      "git@github.com:org/repo.git",
      "npm_config_cache and npm_package_version",
      "seen[token] = true; tokens[id] = 1",
      "pk_live_publishable and sk_live_ is a prefix",
    ].join("\n");
    expect(redactSecretLike(text)).toBe(text);
  });

  it("redacts only a signature's value and keeps the rest of the URL readable", () => {
    expect(
      redactSecretLike(
        "https://h.example.com/p?sv=1&sig=abc%2Bdef%3D&sp=r#frag (see ?signature=x1)"
      )
    ).toBe("https://h.example.com/p?sv=1&sig=[redacted]&sp=r#frag (see ?signature=[redacted])");
  });

  // The harvest renderer and the guard run redaction over text that may hold the marker already. The
  // value pattern stops before `]`: on the marker an earlier pass wrote, it read `[redacted` and wrote
  // `[redacted]]`, one more `]` on every pass. The output no longer grows that `]`, and every shape
  // below is stable on a second pass. Such a match is still reported to the write guard, as on main,
  // so the guard refuses all of these: what stays readable behind the marker (`SEKRIT`) is a credential
  // the redaction did not reach. Other second-pass changes (a key next to a marker) are main's.
  it.each([
    // Every value goes once, and the output is stable.
    ["a request line", "GET /x?a=1&sig=SEKRIT2 HTTP/1.1", "GET /x?a=1&sig=[redacted] HTTP/1.1"],
    [
      "a JSON string",
      '{"u": "https://h/p?X-Amz-Signature=SEKRIT4"}',
      '{"u": "https://h/p?X-Amz-Signature=[redacted]"}',
    ],
    ["a bare parameter", "?sig=SEKRIT", "?sig=[redacted]"],
    ["an XML-escaped ampersand", "?a=1&amp;signature=SEKRIT", "?a=1&amp;signature=[redacted]"],
    ["a Google signature", "?X-Goog-Signature=SEKRIT", "?X-Goog-Signature=[redacted]"],
    ["a value that an earlier pass redacted", "?sig=sk-ABCDEFGHIJKLMNOP", "?sig=[redacted]"],
    ["a signature in square brackets", "[https://h/p?sig=SEKRIT]", "[https://h/p?sig=[redacted]]"],
    [
      "a signature in parentheses",
      "(see https://h/p?sig=SEKRIT)",
      "(see https://h/p?sig=[redacted])",
    ],
    // The marker is the head of the value: the passes read it as on main, and the output does not
    // take the `]` that main wrote after it.
    ["a value that is the marker already", "?sig=[redacted]", "?sig=[redacted]"],
    ["a marker and a bracket", "?sig=[redacted]]", "?sig=[redacted]]"],
    ["a value behind the marker", "?sig=[redacted]SEKRIT", "?sig=[redacted]SEKRIT"],
    ["a value behind an upper-case marker", "?sig=[REDACTED]x", "?sig=[redacted]x"],
    [
      "a semicolon and a value behind the marker",
      "https://x/?sig=[redacted];SEKRIT",
      "https://x/?sig=[redacted];SEKRIT",
    ],
    [
      "a PHP-escaped slash behind the head of a value",
      String.raw`https:\/\/h\/p?signature=k\/SEKRITREST`,
      String.raw`https:\/\/h\/p?signature=[redacted]\/SEKRITREST`,
    ],
    [
      "an HTML entity behind the head of a value",
      "https://h/p?sig=k&#43;SEKRITREST",
      "https://h/p?sig=[redacted]&#43;SEKRITREST",
    ],
    [
      "a key's marker with a tail, as the harvest renderer shows it",
      "https://acct.blob.core.windows.net/c/b?sv=1&sig=sk-ABCDEFGHIJKL%2BSEKRITTAIL%3D",
      "https://acct.blob.core.windows.net/c/b?sv=1&sig=[redacted]%2BSEKRITTAIL%3D",
    ],
  ])(
    "redacts a signed URL's signature once, and the guard refuses it: %s",
    (_label, text, expected) => {
      const redacted = redactSecretLike(text);
      expect(redacted).toBe(expected);
      expect(redactSecretLike(redacted)).toBe(redacted);
      // The text as given, and as the harvest renderer shows it back to a model that writes it down.
      for (const written of [text, redacted]) {
        expect(containsSecretLike(written)).toBe(true);
        expect(addsSecretLike("", written)).toBe(true);
      }
    }
  );

  // The collapse follows the `]` that main's passes add through the passes after the signed-URL
  // pattern, and takes out only that one: a `]` the text had after a marker stays.
  it("leaves a `]` after a marker that no signed-URL match wrote", () => {
    const text = "user text [[redacted]] and [redacted]] keep";
    expect(redactSecretLike(text)).toBe(text);
    expect(redactSecretLike("x ?sig=[redacted]] y [redacted]]")).toBe(
      "x ?sig=[redacted]] y [redacted]]"
    );
  });

  // A header that only the cookie reader detects reads on past a `]`, so the reader still sees the
  // extra `]` that the signed-URL pattern wrote, as on main: the redaction hides `SEKRIT` too, and
  // the guard judges an edit of the tail as main's does.
  it.each([
    String.raw`a\tcookie": [?sig=sk-ABCDEFGHIJKLMNOP x], SEKRIT`,
    String.raw`a\tcookie": [?sig=[redacted] x], SEKRIT`,
  ])("hides a tail that the reader reads on past a marker: %s", (text) => {
    const redacted = redactSecretLike(text);
    expect(redacted).not.toContain("SEKRIT");
    expect(redactSecretLike(redacted)).toBe(redacted);
  });

  it.each([
    ['password="?sig=[redacted]"\n?sig=SEKRIT', 'password="?sig=SEKRIT"'],
    [
      String.raw`a\tcookie": [?sig=[redacted] x], AAA`,
      String.raw`a\tcookie": [?sig=[redacted] x], SEKRIT`,
    ],
  ])("judges an edit as main's guard does: %j then %j", (previous, updated) => {
    expect(addsSecretLike(previous, updated)).toBe(true);
  });

  // The `]` that a signed-URL match adds is followed through every pass after it. Each shape puts the
  // edit of another pass in front of it, behind it, or right up to it. A position that a pass moved
  // without reporting it deletes some other character, which these exact outputs show. `removeAt`
  // asserts only when that character is no `]` with a `]` behind it. The last shape ends in `]]`,
  // so a stale position that lands there is deleted without an assertion: only the output tells.
  it.each([
    [
      "a key's value in front",
      "password=hunter2 &sig=sk-ABCDEFGHIJKLMNOP",
      "password=[redacted] &sig=[redacted]",
    ],
    [
      "a key's value behind",
      "?sig=sk-ABCDEFGHIJKLMNOP password=hunter2",
      "?sig=[redacted] password=[redacted]",
    ],
    ["a key's value that ends at it", "password=?sig=sk-ABCDEFGHIJKLMNOP", "password=[redacted]]"],
    [
      "a key's value that takes the first of two",
      "token=?sig=sk-ABCDEFGHIJKLMNOP ?sig=sk-QRSTUVWXYZABCDEF",
      "token=[redacted]] ?sig=[redacted]",
    ],
    [
      "a JWT in front",
      "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0 &sig=sk-ABCDEFGHIJKLMNOP",
      "[redacted] &sig=[redacted]",
    ],
    [
      "a signature in front, from the same pattern",
      "?sig=abcdefg &sig=sk-ABCDEFGHIJKLMNOP",
      "?sig=[redacted] &sig=[redacted]",
    ],
    [
      "a signature behind, from the same pattern",
      "?sig=sk-ABCDEFGHIJKLMNOP &sig=abcdefg",
      "?sig=[redacted] &sig=[redacted]",
    ],
    [
      "two markers",
      "?sig=sk-ABCDEFGHIJKLMNOP ?sig=sk-QRSTUVWXYZABCDEF",
      "?sig=[redacted] ?sig=[redacted]",
    ],
    [
      "a header in front that only the reader reads",
      String.raw`a\tCookie: v1` + "\n?sig=sk-ABCDEFGHIJKLMNOP",
      String.raw`a\tCookie: [redacted]` + "\n?sig=[redacted]",
    ],
    [
      "a header behind that only the reader reads",
      "?sig=sk-ABCDEFGHIJKLMNOP\n" + String.raw`a\tCookie: v1`,
      "?sig=[redacted]\n" + String.raw`a\tCookie: [redacted]`,
    ],
    [
      "a reader's header in front, and a `]]` at the end of the text",
      String.raw`a\tCookie: XXXXXXXXXXXXX` + "\n?sig=[redacted]x]]",
      String.raw`a\tCookie: [redacted]` + "\n?sig=[redacted]x]]",
    ],
  ])("follows the added bracket past another pass: %s", (_label, text, expected) => {
    const redacted = redactSecretLike(text);
    expect(redacted).toBe(expected);
    expect(redactSecretLike(redacted)).toBe(redacted);
  });

  // Only the marker's own head is read back as the marker. A value that merely starts or ends like it
  // is a value: its `]` stays as on main, and no tracked bracket is taken out.
  it.each([
    ["a value that goes on after the head", "?sig=[redactedX]", "?sig=[redacted]]"],
    ["a value that has the head at its end", "?sig=abc[redacted]", "?sig=[redacted]]"],
    ["a value that has the head in the middle", "?sig=abc[redactedX]", "?sig=[redacted]]"],
  ])(
    "leaves the bracket of a value that is not the marker's head: %s",
    (_label, text, expected) => {
      expect(redactSecretLike(text)).toBe(expected);
      expect(redactSecretLike(expected)).toBe(expected);
    }
  );

  // A half marker is not the marker: a value that merely starts like it is still a value.
  it("redacts a signature value that starts like the marker but is not it", () => {
    expect(redactSecretLike("?sig=[redacted")).toBe("?sig=[redacted]");
    expect(redactSecretLike("?sig=[redactedSEKRIT")).toBe("?sig=[redacted]");
  });

  // `signature` is not a secret name: the memory-write guard reuses this detector, and a note
  // about a function signature or a signed commit must stay writable.
  it("leaves a signature or sig that is not a URL query parameter readable", () => {
    const text = [
      "signature: foo(a, b)",
      "def verify(signature=None, sig=b'')",
      "sig: 12 bytes, signature = checked",
      "git commit --signature=abc123",
      "see the signature=value form in the docs",
      "https://h.example.com/p?design=1&signed=yes&sigma=3",
    ].join("\n");
    expect(redactSecretLike(text)).toBe(text);
  });

  it("keeps the userinfo's host readable", () => {
    expect(redactSecretLike("https://deploy:pw@git.example.com/org/repo")).toBe(
      "https://[redacted]@git.example.com/org/repo"
    );
  });

  // The guard scans text a model supplied, so a hostile 100 KB write must not stall the process.
  // Each shape repeats a keyword with nothing after it, which made the open-ended name suffix and
  // JWT segment rescan to the end of the text from every occurrence (seconds per input).
  it.each([
    ["token", "token".repeat(20_000)],
    ["secret-", "secret-".repeat(14_000)],
    ["authorization", "authorization".repeat(7_700)],
    ["credential_", "credential_".repeat(9_000)],
    ["api_key", "api_key".repeat(14_000)],
    ["a JWT header after a dash", "eyJ-".repeat(25_000)],
    ["a bare bracket assignment", 'password"]'.repeat(10_000)],
    ["URL schemes with a short userinfo", "://a:".repeat(25_000)],
    ["a keyword followed by whitespace", `token${" ".repeat(100_000)}x`],
    ["account_key", "account_key".repeat(9_000)],
    ["SharedAccessKey", "SharedAccessKey".repeat(6_600)],
    ["shared_access_key_", "shared_access_key_".repeat(5_600)],
    ["SharedAccessKeyName", "SharedAccessKeyName".repeat(5_200)],
    ["bearer", "bearer".repeat(16_000)],
    ["a PGP key header", "-----BEGIN PGP PRIVATE KEY BLOCK-----".repeat(3_000)],
    ["a quoted value of backslashes", `token:"${"\\".repeat(100_000)}`],
    ["a quoted value of escaped quotes", `token:"${'\\"'.repeat(50_000)}`],
    [
      "an escaped quoted value of backslash runs",
      String.raw`token:\"` + String.raw`\\\"`.repeat(25_000),
    ],
    ["a quoted value that ends in a backslash run", `token:"a${"\\".repeat(100_000)}`],
    ["many opening quotes", 'token:"a'.repeat(12_000)],
    ["a key followed by a long backslash run", `token${"\\".repeat(100_000)}"`],
    ["a value opened by a long backslash run", `token:${"\\".repeat(100_000)}"a`],
    [
      "a deep value of one long backslash run",
      `token:${"\\".repeat(31)}"a${"\\".repeat(100_000)}"`,
    ],
    [
      "a deep value of runs as long as its opener",
      `token:${"\\".repeat(31)}"${`${"\\".repeat(31)}x`.repeat(3_000)}`,
    ],
    [
      "a deep value of runs just short of a doubled close",
      `token:${"\\".repeat(31)}"${`${"\\".repeat(62)}x`.repeat(1_500)}`,
    ],
    ["many deep openers", `token:${"\\".repeat(31)}"a`.repeat(2_500)],
    ["many deep keys", `token${"\\".repeat(31)}"`.repeat(2_800)],
    ["a signature parameter with a long value", `?sig=${"a".repeat(100_000)}`],
    ["signature parameters with no value", "?sig=&signature=".repeat(20_000)],
    ["a signature name with no equals sign", "&X-Amz-Signature".repeat(20_000)],
    ["stacked signature prefixes", "?&amp;sig=".repeat(20_000)],
    ["a cookie name with no colon", "Cookie".repeat(20_000)],
    ["a cookie name and gap with no colon", `Set-Cookie${" ".repeat(100_000)}x`],
    ["cookie names with a colon and no value", "Cookie:".repeat(20_000)],
    ["cookie headers on one line", "Set-Cookie: a=b; ".repeat(10_000)],
    ["a cookie value of backslashes", `Cookie: ${"\\".repeat(100_000)}x`],
    ["a cookie value of escaped quotes", `Cookie: "${'\\"'.repeat(50_000)}`],
    ["a cookie key followed by a long backslash run", `cookie${"\\".repeat(100_000)}"x`],
    ["many cookie keys with a long backslash run", `cookie${"\\".repeat(31)}"`.repeat(2_800)],
    ["cookie array openers with no close", `Cookie:[`.repeat(25_000)],
    ["cookie names after escaped line breaks", String.raw`\nCookie`.repeat(15_000)],
    ["a cookie colon and a long gap with no value", `Cookie:${" ".repeat(100_000)}`],
    ["cookie colons and a gap with no value, line after line", "Cookie: \n".repeat(15_000)],
    [
      "cookie names behind an indent that is no line start",
      `${" ".repeat(16)}Cookie`.repeat(5_900),
    ],
    ["cookie names behind an indent and a marker", `\n${" ".repeat(16)}> Cookie`.repeat(5_000)],
    ["cookie values that open with a redacted marker", 'Cookie: "[redacted]\n'.repeat(7_000)],
    [
      "cookie values that open with a long gap and a marker",
      `Cookie:${" ".repeat(40)}[redacted]\n`.repeat(2_500),
    ],
    ["cookie names behind quotes and commas", `,Cookie`.repeat(14_000)],
    ["unclosed quoted cookie list items", 'Cookie:["'.repeat(14_000)],
    ["quoted cookie keys each followed by a value", '"cookie":"a"'.repeat(10_000)],
    [
      "cookie names behind escaped breaks of long runs",
      `\\n${"\\".repeat(31)}nCookie`.repeat(2_500),
    ],
    ["nested cookie list openers", `${"Cookie: [".repeat(10_000)}]`],
  ])("scans %s in linear time", (_label, text) => {
    redactSecretLike("warm up token: abc"); // keep a cold regex compile out of the timing
    // Each scan gets the whole budget: `containsSecretLike` is a second pass of the same redaction,
    // and with the cookie rule a pass costs about half of it, so one budget for both flaked.
    for (const scan of [redactSecretLike, containsSecretLike]) {
      const started = performance.now();
      scan(text);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});

describe("redactWithinCap", () => {
  const CAP = 100;
  const KEY = `ghp_${"a1B2".repeat(5)}`;

  it("cuts text without a secret where redaction alone would, and reads the lookahead for none", () => {
    const text = "lorem ".repeat(300);
    expect(redactWithinCap(text, CAP)).toBe(text.slice(0, CAP));
  });

  it("returns the whole redaction of a text that fits under the cap", () => {
    expect(redactWithinCap(`a ${KEY} b`, CAP)).toBe("a [redacted] b");
  });

  it("takes a secret that starts the text and crosses the cap whole", () => {
    expect(redactWithinCap(`${KEY} tail`, 10)).toBe("[redacted]");
  });

  it("takes a secret that crosses the cap whole, and shows no part of it", () => {
    const text = `${"x".repeat(CAP - 11)} ${KEY} tail`;
    expect(redactWithinCap(text, CAP)).toBe(`${"x".repeat(CAP - 11)} [redacted]`);
  });

  // A value that redaction shortens must not let what lies past the cap into the output.
  it("shows no text from past the cap when redaction shortens the text before it", () => {
    expect(redactWithinCap(`password=${"z".repeat(300)} visible beyond the cap`, 50)).toBe(
      "password=[redacted]"
    );
  });

  // The window is the cap and its lookahead. Its end can cut a key: what is left is too short to
  // match, so it shows as it is. Redaction shortens the window, so a cut of the output at the cap
  // reached it.
  it("shows nothing of the lookahead's end when redaction shortens the text by more than it", () => {
    const window = `password=${"z".repeat(CAP + 512 - 21)} sk-QBNDZ8P3`;
    expect(window).toHaveLength(CAP + 512);
    expect(redactWithinCap(window, CAP)).toBe("password=[redacted]");
  });

  it("keeps a pair whose value goes past the cap redacted whole", () => {
    const text = `password=${"z".repeat(600)}`;
    expect(redactWithinCap(text, CAP)).toBe("password=[redacted]");
  });
});

describe("containsSecretLike", () => {
  it("flags a credential shape and passes ordinary prose about tokens", () => {
    expect(containsSecretLike("DB_PASSWORD=hunter2 npm start")).toBe(true);
    expect(containsSecretLike(`key sk-${"k3J9".repeat(6)}`)).toBe(true);
    expect(containsSecretLike("The token budget resets each turn; max_tokens: 4096.")).toBe(false);
    expect(containsSecretLike("Auth uses a password manager and a bearer scheme.")).toBe(false);
  });

  // The passes still write `[redacted]]` after the head of a marker, and only the output drops that
  // `]`, so the verdict is main's. A marker that the cookie rule puts back stays unflagged.
  it("flags a marker that the signed-URL pattern reads", () => {
    expect(containsSecretLike("?sig=[redacted]")).toBe(true);
    expect(containsSecretLike("?sig=[redacted]]")).toBe(true);
    expect(containsSecretLike("Cookie: [redacted]")).toBe(false);
  });
});

describe("addsSecretLike", () => {
  const KEY = "sk-ABCDEFGHIJKLMNO";

  // The guard refuses at least what main's refuses: the regex passes report each value they take out
  // as main's do, and a value the cookie reader takes out of the previous text excuses none of
  // theirs. Expected values are main's, except where the reader adds a refusal.
  it.each([
    ["", "Cookie:", true],
    ["", "cookie:", true],
    ["'`", "cookie:", true],
    ["", "Cookie: \nnext", true],
    ["", "Cookie: [redacted]", true],
    ["notes\n", '{"cookie": ""}', true],
    ["Cookie: a\n", "Cookie: [redacted]\n", true],
    ["Cookie:\n", "Cookie:", false],
    ["Cookie: [redacted]\n", "Cookie: [redacted]", false],
    ['{"cookie": "[redacted]"}', '{"cookie": "[redacted]"}', false],
    // Main misses the pair after its marker; the reader takes it out, so the guard refuses it.
    ["Cookie: [redacted]\n", "Cookie: [redacted]; sid=S\n", true],
  ])("judges %j then %j as main's guard does: %p", (previous, updated, expected) => {
    expect(addsSecretLike(previous, updated)).toBe(expected);
    expect(addsSecretLike(updated, updated)).toBe(false);
  });

  // The same value taken out by the other source excuses nothing. Only the reader sees a name behind
  // an escaped tab, and only the key/value regex sees `password:`; both take out `SEKRIT`.
  describe("keeps the regex passes' values apart from the reader's", () => {
    const byReader = String.raw`a\tCookie: SEKRIT`;
    const byRegex = "password: SEKRIT";

    it("refuses a value the regex takes out that the previous text held only by the reader", () => {
      // Main's guard refuses this too: its regex never read the previous text's header.
      expect(addsSecretLike(byReader, byRegex)).toBe(true);
    });

    it("refuses a value the reader takes out that the previous text held only by the regex", () => {
      expect(addsSecretLike(byRegex, byReader)).toBe(true);
    });

    it("refuses a second regex copy that only a reader copy could cover", () => {
      expect(addsSecretLike(`${byRegex}\n${byReader}`, `${byRegex}\n${byRegex}`)).toBe(true);
    });

    // Each regex pass reports as the regex: the cookie regex, a standalone pattern, the key/value
    // pattern. Main's guard refuses each of these too.
    it.each([
      ["the cookie regex", `Cookie${" ".repeat(49)}: SEKRIT`, "Cookie: SEKRIT"],
      ["a standalone pattern", byReader, "?sig=SEKRIT"],
      ["the key/value pattern", byReader, "token: SEKRIT"],
    ])(
      "refuses a value %s takes out that the previous text held only by the reader",
      (_label, previous, updated) => {
        expect(addsSecretLike(previous, updated)).toBe(true);
      }
    );

    it("refuses a second copy of a value only the reader takes out", () => {
      expect(addsSecretLike(byReader, `${byReader}\n${byReader}`)).toBe(true);
    });
  });

  // The guard counts each value as often as it occurs, and compares only what each pass takes out,
  // not the name before it, as main's does.
  describe("counts values as main's guard does", () => {
    it("passes a text that holds the same value twice against itself", () => {
      const twice = "password: SEKRIT\npassword: SEKRIT";
      expect(addsSecretLike(twice, twice)).toBe(false);
    });

    it.each([
      ["a cookie header renamed", "Cookie: SEKRIT", "Set-Cookie: SEKRIT"],
      ["a secret key renamed", "password: SEKRIT", "token: SEKRIT"],
    ])("passes %s that keeps its value", (_label, previous, updated) => {
      expect(addsSecretLike(previous, updated)).toBe(false);
    });
  });

  it("flags an edit that swaps one credential for another, which keeps their count", () => {
    expect(addsSecretLike(`password: old-secret\nsk-\nABCDEFGHIJKLMNO\n`, `${KEY}\n`)).toBe(true);
  });

  it("flags a credential swapped for another of the same shape", () => {
    expect(addsSecretLike("key sk-ABCDEFGHIJKLMNO\n", "key sk-PQRSTUVWXYZABCD\n")).toBe(true);
  });

  // A text that holds a tracked `]` reads its key/value pairs through another path: the guard must
  // still tell one value from another there.
  it("flags a key's value swapped for another beside a signed URL", () => {
    const signed = "&sig=sk-ABCDEFGHIJKLMNOP";
    expect(addsSecretLike(`password=hunter2 ${signed}`, `password=hunter3 ${signed}`)).toBe(true);
    expect(addsSecretLike(`password=hunter2 ${signed}`, `password=hunter2 ${signed}\n`)).toBe(
      false
    );
  });

  it("flags a second copy of a credential the file held once", () => {
    expect(addsSecretLike(`${KEY}\n`, `${KEY}\n${KEY}\n`)).toBe(true);
  });

  it("flags a changed cookie value, which the cookie pass reads before the others", () => {
    expect(addsSecretLike("Cookie: session=one\n", "Cookie: session=two\n")).toBe(true);
  });

  it("passes edits that keep, move or remove the credentials a file held", () => {
    const held = `notes\n${KEY}\nCookie: session=one\npassword: hunter2-correct-horse\n`;
    expect(addsSecretLike(held, held.replace("notes", "more notes"))).toBe(false);
    expect(
      addsSecretLike(held, `password: hunter2-correct-horse\nCookie: session=one\n${KEY}\n`)
    ).toBe(false);
    expect(addsSecretLike(held, "notes\n")).toBe(false);
    expect(addsSecretLike("", "notes about token budgets\n")).toBe(false);
  });

  it("flags an edit inside a matched value, the accepted false refusal", () => {
    expect(addsSecretLike('password: "old words"\n', 'password: "new words"\n')).toBe(true);
  });
});
