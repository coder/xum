import { describe, expect, test } from "bun:test";
import {
  MCPConnectionRefSchema,
  MCPServerIdentitySchema,
  MCPTestResultSchema,
  MCPToolCallDisplaySchema,
} from "@/common/orpc/schemas/mcp";
import type { MCPServerInfo, MCPServerIdentity } from "@/common/types/mcp";
import { MCP_IDENTITY_LIMITS } from "@/common/constants/mcpIdentity";
import { serverDisplayName } from "@/common/utils/mcp/serverDisplayName";
import {
  MCP_SERVER_INFO_META_KEY,
  buildToolCallDisplay,
  describeConnection,
  normalizeServerIdentity,
  takeStandardDisplayMeta,
} from "./mcpServerIdentity";

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** 3-byte UTF-8 BMP character: the densest byte/UTF-16-unit ratio a normalized field can reach. */
const CJK = "字";
const maxIdentity: MCPServerIdentity = {
  name: CJK.repeat(MCP_IDENTITY_LIMITS.nameMaxChars),
  version: CJK.repeat(MCP_IDENTITY_LIMITS.versionMaxChars),
  title: CJK.repeat(MCP_IDENTITY_LIMITS.titleMaxChars),
  description: CJK.repeat(MCP_IDENTITY_LIMITS.descriptionMaxChars),
  websiteUrl: `https://example.com/${"a".repeat(MCP_IDENTITY_LIMITS.websiteUrlMaxChars - 20)}`,
};
const maxOrigin = `https://${"a".repeat(MCP_IDENTITY_LIMITS.originMaxBytes - "https://".length - ":65535".length)}:65535`;
const maxConnection = {
  key: CJK.repeat(MCP_IDENTITY_LIMITS.connectionKeyMaxChars),
  transport: "http" as const,
  origin: maxOrigin,
};

