import { describe, expect, test } from "bun:test";
import { branchPickerItems, groupProjectsByRecency } from "./creationPickerGroups";

const rows = (items: ReturnType<typeof branchPickerItems>) =>
  items.map((item) => `${item.section ?? "-"}:${item.label}${item.badge ? "*" : ""}`);

describe("branchPickerItems", () => {
  test("leads with the default branch, then recent, then the rest", () => {
    expect(rows(branchPickerItems(["a", "b", "main", "z"], "main", ["z", "main"]))).toEqual([
      "-:main*",
      "Recent:z",
      "All branches:a",
      "All branches:b",
    ]);
  });

  test("has no captions when nothing is recent, or nothing is left over", () => {
    expect(rows(branchPickerItems(["a", "main"], "main", []))).toEqual(["-:main*", "-:a"]);
    expect(rows(branchPickerItems(["a", "main"], "main", ["a"]))).toEqual(["-:main*", "-:a"]);
  });

  test("ignores a default or a recent branch that is not in the list", () => {
    expect(rows(branchPickerItems(["a", "b"], "gone", ["gone", "b"]))).toEqual([
      "Recent:b",
      "All branches:a",
    ]);
  });
});

describe("groupProjectsByRecency", () => {
  const projects = ["/p1", "/p2", "/p3", "/p4", "/p5", "/p6"];
  const workspaces = [
    { id: "w1", projectPath: "/p1" },
    { id: "w2", projectPath: "/p2" },
    { id: "w2b", projectPath: "/p2" },
    { id: "w5", projectPath: "/p5" },
    { id: "w6", projectPath: "/p6" },
  ];

  test("ranks projects by their most recently active workspace", () => {
    const groups = groupProjectsByRecency(projects, workspaces, {
      w1: 5,
      w2: 1,
      w2b: 9,
      w5: 7,
      w6: 2,
    });
    expect(groups.recent).toEqual(["/p2", "/p5", "/p1"]);
    expect(groups.rest).toEqual(["/p3", "/p4", "/p6"]);
  });

  test("a project with no activity is never recent", () => {
    expect(groupProjectsByRecency(projects, workspaces, { w5: 3 }).recent).toEqual(["/p5"]);
  });

  test("a short list is not grouped", () => {
    const groups = groupProjectsByRecency(projects.slice(0, 3), workspaces, { w1: 5 });
    expect(groups).toEqual({ recent: [], rest: ["/p1", "/p2", "/p3"] });
  });
});
