import "../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { mcpIconRefCache } from "@/browser/utils/mcp/iconRefCache";
import { useMcpIcon } from "./useMcpIcon";
import { createTestApiClient } from "@/browser/testUtils";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** Minimal API client: only the bulk icon lookup the hook needs, with a call counter. */
function fakeClient(answer: (iconRefs: string[]) => Record<string, string | null>) {
  const calls: string[][] = [];
  const client = createTestApiClient({
    mcp: {
      icons: (input: { iconRefs: string[] }) => {
        calls.push([...input.iconRefs]);
        return Promise.resolve(answer(input.iconRefs));
      },
    },
  });
  return { client, calls };
}

function Row(props: { iconRef: string | undefined }) {
  const icon = useMcpIcon(props.iconRef);
  return <output data-testid="icon">{icon ?? ""}</output>;
}

describe("useMcpIcon", () => {
  let cleanupDom: () => void;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  test("shows an icon that becomes cached between render and the passive effect, without another IPC", async () => {
    // Distinct ref per test: the cache is a renderer-session singleton.
    const iconRef = "a1".repeat(16);
    const { client, calls } = fakeClient((refs) => Object.fromEntries(refs.map((r) => [r, PNG])));
    // Another row already resolved this ref through the shared cache.
    expect(await mcpIconRefCache.resolve(iconRef, client)).toBe(PNG);
    expect(calls).toHaveLength(1);

    // Controlled read seam: the render sees the entry still pending, the
    // effect sees it resolved. Only the first peek (render) is intercepted.
    const peek = spyOn(mcpIconRefCache, "peek");
    peek.mockImplementationOnce(() => undefined);
    try {
      const view = render(
        <APIProvider client={client}>
          <Row iconRef={iconRef} />
        </APIProvider>
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(view.getByTestId("icon").textContent).toBe(PNG);
      // The cache hit answered synchronously from memory: no second lookup.
      expect(calls).toHaveLength(1);
    } finally {
      peek.mockRestore();
    }
  });

  test("without a ref no lookup happens and the generic icon is used", async () => {
    const { client, calls } = fakeClient(() => ({}));
    const view = render(
      <APIProvider client={client}>
        <Row iconRef={undefined} />
      </APIProvider>
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByTestId("icon").textContent).toBe("");
    expect(calls).toHaveLength(0);
  });
});
