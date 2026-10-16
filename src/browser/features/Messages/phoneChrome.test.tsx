import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillIndicator } from "@/browser/components/SkillIndicator/SkillIndicator";
import {
  CHROME_SLOTS,
  ROW_SLOTS,
  type PhoneChrome,
  type SkeletonNode,
} from "@/common/staticWorkspaceView/phoneChrome";
import { PHONE_CHROME_JSON } from "@/common/staticWorkspaceView/phoneChrome.generated";

// The live-page parity check is `make check-phone-chrome` (CI, linux E2E shard 1). These checks
// are the contract of the checked-in capture: what a later early script may rely on.
const skeleton = JSON.parse(PHONE_CHROME_JSON) as PhoneChrome;

function* walk(node: SkeletonNode): Generator<SkeletonNode> {
  yield node;
  if (Array.isArray(node)) for (const child of node.slice(2) as SkeletonNode[]) yield* walk(child);
}
const elements = (node: SkeletonNode) => [...walk(node)].filter((n) => Array.isArray(n));
const slots = (node: SkeletonNode) =>
  [...walk(node)].flatMap((n) => (typeof n === "object" && !Array.isArray(n) ? [n.slot] : []));
const toHtml = ([tag, attrs]: Extract<SkeletonNode, unknown[]>) =>
  `<${tag}${Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("")}></${tag}>`;

describe("phone chrome skeleton", () => {
  test("each slot appears exactly once, in its own tree", () => {
    expect(slots(skeleton.chrome).sort()).toEqual([...CHROME_SLOTS].sort());
    expect(slots(skeleton.user).sort()).toEqual(["md", "ts"]);
    expect(slots(skeleton.assistant).sort()).toEqual([...ROW_SLOTS].sort());
  });

  test("it carries no event handler, URL or text of the seed", async () => {
    const all = [skeleton.chrome, skeleton.user, skeleton.assistant].flatMap(elements);
    for (const [, attrs] of all) {
      for (const [name, value] of Object.entries(attrs)) {
        expect(name).not.toMatch(/^(on|href$|src|action$|formaction$|xlink:)/i);
        expect(value).not.toMatch(/url\(|javascript:/i);
      }
    }
    const text = JSON.stringify(skeleton);
    const seed = await readFile("scripts/perf/fixtures/neutralSeed/chat.jsonl", "utf8");
    const parts = seed
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => (JSON.parse(line) as { parts: Array<{ text?: string }> }).parts);
    const snippets = parts.flatMap((p) => p.text?.split("\n").filter((l) => l.length > 12) ?? []);
    expect(snippets.length).toBeGreaterThan(4);
    for (const snippet of snippets)
      expect(text).not.toContain(JSON.stringify(snippet).slice(1, -1));
    expect(text).not.toContain("demo-app"); // the seeded project
  });

  test("the skills button is the placeholder SkillIndicator shows while skills load", () => {
    const loading = renderToStaticMarkup(
      <SkillIndicator loadedSkills={[]} availableSkills={[]} loading={true} />
    );
    const held = elements(skeleton.chrome).filter((n) => toHtml(n) === loading);
    expect(held).toHaveLength(1);
    expect(JSON.stringify(skeleton.chrome)).not.toContain("skills loaded");
  });
});
