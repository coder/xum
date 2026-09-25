import { describe, expect, test } from "bun:test";

import { stripEncryptedContent } from "./stripEncryptedContent";

describe("stripEncryptedContent", () => {
  test("strips encryptedContent from array output shape", () => {
    const output = [
      {
        url: "https://example.com/a",
        title: "Result A",
        pageAge: "2d",
        encryptedContent: "secret-a",
      },
      {
        url: "https://example.com/b",
        title: "Result B",
      },
      "non-object-item",
    ];

    expect(stripEncryptedContent(output)).toEqual([
      {
        url: "https://example.com/a",
        title: "Result A",
        pageAge: "2d",
      },
      {
        url: "https://example.com/b",
        title: "Result B",
      },
      "non-object-item",
    ]);
  });

  test("strips encryptedContent from json value output shape", () => {
    const output = {
      type: "json",
      value: [
        {
          url: "https://example.com/c",
          title: "Result C",
          encryptedContent: "secret-c",
        },
        {
          url: "https://example.com/d",
          title: "Result D",
          pageAge: "5h",
        },
      ],
      source: "web_search",
    };

    expect(stripEncryptedContent(output)).toEqual({
      type: "json",
      value: [
        {
          url: "https://example.com/c",
          title: "Result C",
        },
        {
          url: "https://example.com/d",
          title: "Result D",
          pageAge: "5h",
        },
      ],
      source: "web_search",
    });
  });
});
