import { expect, test } from "bun:test";

import { scrollDeltaFor } from "./scroll";

test.each([
  ["up", "darwin", { x: 0, y: 300 }],
  ["down", "darwin", { x: 0, y: -300 }],
  ["left", "darwin", { x: 300, y: 0 }],
  ["right", "darwin", { x: -300, y: 0 }],
  ["up", "linux", { x: 0, y: 3 }],
  ["down", "linux", { x: 0, y: -3 }],
  ["right", "linux", { x: -3, y: 0 }],
] as const)("scroll %s x3 on %s", (direction, platform, expected) => {
  const delta = scrollDeltaFor(direction, 3, platform);
  expect({ x: delta.x + 0, y: delta.y + 0 }).toEqual(expected);
});
