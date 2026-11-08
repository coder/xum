import { describe, expect, it } from "bun:test";

import { containsSecretLike, redactSecretLike } from "./memorySecretRedaction";

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
  // value of a `Cookie` / `Set-Cookie` header goes to the end of its line (a raw break, or the
  // escape of one in JSON text) or to the quote that ends it; the header name stays readable.
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
        String.raw`GET /\r\n  Cookie: sid=${SESSION}\r\nAccept: */*`,
        String.raw`GET /\r\n  Cookie: [redacted]\r\nAccept: */*`,
      ],
      [
        "a key of an object that a tool printed unquoted",
        `{ host: 'example.com', cookie: 'sid=${SESSION}', accept: '*/*' }`,
        "{ host: 'example.com', cookie: '[redacted]', accept: '*/*' }",
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
      [
        "Go's map print",
        `map[Accept:[*/*] Cookie:[a=${SESSION}]]`,
        "map[Accept:[*/*] Cookie:[redacted]]",
      ],
      [
        "Go's map print with a quoted value in the list",
        `map[Set-Cookie:[theme="dark"; Path=/ sid=${SESSION}]]`,
        "map[Set-Cookie:[redacted]]",
      ],
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

    // A marker inside quotes covers only what it replaced: a cookie pair after it in the same quoted
    // value is a credential an earlier pass missed (partially sanitized output).
    it.each([
      ["a JSON key", `{"cookie":"[redacted]; sid=${SESSION}"}`, '{"cookie":"[redacted]"}'],
      [
        "a quoted command header",
        `curl -H 'Cookie: "[redacted]; b=2"' https://example.com`,
        `curl -H 'Cookie: "[redacted]"' https://example.com`,
      ],
    ])("redacts a cookie pair after the marker in %s", (_label, text, expected) => {
      expect(redactSecretLike(text)).toBe(expected);
    });

    // What this rule writes, read back (the model's own notes quote what it read), is not a new
    // credential, as for the key/value rule: the write guard must accept it.
    it.each([
      ["a header", "Cookie: [redacted]\nHost: example.com"],
      ["a quoted value", '{"cookie": "[redacted]", "a": 1}'],
      ["a list", '{"set-cookie": [redacted], "a": 1}'],
      ["Go's map print", "map[Accept:[*/*] Cookie:[redacted]"],
      ["Go's map print closed after the marker", "map[Cookie:[redacted]]"],
    ])("leaves %s that is already redacted as it is", (_label, text) => {
      expect(redactSecretLike(text)).toBe(text);
      expect(containsSecretLike(text)).toBe(false);
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

describe("containsSecretLike", () => {
  it("flags a credential shape and passes ordinary prose about tokens", () => {
    expect(containsSecretLike("DB_PASSWORD=hunter2 npm start")).toBe(true);
    expect(containsSecretLike(`key sk-${"k3J9".repeat(6)}`)).toBe(true);
    expect(containsSecretLike("The token budget resets each turn; max_tokens: 4096.")).toBe(false);
    expect(containsSecretLike("Auth uses a password manager and a bearer scheme.")).toBe(false);
  });
});