describe("normalizeServerIdentity", () => {
  test("returns undefined for non-objects and missing/empty required fields", () => {
    for (const raw of [undefined, null, "notion", 42, [], true]) {
      expect(normalizeServerIdentity(raw)).toBeUndefined();
    }
    expect(normalizeServerIdentity({})).toBeUndefined();
    expect(normalizeServerIdentity({ name: "x" })).toBeUndefined();
    expect(normalizeServerIdentity({ version: "1" })).toBeUndefined();
    expect(normalizeServerIdentity({ name: "   ", version: "1" })).toBeUndefined();
    expect(normalizeServerIdentity({ name: "\u0000\u001f", version: "1" })).toBeUndefined();
    expect(normalizeServerIdentity({ name: "x", version: 1 })).toBeUndefined();
    expect(normalizeServerIdentity({ name: ["x"], version: "1" })).toBeUndefined();
  });

  test("never throws on hostile objects", () => {
    const hostile = {
      get name(): string {
        throw new Error("boom");
      },
      version: "1",
    };
    expect(normalizeServerIdentity(hostile)).toBeUndefined();
  });

  test("keeps a minimal identity and omits absent optional fields", () => {
    expect(normalizeServerIdentity({ name: "notion", version: "2.1.0" })).toStrictEqual({
      identity: { name: "notion", version: "2.1.0" },
      iconCandidates: [],
    });
  });

  test("strips controls, trims, collapses whitespace and truncates every text field", () => {
    const result = normalizeServerIdentity({
      name: `  \u0000No\ttion\u202e${"n".repeat(200)}  `,
      version: `1.0\u0007${"x".repeat(100)}`,
      title: `\u200fNotion\nMCP\u001b[31m`,
      description: `line one\r\nline two ${"d".repeat(400)}`,
    });
    expect(result).toBeDefined();
    const identity = result!.identity;
    expect(identity.name).toHaveLength(MCP_IDENTITY_LIMITS.nameMaxChars);
    expect(identity.name.startsWith("No tion")).toBe(true);
    expect(identity.version).toHaveLength(MCP_IDENTITY_LIMITS.versionMaxChars);
    expect(identity.version.startsWith("1.0 x")).toBe(true);
    expect(identity.title).toBe("Notion MCP [31m");
    expect(identity.description).toHaveLength(MCP_IDENTITY_LIMITS.descriptionMaxChars);
    expect(identity.description!.startsWith("line one line two d")).toBe(true);
    // Truncated values re-validate against the shared schema.
    expect(MCPServerIdentitySchema.safeParse(identity).success).toBe(true);
  });

  test("truncation never splits a surrogate pair", () => {
    const result = normalizeServerIdentity({ name: "😀".repeat(50), version: "1" });
    expect(result!.identity.name.length).toBeLessThanOrEqual(MCP_IDENTITY_LIMITS.nameMaxChars);
    // With the `u` flag, \p{Surrogate} matches only lone (unpaired) surrogates.
    expect(/\p{Surrogate}/u.test(result!.identity.name)).toBe(false);
    expect(result!.identity.name.endsWith("😀")).toBe(true);
  });

  test("drops empty or non-string optional fields without dropping the identity", () => {
    const result = normalizeServerIdentity({
      name: "n",
      version: "1",
      title: "   ",
      description: { text: "nope" },
      websiteUrl: 12,
    });
    expect(result!.identity).toStrictEqual({ name: "n", version: "1" });
  });

  test("keeps only credential-free https website URLs", () => {
    const keep = normalizeServerIdentity({
      name: "n",
      version: "1",
      websiteUrl: "  https://www.notion.so/product/ai  ",
    });
    expect(keep!.identity.websiteUrl).toBe("https://www.notion.so/product/ai");

    for (const websiteUrl of [
      "http://www.notion.so",
      "https://user:pw@www.notion.so",
      "javascript:alert(1)",
      "https://example.com/" + "p".repeat(MCP_IDENTITY_LIMITS.websiteUrlMaxChars),
      "www.notion.so",
    ]) {
      const dropped = normalizeServerIdentity({ name: "n", version: "1", websiteUrl });
      expect(dropped!.identity.websiteUrl).toBeUndefined();
    }
  });

  test("bounds icon candidates per source kind and keeps only display attributes", () => {
    const httpsSrc = "https://www.notion.so/icon.svg";
    const dataSrc = `data:image/png;base64,${"A".repeat(64)}`;
    const result = normalizeServerIdentity({
      name: "n",
      version: "1",
      icons: [
        { src: httpsSrc, mimeType: "image/svg+xml", sizes: ["any", 32, "48x48"], theme: "dark" },
        { src: dataSrc, theme: "sepia", mimeType: 7 },
        { src: "http://www.notion.so/icon.png" },
        { src: "https://user@www.notion.so/icon.png" },
        { src: `https://www.notion.so/${"i".repeat(MCP_IDENTITY_LIMITS.iconHttpsSrcMaxChars)}` },
        { src: `data:image/png;base64,${"A".repeat(MCP_IDENTITY_LIMITS.iconDataSrcMaxChars)}` },
        { src: "file:///etc/passwd" },
        { src: "javascript:alert(1)" },
        "https://www.notion.so/not-an-object.png",
        { mimeType: "image/png" },
        null,
      ],
    });
    expect(result!.iconCandidates).toStrictEqual([
      { src: httpsSrc, mimeType: "image/svg+xml", sizes: ["any", "48x48"], theme: "dark" },
      { src: dataSrc },
    ]);
  });

  test("keeps at most the first eight valid icon candidates and tolerates non-array icons", () => {
    const icons = Array.from({ length: 20 }, (_, i) => ({ src: `https://icons.example/${i}.png` }));
    const result = normalizeServerIdentity({ name: "n", version: "1", icons });
    expect(result!.iconCandidates.map((c) => c.src)).toStrictEqual(
      icons.slice(0, MCP_IDENTITY_LIMITS.iconCandidatesMax).map((c) => c.src)
    );
    expect(
      normalizeServerIdentity({ name: "n", version: "1", icons: "nope" })!.iconCandidates
    ).toStrictEqual([]);
  });
});

