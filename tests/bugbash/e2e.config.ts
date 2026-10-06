/**
 * e2e (TesterArmy, https://e2e.tester.army) config for agent bug bashes against Xum.
 *
 * `make bug-bash` runs `e2e explore` once per charter in charters.txt. Each run starts its own
 * seeded, mock-AI `xum server` through startApp.ts on a free port (`http://127.0.0.1:0`).
 *
 * Explorer model: `BUGBASH_MODEL` as `<provider>:<model>`, default `anthropic:claude-opus-5-5`.
 * Providers: `anthropic` and `openai` (for example `openai:gpt-6.1-sol`). run.ts sets it once per
 * entry in BUGBASH_MODELS (default Opus 5.5 and Sonnet 5.5); set it yourself only when running
 * e2e directly, for example for a repro test.
 * Reasoning: `BUGBASH_EFFORT` (low, medium, high, xhigh, max; default medium) sets Anthropic
 * `effort` and OpenAI `reasoningEffort`, so runs on different models are comparable.
 * Each provider reads only its standard variables (ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL,
 * OPENAI_API_KEY and OPENAI_BASE_URL), so set them for the run when a gateway needs other
 * values. These credentials stay in the e2e runner: startApp.ts does not pass them to the app.
 */
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

function explorerModel() {
  const spec = process.env.BUGBASH_MODEL ?? "anthropic:claude-opus-5-5";
  const separator = spec.indexOf(":");
  const provider = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  if (separator <= 0 || modelId === "") {
    throw new Error(`BUGBASH_MODEL must be <provider>:<model>, got "${spec}"`);
  }
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    default:
      throw new Error(`BUGBASH_MODEL provider must be anthropic or openai, got "${provider}"`);
  }
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

function explorerEffort(): Effort {
  const value = process.env.BUGBASH_EFFORT ?? "medium";
  const effort = EFFORTS.find((candidate) => candidate === value);
  if (effort == null) {
    throw new Error(`BUGBASH_EFFORT must be one of ${EFFORTS.join(", ")}, got "${value}"`);
  }
  return effort;
}

// What the local app cannot do, and the explorer's own blind spots (see `e2e guide bug-bash`).
const context = [
  "The app is Xum, a desktop and browser app for running parallel AI coding agents.",
  "It starts with one project, demo-app, and one workspace, 'Bug bash playground', in the left sidebar.",
  "AI is mocked: every chat reply is a canned 'Mock response: ...' and background features such as",
  "titles or status may report that model calls are disabled. Those are expected, not bugs.",
  "Prompts starting with [mock:...] trigger scripted flows, for example",
  "'[mock:tool:file-read] What's in README.md?' or '[mock:error:api] Trigger API error'.",
  "Never type into a terminal and never ask for shell commands: they run on the real host.",
  "Opening a terminal to check that it appears is fine; close it again without typing.",
  "Do not sign in to any provider, MCP server or external service, and do not enter real secrets.",
  "Not bugs: a link that opens a new tab leaves this one unchanged; accessible text splits around",
  "inline links, so judge copy by the rendered screen; lazy content needs a scroll and a wait.",
  // Triaged as by design or as mock-AI effects in earlier bug bashes: reporting them again only
  // costs triage time.
  "Also known and not bugs: chat text renders as sanitized Markdown, so <b>, entities and images",
  "render; under mock AI the Stats/Cost tab, the 'Last LLM request' view and token counts stay empty;",
  "the mock echoes your text, and after a retry it may echo [CONTINUE]; the footer row scrolls",
  "sideways, so items at its edges can look cut off; the footer shows the git branch, not the chat",
  "title, and renaming a chat does not rename the branch; the 'Workspace created' row follows the",
  "first message; browser Back leaves the app (in-app history uses Ctrl+[ and Ctrl+]).",
  // Harness limits found by the loop round-1 triage (traces showed the app working).
  "This test browser denies clipboard writes, so copy buttons show no success check here.",
  "On narrow screens the terminal opens in a separate popup window, not in this page.",
  "The demo repo has no 'origin' remote, so Review's default base origin/main shows a git error:",
  "pick the base 'main' instead. Workspace names must be lowercase branch names such as 'alpha-test'.",
  "Already tracked: after the 'Workspace details' button has focus, global shortcuts stop working",
  "until you click elsewhere; click the chat area before testing shortcuts.",
  // Triaged as by design in loop round 2.
  "Also by design: closing a sidebar tab selects its neighbor, like browser tabs; workspace",
  "shortcuts (Ctrl+N, notifications) need a selected workspace; number fields clamp when they lose",
  "focus; a duplicate workspace name gets a random branch suffix; text in an empty field can be",
  "placeholder text; a page reload resets JSON view modes and Artifacts annotate mode; closing",
  "fullscreen returns focus to the Artifacts panel; Artifacts shortcuts work only while focus is in",
  "the panel; the notifications bell button toggles notifications and opens its popover; the",
  "creation form remembers the last source branch, agent and model; sidebar draft previews update",
  "after about one second; Ctrl+/ cycles to the next model; Fast mode is unavailable in this setup.",
].join(" ");

// Exploration steps need large per-step budgets (`e2e guide bug-bash`, step 1).
// Only the active provider reads its key, so both can be set at once.
const effort = explorerEffort();
const persona = {
  model: explorerModel(),
  maxSteps: 40,
  maxModelCalls: 40,
  context,
  providerOptions: { anthropic: { effort }, openai: { reasoningEffort: effort } },
};

const app = {
  url: "http://127.0.0.1:0",
  command: {
    executable: "bun",
    args: ["startApp.ts", "--port", "{port}"],
    // Seeding starts and stops a server before the real one listens.
    startupTimeout: 120_000,
    // run.ts gives each charter its own log; the server output is unredacted.
    log: process.env.BUGBASH_APP_LOG ?? ".e2e/logs/app.log",
  },
};

export default {
  projectId: "xum-bugbash",
  // Repro tests for confirmed findings (the verify step of a bug bash).
  tests: "repros/**/*.e2e.ts",
  targets: [
    { name: "web", engine: web({ viewport: { width: 1440, height: 900 } }), app },
    { name: "phone", engine: web({ viewport: { width: 390, height: 844 } }), app },
  ],
  retries: 0,
  agents: {
    default: persona,
    newcomer: {
      ...persona,
      system:
        "You are a first-time user who has never seen this app. Note every label, empty state or flow that is confusing, inconsistent or broken.",
    },
    keyboard: {
      ...persona,
      system:
        "You are a keyboard power user. Prefer keyboard shortcuts over the mouse, check that every shortcut the UI advertises works, and check where focus lands after each action.",
    },
    fuzzer: {
      ...persona,
      system:
        "At every input, try empty, a 300-character string, unicode and emoji, leading and trailing spaces, and literal special characters such as <b>, ${x} and quotes, judging each result before the next. Never take the happy path.",
    },
    state: {
      ...persona,
      system:
        "After every change, reload the page and go back and forward. Report state that is lost, stale, duplicated or inconsistent between two places that show it.",
    },
    skeptic: {
      ...persona,
      system:
        "Distrust every number, count, label and status on screen. Cross-check each against every other place it appears and report contradictions.",
    },
  },
} satisfies E2EConfig;
