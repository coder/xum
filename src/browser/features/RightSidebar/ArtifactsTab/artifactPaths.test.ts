import { describe, expect, test } from "bun:test";
import { classifyArtifactReference, resolveArtifactReference } from "./artifactPaths";

describe("resolveArtifactReference", () => {
  test("resolves against the artifact's folder", () => {
    expect(resolveArtifactReference("reports/summary.md", "img/chart.png")).toBe(
      "reports/img/chart.png"
    );
    expect(resolveArtifactReference("summary.md", "./chart.png")).toBe("chart.png");
    expect(resolveArtifactReference("a/b/page.html", "../style.css?v=2#x")).toBe("a/style.css");
    expect(resolveArtifactReference("a/page.html", "my%20chart.png")).toBe("a/my chart.png");
  });

  test("refuses references that leave the artifacts dir or are not relative", () => {
    expect(resolveArtifactReference("page.html", "../secret.txt")).toBeNull();
    expect(resolveArtifactReference("a/page.html", "../../x.png")).toBeNull();
    expect(resolveArtifactReference("page.html", "/etc/passwd")).toBeNull();
    expect(resolveArtifactReference("page.html", "//evil.example/x.png")).toBeNull();
    expect(resolveArtifactReference("page.html", "https://example.com/x.png")).toBeNull();
    expect(resolveArtifactReference("page.html", "file:///etc/passwd")).toBeNull();
    expect(resolveArtifactReference("page.html", "a\\..\\..\\x")).toBeNull();
    expect(resolveArtifactReference("page.html", "%E0%A4%A")).toBeNull();
    expect(resolveArtifactReference("page.html", "%2e%2e/x")).toBeNull();
  });

  test("classifies references", () => {
    expect(classifyArtifactReference("data:image/png;base64,AA")).toBe("data");
    expect(classifyArtifactReference("img/a.png")).toBe("relative");
    expect(classifyArtifactReference("https://cdn.jsdelivr.net/npm/x")).toBe("external");
    expect(classifyArtifactReference("javascript:alert(1)")).toBe("external");
  });
});