describe("serverDisplayName", () => {
  test("prefers the title and falls back to the name", () => {
    expect(serverDisplayName({ name: "notion-mcp", title: "Notion" })).toBe("Notion");
    expect(serverDisplayName({ name: "notion-mcp" })).toBe("notion-mcp");
  });
});

describe("describeConnection", () => {
  const stdio: MCPServerInfo = {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server", "--token", "ntn_secret"],
    env: { NOTION_TOKEN: "ntn_secret" },
    cwd: "/home/alice/project",
    disabled: false,
  };
  const http: MCPServerInfo = {
    transport: "http",
    url: "https://Alice:pw@mcp.notion.com:443/mcp/v1?api_key=secret#frag",
    headers: { Authorization: "Bearer secret" },
    disabled: false,
  };

  test("stdio connections carry only key and transport", () => {
    const ref = describeConnection("notion", stdio);
    expect(ref).toStrictEqual({ key: "notion", transport: "stdio" });
    expect(JSON.stringify(ref)).not.toContain("secret");
    expect(JSON.stringify(ref)).not.toContain("npx");
    expect(JSON.stringify(ref)).not.toContain("alice");
  });

  test("url connections carry only the https origin: no userinfo, path, query, headers or default port", () => {
    const ref = describeConnection("notion", http);
    expect(ref).toStrictEqual({
      key: "notion",
      transport: "http",
      origin: "https://mcp.notion.com",
    });
    expect(JSON.stringify(ref)).not.toContain("secret");
    expect(JSON.stringify(ref)).not.toContain("/mcp/v1");
    expect(JSON.stringify(ref)).not.toContain("api_key");
    expect(JSON.stringify(ref)).not.toContain("Alice");
    expect(describeConnection("s", { ...http, transport: "sse" })).toStrictEqual({
      key: "s",
      transport: "sse",
      origin: "https://mcp.notion.com",
    });
  });

  test("plain-http urls produce no origin", () => {
    expect(
      describeConnection("local", { ...http, url: "http://localhost:3000/mcp" })
    ).toStrictEqual({
      key: "local",
      transport: "http",
    });
  });

  test("auto transports report the actual negotiated transport, defaulting to http", () => {
    const auto: MCPServerInfo = { ...http, transport: "auto" };
    expect(describeConnection("a", auto, "sse").transport).toBe("sse");
    expect(describeConnection("a", auto, "http").transport).toBe("http");
    expect(describeConnection("a", auto).transport).toBe("http");
    // A stdio configuration cannot be relabeled by a caller-supplied transport,
    // and a url configuration never becomes stdio.
    expect(describeConnection("a", stdio, "sse").transport).toBe("stdio");
    expect(describeConnection("a", stdio, "stdio").transport).toBe("stdio");
    expect(describeConnection("a", auto, "stdio").transport).toBe("http");
    expect(describeConnection("a", http, "sse").transport).toBe("sse");
  });

  test("sanitizes the configured key like other display text", () => {
    const ref = describeConnection(`\u0000 my\tserver ${"k".repeat(200)}`, stdio);
    expect(ref.key.startsWith("my server k")).toBe(true);
    expect(ref.key).toHaveLength(MCP_IDENTITY_LIMITS.connectionKeyMaxChars);
    expect(MCPConnectionRefSchema.safeParse(ref).success).toBe(true);
  });
});

