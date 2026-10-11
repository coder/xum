/**
 * Seeded root for the T3 (#5971) boot measurements: one trusted project, one workspace with the
 * Lighthouse auditor's 4-message chat (a ```ts block whose first code line is the P2 useful content),
 * and the onboarding wizard marked as seen. Write it before the app or server starts: both read
 * config.json and the session files at startup.
 */
import * as fs from "node:fs";
import { prepareDemoProject, trustDemoProject } from "../../tests/e2e/utils/demoProject";

/** ONBOARDING_WIZARD_SPLASH_ID (SplashScreens/index.ts). desktopColdStart fails if the wizard still shows. */
const SEED_VIEWED_SPLASH_ID = "onboarding-wizard-v1";

/** Text of the P2 useful element (a `div.code-line` of the first assistant reply). */
export const SEED_CODE_LINE = "export function subtract(a: number, b: number): number {";

function chatRows(workspaceId: string): string[] {
  const t0 = Date.now() - 10 * 60_000;
  const texts = [
    "Add a subtract helper next to add() in src/math.ts, with a short doc comment.",
    `I added \`subtract()\` to \`src/math.ts\`:\n\n\`\`\`ts\n/** Returns a minus b. */\n${SEED_CODE_LINE}\n  return a - b;\n}\n\`\`\`\n\nIt matches the style of \`add()\`. No other file changes.`,
    "Thanks. Which tests should I add?",
    "Two cases cover it:\n\n1. `subtract(5, 3)` returns `2`.\n2. `subtract(0, 4)` returns `-4` (negative results).\n\nI can write them in `src/math.test.ts` if you want.",
  ];
  return texts.map((text, seq) => {
    const user = seq % 2 === 0;
    const metadata = { timestamp: t0 + seq * 1000, historySequence: seq };
    const assistantMeta = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      mode: "exec",
      finishReason: "stop",
    };
    return JSON.stringify({
      id: `${user ? "user" : "assistant"}-seed-${seq}`,
      role: user ? "user" : "assistant",
      metadata: user ? metadata : { ...metadata, ...assistantMeta },
      parts: [user ? { type: "text", text, state: "done" } : { type: "text", text }],
      workspaceId,
    });
  });
}

/** Seeds `root` (created if missing) and returns the workspace ID. */
export function seedBootWorkspace(root: string): string {
  const demo = prepareDemoProject(root);
  trustDemoProject(demo);
  fs.writeFileSync(demo.historyPath, `${chatRows(demo.workspaceId).join("\n")}\n`);
  const config = JSON.parse(fs.readFileSync(demo.configPath, "utf8")) as Record<string, unknown>;
  config.viewedSplashScreens = [SEED_VIEWED_SPLASH_ID];
  fs.writeFileSync(demo.configPath, JSON.stringify(config, null, 2));
  return demo.workspaceId;
}
