import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type {
  BackupPluginRemoval,
  BackupPluginReport,
  BackupPluginRow,
  BackupPluginStatus,
} from "@/common/orpc/schemas/backup";
import { BackupPluginsCard, PluginRemovalCard, reviewBackedUpPlugins } from "./BackupPluginsCard";
import { consumePendingPluginsSectionIntent } from "./pluginsSectionIntents";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
  consumePendingPluginsSectionIntent();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
  consumePendingPluginsSectionIntent();
});

const SHA = "ab".repeat(20);

function row(
  name: string,
  status: BackupPluginStatus,
  source: Partial<BackupPluginRow["source"]> = {}
): BackupPluginRow {
  return {
    name,
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: "main",
      refType: "branch",
      ...source,
    },
    lockedSha: SHA,
    status,
  };
}

function reportOf(rows: BackupPluginRow[], extra: Partial<BackupPluginReport> = {}) {
  return { rows, skipped: false, warnings: [], ...extra };
}

function removalOf(overrides: Partial<BackupPluginRemoval> = {}): BackupPluginRemoval {
  return { names: [], wholeList: false, unreadable: false, approval: "digest", ...overrides };
}

function renderInProvider(node: React.ReactElement): RenderResult {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

function renderRemoval(
  removal: BackupPluginRemoval | null,
  props: { busy?: boolean; onConfirm?: () => void } = {}
) {
  const onConfirm = props.onConfirm ?? (() => undefined);
  return renderInProvider(
    <PluginRemovalCard removal={removal} busy={props.busy ?? false} onConfirm={onConfirm} />
  );
}

function renderCard(
  report: BackupPluginReport,
  props: { busy?: boolean; onReview?: () => void } = {}
) {
  const onReview = props.onReview ?? (() => undefined);
  return renderInProvider(
    <BackupPluginsCard report={report} busy={props.busy ?? false} onReview={onReview} />
  );
}

function listedNames(view: RenderResult): string[] {
  return view.queryAllByRole("listitem").map((item) => item.textContent ?? "");
}

describe("PluginRemovalCard", () => {
  test("shows nothing when no push is waiting for a removal approval", () => {
    const view = renderRemoval(null);

    expect(view.container.textContent).toBe("");
  });

  test("names each plugin the push removes and confirms once the user selects the button", () => {
    const confirmations: string[] = [];
    const view = renderRemoval(removalOf({ names: ["alpha", "beta"] }), {
      onConfirm: () => confirmations.push("confirmed"),
    });

    expect(listedNames(view)).toEqual(["alpha", "beta"]);
    expect(confirmations).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "Back up and remove" }));

    expect(confirmations).toEqual(["confirmed"]);
  });

  test("cannot confirm while a backup action runs", () => {
    const confirmations: string[] = [];
    const view = renderRemoval(removalOf({ names: ["alpha"] }), {
      busy: true,
      onConfirm: () => confirmations.push("confirmed"),
    });

    const button = view.getByRole("button", { name: "Back up and remove" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);

    expect(confirmations).toEqual([]);
  });

  test("says the whole list goes when the push writes none, and still names the plugins in it", () => {
    const view = renderRemoval(removalOf({ names: ["alpha"], wholeList: true }));

    expect(view.getByText(/The whole list is removed/)).toBeTruthy();
    expect(listedNames(view)).toEqual(["alpha"]);
  });

  test("promises no list of names when only entries it cannot read go", () => {
    const view = renderRemoval(removalOf({ unreadable: true }));

    expect(view.getByText(/cannot read/)).toBeTruthy();
    expect(listedNames(view)).toEqual([]);
    expect(view.queryByText(/so they are removed from it/)).toBeNull();
    expect(view.getByRole("button", { name: "Back up and remove" })).toBeTruthy();
  });

  test("puts the note about unreadable entries after the names it does not cover", () => {
    const view = renderRemoval(removalOf({ names: ["alpha"], unreadable: true }));

    const item = view.getByRole("listitem");
    const note = view.getByText(/cannot read/);
    expect(item.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("leaves out the unreadable-entries note when the whole list goes", () => {
    const view = renderRemoval(removalOf({ names: ["alpha"], wholeList: true, unreadable: true }));

    expect(view.queryByText(/cannot read/)).toBeNull();
  });

  test("shows no note about unreadable entries when every entry could be read", () => {
    const view = renderRemoval(removalOf({ names: ["alpha"] }));

    expect(view.queryByText(/cannot read/)).toBeNull();
  });
});

describe("BackupPluginsCard", () => {
  test("says a skipped list was skipped, with no rows and no way to review", () => {
    const view = renderCard(reportOf([row("alpha", "missing")], { skipped: true }));

    expect(view.getByText(/plugin backup is disabled here/)).toBeTruthy();
    expect(view.queryByText("alpha")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("shows nothing for a backup without a plugin list", () => {
    const view = renderCard(reportOf([]));

    expect(view.container.textContent).toBe("");
  });

  test("shows what could not be read, even with no row to show", () => {
    const view = renderCard(reportOf([], { warnings: ["The plugin list was not read."] }));

    expect(view.getByText("The plugin list was not read.")).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
  });

  test("labels each plugin with how it compares with this machine", () => {
    const view = renderCard(
      reportOf([
        row("alpha", "missing"),
        row("beta", "installed"),
        row("gamma", "conflict"),
        row("delta", "folderMissing"),
      ])
    );

    const badges = Object.fromEntries(
      view.getAllByRole("listitem").map((item) => {
        const name = item.querySelector("span")?.textContent ?? "";
        return [name, item.querySelectorAll("span")[1]?.textContent];
      })
    );
    expect(badges).toEqual({
      alpha: "Not installed",
      beta: "Installed",
      gamma: "Name in use",
      delta: "Folder missing",
    });
  });

  test("shows each plugin's repository, folder, branch and the start of its pinned commit", () => {
    const view = renderCard(
      reportOf([
        row("alpha", "missing", {
          url: "https://github.com/example/mono.git",
          ref: "v1.2.0",
          refType: "tag",
          subpath: "packages/alpha",
        }),
      ])
    );

    expect(view.getByText("github.com/example/mono/packages/alpha")).toBeTruthy();
    expect(view.getByText(`v1.2.0 · ${SHA.slice(0, 12)}`)).toBeTruthy();
  });

  test("offers a review of only the missing plugins", () => {
    const reviews: string[] = [];
    const view = renderCard(
      reportOf([
        row("alpha", "missing"),
        row("beta", "installed"),
        row("gamma", "conflict"),
        row("delta", "folderMissing"),
        row("epsilon", "missing"),
      ]),
      { onReview: () => reviews.push("review") }
    );

    const button = view.getByRole("button", { name: /Review and install \(2\)/ });
    fireEvent.click(button);

    expect(reviews).toEqual(["review"]);
  });

  test("offers no review when no plugin is missing", () => {
    const view = renderCard(
      reportOf([row("beta", "installed"), row("gamma", "conflict"), row("delta", "folderMissing")])
    );

    expect(view.queryByRole("button", { name: /Review and install/ })).toBeNull();
  });

  test("cannot start a review while a backup action runs", () => {
    const reviews: string[] = [];
    const view = renderCard(reportOf([row("alpha", "missing")]), {
      busy: true,
      onReview: () => reviews.push("review"),
    });

    const button = view.getByRole("button", { name: /Review and install/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);

    expect(reviews).toEqual([]);
  });

  test("offers a plugin from an ssh source at its https address, and a non-https source to add by hand", () => {
    const view = renderCard(
      reportOf([
        row("alpha", "missing"),
        row("beta", "missing", { url: "ssh://git@host.example/beta.git" }),
        row("gamma", "missing", { url: "git@host.example:gamma.git" }),
        row("delta", "missing", { url: "http://host.example/delta.git" }),
        row("epsilon", "missing", { url: "git://host.example/epsilon.git" }),
        row("zeta", "installed", { url: "git@github.com:example/zeta.git" }),
      ])
    );

    expect(view.getByRole("button", { name: /Review and install \(3\)/ })).toBeTruthy();
    const badges = view
      .getAllByRole("listitem")
      .map((item) => item.querySelectorAll("span")[1]?.textContent);
    expect(badges).toEqual([
      "Not installed",
      "Not installed",
      "Not installed",
      "Add it yourself",
      "Add it yourself",
      "Installed",
    ]);
    expect(view.getByText(/previewed at the https address of the same host/)).toBeTruthy();
    // The badge covers http and git, so the note must not call its source ssh.
    expect(view.getByText(/non-https source with no https address/)).toBeTruthy();
    expect(view.queryByText(/comes from an ssh source/)).toBeNull();
  });

  test("says nothing about https or adding by hand when every source is https", () => {
    const view = renderCard(reportOf([row("alpha", "missing"), row("beta", "installed")]));

    expect(view.queryByText(/https address/)).toBeNull();
    expect(view.queryByText(/non-https/)).toBeNull();
  });

  test("explains a name in use only when a plugin has one", () => {
    const withConflict = renderCard(reportOf([row("gamma", "conflict")]));
    expect(withConflict.getByText(/is not offered/)).toBeTruthy();
    withConflict.unmount();

    const without = renderCard(reportOf([row("alpha", "missing")]));
    expect(without.queryByText(/is not offered/)).toBeNull();
  });
});

describe("reviewBackedUpPlugins", () => {
  test("hands the missing plugins, without their status, to Settings → Plugins and opens it", () => {
    let opened = 0;

    reviewBackedUpPlugins({
      report: reportOf([
        row("alpha", "missing"),
        row("beta", "installed"),
        row("gamma", "folderMissing"),
        row("delta", "missing"),
      ]),
      enabled: true,
      openPlugins: () => opened++,
    });

    const intent = consumePendingPluginsSectionIntent();
    expect(intent?.type).toBe("install-from-backup");
    const entries = intent?.type === "install-from-backup" ? intent.entries : [];
    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "delta"]);
    expect(entries.some((entry) => "status" in entry)).toBe(false);
    expect(opened).toBe(1);
  });

  test("hands over a plugin from an ssh or scp source as listed, and none from another non-https source", () => {
    let opened = 0;

    reviewBackedUpPlugins({
      report: reportOf([
        row("alpha", "missing"),
        row("beta", "missing", { url: "ssh://git@host.example/beta.git" }),
        row("gamma", "missing", { url: "git@host.example:gamma.git" }),
        row("delta", "missing", { url: "http://host.example/delta.git" }),
        row("epsilon", "missing", { url: "git://host.example/epsilon.git" }),
      ]),
      enabled: true,
      openPlugins: () => opened++,
    });

    const intent = consumePendingPluginsSectionIntent();
    const entries = intent?.type === "install-from-backup" ? intent.entries : [];
    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma"]);
    // The ssh address stays as listed: the review turns it into the https address when it previews.
    expect(entries[2]?.source.url).toBe("git@host.example:gamma.git");
    expect(opened).toBe(1);
  });

  test.each([
    ["a backslash before a user part", "https://github.com\\@attacker.example/repo.git"],
    ["a user part", "https://user@github.com/example/repo.git"],
    ["a query", "https://github.com/example/repo.git?mirror=1"],
    ["a fragment", "https://github.com/example/repo.git#main"],
    ["a percent escape", "https://github.com/example/my%20repo.git"],
    ["a loopback host", "https://127.0.0.1/example/repo.git"],
    ["a localhost name", "https://localhost/example/repo.git"],
    ["an IPv6 literal", "https://[::1]/example/repo.git"],
    ["an upper-case scheme", "HTTPS://github.com/example/repo.git"],
    ["no path", "https://github.com"],
    // An unanchored match would accept this: git signs in over ssh to attacker.example.
    ["an ssh URL that ends in an https URL", "ssh://git@attacker.example/https://a.example/b"],
    ["a bare query mark", "https://github.com/o/r?x"],
    ["an at sign in the path", "https://github.com/o/r@x"],
    ["a backslash in the host", "https://github.com\\attacker.example/o/r"],
    ["a backslash in the path", "https://example.com/a\\b"],
    ["a port over five digits", "https://github.com:123456/r"],
  ])("hands over no plugin whose https URL has %s", (_label, url) => {
    reviewBackedUpPlugins({
      report: reportOf([row("alpha", "missing"), row("beta", "missing", { url })]),
      enabled: true,
      openPlugins: () => undefined,
    });

    const intent = consumePendingPluginsSectionIntent();
    const entries = intent?.type === "install-from-backup" ? intent.entries : [];
    expect(entries.map((entry) => entry.name)).toEqual(["alpha"]);
  });

  test("hands over a plain https URL with a port and a nested path", () => {
    const url = "https://git.example.com:8443/group/sub_group/repo-name.v2.git";
    reviewBackedUpPlugins({
      report: reportOf([row("alpha", "missing", { url })]),
      enabled: true,
      openPlugins: () => undefined,
    });

    const intent = consumePendingPluginsSectionIntent();
    const entries = intent?.type === "install-from-backup" ? intent.entries : [];
    expect(entries.map((entry) => entry.source.url)).toEqual([url]);
  });

  test("opens nothing when every missing plugin comes from a non-https source with no https address", () => {
    let opened = 0;

    reviewBackedUpPlugins({
      report: reportOf([
        row("beta", "missing", { url: "http://host.example/beta.git" }),
        row("gamma", "missing", { url: "git://host.example/gamma.git" }),
      ]),
      enabled: true,
      openPlugins: () => opened++,
    });

    expect(consumePendingPluginsSectionIntent()).toBeNull();
    expect(opened).toBe(0);
  });

  test("does nothing while a backup action runs", () => {
    let opened = 0;

    reviewBackedUpPlugins({
      report: reportOf([row("alpha", "missing")]),
      enabled: false,
      openPlugins: () => opened++,
    });

    expect(consumePendingPluginsSectionIntent()).toBeNull();
    expect(opened).toBe(0);
  });

  test("does nothing when no plugin is missing", () => {
    let opened = 0;

    reviewBackedUpPlugins({
      report: reportOf([row("beta", "installed"), row("gamma", "folderMissing")]),
      enabled: true,
      openPlugins: () => opened++,
    });

    expect(consumePendingPluginsSectionIntent()).toBeNull();
    expect(opened).toBe(0);
  });
});
