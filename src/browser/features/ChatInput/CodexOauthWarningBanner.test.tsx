import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CodexOauthWarningBanner } from "./CodexOauthWarningBanner";

describe("CodexOauthWarningBanner", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("renders when an OAuth-required model is selected and OAuth is not connected", () => {
    const onOpenProviders = mock(() => undefined);

    const view = render(
      <CodexOauthWarningBanner
        requiresCodexOauth={true}
        codexOauthSet={false}
        onOpenProviders={onOpenProviders}
      />
    );

    expect(view.getByTestId("codex-oauth-warning-banner")).toBeTruthy();
    expect(view.getByText("This model requires Codex OAuth.")).toBeTruthy();
    expect(view.getByText("Providers")).toBeTruthy();

    fireEvent.click(view.getByText("Providers"));
    expect(onOpenProviders).toHaveBeenCalledTimes(1);
  });

  test("does not render when Codex OAuth is connected", () => {
    const view = render(
      <CodexOauthWarningBanner
        requiresCodexOauth={true}
        codexOauthSet={true}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("codex-oauth-warning-banner")).toBeNull();
  });

  test("does not render when Codex OAuth status is still unknown", () => {
    const view = render(
      <CodexOauthWarningBanner
        requiresCodexOauth={true}
        codexOauthSet={null}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("codex-oauth-warning-banner")).toBeNull();
  });

  test("does not render for non-required models", () => {
    const view = render(
      <CodexOauthWarningBanner
        requiresCodexOauth={false}
        codexOauthSet={false}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("codex-oauth-warning-banner")).toBeNull();
  });
});
