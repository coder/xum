import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { getAppConfigStore, useAppConfig } from "@/browser/stores/AppConfigStore";
import { useWorkspaceStreamingStats } from "@/browser/stores/WorkspaceStore";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { useKatexPlugins } from "./mathRendering";

// The static workspace view renders the live markdown components on the server. React's server
// renderer throws for a useSyncExternalStore hook without a server snapshot, so each store hook
// on that path must return its client snapshot there.
describe("server rendering of the markdown hooks", () => {
  const store = getAppConfigStore();
  // Preferences with quotes, as other test files in the shard leave them: React escapes them.
  const before = store.getSnapshot();
  beforeAll(() =>
    store.updateOptimistically({ userPreferences: { appearance: { theme: "dark" } } })
  );
  afterAll(() => (before ? store.updateOptimistically(before) : store.clearCachedState()));
  const hooks: Array<[name: string, useHook: () => unknown, clientSnapshot: () => unknown]> = [
    [
      "useAppConfig",
      () => useAppConfig((c) => c.userPreferences ?? null),
      () => store.getSnapshot()?.userPreferences ?? null,
    ],
    ["useWorkspaceStreamingStats", () => useWorkspaceStreamingStats("ws"), () => null],
    // Disabled, so other test files that publish the KaTeX plugins cannot change the answer.
    ["useKatexPlugins", () => useKatexPlugins(false), () => null],
  ];
  test.each(hooks)("%s returns its client snapshot", (_name, useHook, clientSnapshot) => {
    const Probe = () => <i>{JSON.stringify(useHook())}</i>;
    const expected = renderToStaticMarkup(<i>{JSON.stringify(clientSnapshot())}</i>);
    expect(renderToStaticMarkup(<Probe />)).toBe(expected);
  });

  test("user and assistant markdown render to static markup", () => {
    const text = "Use `add()`:\n\n```ts\nadd(1, 2);\n```";
    for (const row of [
      <MarkdownRenderer key="user" content={text} preserveLineBreaks />,
      <TypewriterMarkdown key="assistant" content={text} isComplete streamKey="k" />,
    ]) {
      const html = renderToStaticMarkup(<ThemeProvider forcedTheme="dark">{row}</ThemeProvider>);
      expect(html).toContain("<code>add()</code>");
      expect(html).toContain('data-code-language="ts"');
    }
  });
});