describe("buildToolCallDisplay", () => {
  const connection = {
    key: "notion",
    transport: "http" as const,
    origin: "https://mcp.notion.com",
  };
  const identity: MCPServerIdentity = {
    name: "notion-mcp",
    version: "2.1.0",
    title: "Notion",
    description: "Notion workspace tools",
    websiteUrl: "https://www.notion.so",
  };

  test("returns the validated snapshot and undefined without identity", () => {
    expect(buildToolCallDisplay({ connection, identity, source: "response" })).toStrictEqual({
      connection,
      identity,
      source: "response",
    });
    expect(
      buildToolCallDisplay({ connection, identity: undefined, source: "connection" })
    ).toBeUndefined();
  });

  test("returns undefined when the connection itself is invalid", () => {
    expect(
      buildToolCallDisplay({
        connection: { key: "", transport: "stdio" },
        identity,
        source: "connection",
      })
    ).toBeUndefined();
  });

  test("lets the schema discard invalid optional identity fields", () => {
    const snapshot = buildToolCallDisplay({
      connection,
      identity: { ...identity, websiteUrl: "http://www.notion.so", title: "t".repeat(81) },
      source: "response",
    });
    expect(snapshot?.identity).toStrictEqual({
      name: identity.name,
      version: identity.version,
      description: identity.description,
    });
  });

  test("max-length normalized fields fit the byte budget after trimming description first", () => {
    const snapshot = buildToolCallDisplay({
      connection: maxConnection,
      identity: maxIdentity,
      source: "connection",
    });
    expect(snapshot).toBeDefined();
    expect(utf8Bytes(snapshot)).toBeLessThanOrEqual(MCP_IDENTITY_LIMITS.displaySnapshotMaxBytes);
    // Required fields, title and website all survive at their maximum length; only the description goes.
    expect(snapshot!.identity.name).toBe(maxIdentity.name);
    expect(snapshot!.identity.version).toBe(maxIdentity.version);
    expect(snapshot!.identity.title).toBe(maxIdentity.title);
    expect(snapshot!.identity.websiteUrl).toBe(maxIdentity.websiteUrl);
    expect(snapshot!.identity.description).toBeUndefined();
    expect(snapshot!.connection).toStrictEqual(maxConnection);
  });

  test("trims websiteUrl before title and title last", () => {
    // JSON-escaped control characters cost 6 bytes per UTF-16 unit, so an
    // un-normalized identity can exceed the budget even without description.
    const heavy = "\u0001".repeat(MCP_IDENTITY_LIMITS.nameMaxChars);
    const heavyIdentity: MCPServerIdentity = {
      name: heavy,
      version: "\u0001".repeat(MCP_IDENTITY_LIMITS.versionMaxChars),
      title: heavy,
      description: "d",
      websiteUrl: maxIdentity.websiteUrl,
    };
    const heavyConnection = { ...maxConnection, key: heavy };
    const snapshot = buildToolCallDisplay({
      connection: heavyConnection,
      identity: heavyIdentity,
      source: "connection",
    });
    expect(snapshot).toBeDefined();
    expect(utf8Bytes(snapshot)).toBeLessThanOrEqual(MCP_IDENTITY_LIMITS.displaySnapshotMaxBytes);
    expect(snapshot!.identity).toStrictEqual({
      name: heavyIdentity.name,
      version: heavyIdentity.version,
    });

    // Dropping description alone leaves the website over budget → website goes, title stays.
    const withoutHeavyTitle = buildToolCallDisplay({
      connection: heavyConnection,
      identity: { ...heavyIdentity, title: "Notion" },
      source: "connection",
    });
    expect(withoutHeavyTitle!.identity.title).toBe("Notion");
    expect(withoutHeavyTitle!.identity.websiteUrl).toBeUndefined();
    expect(withoutHeavyTitle!.identity.description).toBeUndefined();
  });
});

describe("takeStandardDisplayMeta", () => {
  test("returns non-object and meta-less results untouched by reference", () => {
    for (const raw of [
      "text",
      null,
      undefined,
      3,
      ["a"],
      { content: [] },
      { content: [], _meta: "x" },
    ]) {
      const { rest, displayKeyValue } = takeStandardDisplayMeta(raw);
      expect(rest).toBe(raw);
      expect(displayKeyValue).toBeUndefined();
    }
    const unrelated = { content: [{ type: "text", text: "hi" }], _meta: { "vendor/trace": "t-1" } };
    expect(takeStandardDisplayMeta(unrelated).rest).toBe(unrelated);
  });

  test("removes only the standard display key without mutating the input", () => {
    const serverInfo = { name: "notion", version: "1" };
    const content = [{ type: "text", text: "hi" }];
    const raw = {
      content,
      isError: false,
      _meta: { [MCP_SERVER_INFO_META_KEY]: serverInfo, "vendor/trace": "t-1" },
    };
    const before = structuredClone(raw);
    const { rest, displayKeyValue } = takeStandardDisplayMeta(raw);
    expect(displayKeyValue).toBe(serverInfo);
    expect(rest).toStrictEqual({ content, isError: false, _meta: { "vendor/trace": "t-1" } });
    expect((rest as { content: unknown }).content).toBe(content);
    expect(raw).toStrictEqual(before);
  });

  test("drops an emptied _meta object", () => {
    const raw = { content: [], _meta: { [MCP_SERVER_INFO_META_KEY]: "malformed" } };
    const { rest, displayKeyValue } = takeStandardDisplayMeta(raw);
    expect(displayKeyValue).toBe("malformed");
    expect(rest).toStrictEqual({ content: [] });
    expect(Object.hasOwn(rest as object, "_meta")).toBe(false);
  });
});

describe("MCP identity schemas", () => {
  test("identity schema drops invalid optional fields and rejects invalid required ones", () => {
    const parsed = MCPServerIdentitySchema.parse({
      name: "n",
      version: "1",
      title: "",
      description: "d".repeat(301),
      websiteUrl: "https://u@example.com",
    });
    // Zod keeps `key: undefined` for keys present in the input; JSON omits them.
    expect(parsed).toEqual({ name: "n", version: "1" });
    expect(MCPServerIdentitySchema.safeParse({ name: "", version: "1" }).success).toBe(false);
    expect(MCPServerIdentitySchema.safeParse({ name: "n".repeat(81), version: "1" }).success).toBe(
      false
    );
  });

  test("connection ref accepts only exact https origins and concrete transports", () => {
    expect(
      MCPConnectionRefSchema.parse({ key: "k", transport: "sse", origin: "https://a.example/x" })
    ).toEqual({
      key: "k",
      transport: "sse",
    });
    expect(MCPConnectionRefSchema.safeParse({ key: "k", transport: "auto" }).success).toBe(false);
    expect(
      MCPConnectionRefSchema.parse({ key: "k", transport: "http", origin: maxOrigin }).origin
    ).toBe(maxOrigin);
    expect(
      MCPConnectionRefSchema.parse({ key: "k", transport: "http", origin: `${maxOrigin}0` }).origin
    ).toBeUndefined();
  });

  test("display snapshot enforces the aggregate UTF-8 byte budget", () => {
    const fits = {
      connection: maxConnection,
      identity: { ...maxIdentity, description: undefined },
      source: "connection",
    };
    expect(MCPToolCallDisplaySchema.safeParse(fits).success).toBe(true);
    const over = { connection: maxConnection, identity: maxIdentity, source: "connection" };
    expect(utf8Bytes(over)).toBeGreaterThan(MCP_IDENTITY_LIMITS.displaySnapshotMaxBytes);
    expect(MCPToolCallDisplaySchema.safeParse(over).success).toBe(false);
    expect(
      MCPToolCallDisplaySchema.safeParse({ connection: maxConnection, source: "response" }).success
    ).toBe(false);
  });

  test("test results tolerate malformed serverInfo", () => {
    const result = MCPTestResultSchema.parse({
      success: true,
      tools: ["a"],
      serverInfo: { name: "" },
    });
    expect(result).toEqual({ success: true, tools: ["a"] });
    const ok = MCPTestResultSchema.parse({
      success: true,
      tools: [],
      serverInfo: { name: "notion", version: "1", title: "Notion" },
    });
    expect(ok.success && ok.serverInfo).toStrictEqual({
      name: "notion",
      version: "1",
      title: "Notion",
    });
  });
});
