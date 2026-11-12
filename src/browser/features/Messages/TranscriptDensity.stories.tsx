import { expect, userEvent, waitFor, within } from "storybook/test";
import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, PIXEL_DISABLED, PIXEL_DUAL_THEME } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar } from "@/browser/stories/helpers/uiState";
import {
  createAssistantMessage,
  createSubagentReportMessage,
  createUserMessage,
} from "@/browser/stories/mocks/messages";
import {
  createBashTool,
  createFileEditTool,
  createFileReadTool,
  createGenericTool,
  createPendingTool,
  createProposePlanTool,
  createTodoWriteTool,
  createWebSearchTool,
} from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import type { TranscriptDensity } from "@/common/constants/storage";
import type { ChatMuxMessage } from "@/common/orpc/types";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";
import { PhoneSubagentReportDecorator } from "@/browser/stories/helpers/subagentReportStory";

const meta = { ...appMeta, title: "App/Chat/Transcript Density" };
export default meta;

const text = (value: string, timestamp: number) => ({
  type: "text" as const,
  text: value,
  timestamp,
});

const EDIT_DIFF = [
  "--- src/auth/session.ts",
  "+++ src/auth/session.ts",
  "@@ -12,2 +12,3 @@",
  " export function verify(token: string) {",
  "+  if (isExpired(token)) return false;",
  "   return timingSafeEqual(sign(token), token);",
].join("\n");

/**
 * A turn the way agents really work: narration between every few calls, so no run of calls is
 * long, and the reply comes after a dozen steps. This is the shape that made the transcript noisy.
 */
function createWorkingSession(): ChatMuxMessage[] {
  const start = STABLE_TIMESTAMP - 600_000;
  return [
    createUserMessage(
      "turn-1-user",
      "Sessions stay valid after they expire. Find out why and fix it.",
      {
        historySequence: 1,
        timestamp: start,
      }
    ),
    createAssistantMessage("turn-1-assistant", "I'll start with how a session token is verified.", {
      historySequence: 2,
      timestamp: start + 4_000,
      reasoning:
        "The report says expired sessions still pass. That is either the expiry check or the cache in front of it.",
      toolCalls: [
        createFileReadTool("turn-1-read-1", "src/auth/session.ts", "export function verify() {}"),
        createFileReadTool("turn-1-read-2", "src/auth/cache.ts", "export const cache = new Map();"),
        createBashTool(
          "turn-1-grep",
          "rg -n isExpired src",
          "src/auth/clock.ts:4",
          0,
          30,
          400,
          "Finding expiry checks"
        ),
        text(
          "verify() never calls isExpired(): the check was dropped in a refactor. Adding it back.",
          start + 31_000
        ),
        createFileEditTool("turn-1-edit-1", "src/auth/session.ts", EDIT_DIFF),
        createBashTool(
          "turn-1-test-1",
          "make test",
          "1 failed: session.test.ts",
          1,
          30,
          9_000,
          "Running the tests"
        ),
        text(
          "One test pinned the old behaviour. Updating it to expect a rejection.",
          start + 70_000
        ),
        createFileReadTool(
          "turn-1-read-3",
          "src/auth/session.test.ts",
          "test('accepts', () => {});"
        ),
        createFileEditTool("turn-1-edit-2", "src/auth/session.test.ts", EDIT_DIFF),
        createBashTool(
          "turn-1-test-2",
          "make test",
          "212 passed",
          0,
          30,
          9_000,
          "Running the tests"
        ),
        createBashTool("turn-1-typecheck", "make typecheck", "ok", 0, 30, 14_000, "Typechecking"),
        text(
          [
            "Expired sessions were accepted because `verify()` no longer called `isExpired()`.",
            "",
            "- **Fix:** `verify()` rejects an expired token before it compares signatures.",
            "- **Test:** `session.test.ts` now expects the rejection.",
            "",
            "Tests and typecheck pass.",
          ].join("\n"),
          start + 134_000
        ),
        createTodoWriteTool("turn-1-todo", "Fix expired sessions", "completed"),
      ],
    }),
    createUserMessage("turn-2-user", "Is the same check missing from the refresh path?", {
      historySequence: 3,
      timestamp: start + 300_000,
    }),
    createAssistantMessage("turn-2-assistant", "", {
      historySequence: 4,
      timestamp: start + 302_000,
      reasoning: "Refresh goes through rotate(), which calls verify() first.",
      toolCalls: [
        text(
          "No. `rotate()` calls `verify()` before it issues a new token, so the fix covers it.",
          start + 309_000
        ),
      ],
    }),
  ];
}

function setupSessionStory(density: TranscriptDensity, extra: ChatMuxMessage[] = []) {
  collapseLeftSidebar();
  return setupSimpleChatStory({
    userPreferences: { appearance: { transcriptDensity: density } },
    messages: [...createWorkingSession(), ...extra],
  });
}

/**
 * Compact (the default): what the agent wrote stays in view, and the steps between two of its
 * updates fold behind one line that says what they did.
 */
export const CompactTurns: AppStory = {
  parameters: { pixel: { matrix: PIXEL_DUAL_THEME } },
  render: () => <AppWithMocks setup={() => setupSessionStory("hyper")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const workLine = await canvas.findByRole(
      "button",
      { name: "Read 2 files, ran 1 command" },
      { timeout: 15_000 }
    );
    await expect(workLine).toHaveAttribute("aria-expanded", "false");
    // The updates read as regular text between the lines, and the reply after them.
    await canvas.findByText(/Adding it back/);
    await canvas.findByText(/Tests and typecheck pass/);
    // A line says when a step failed, and the steps themselves are out of sight.
    await canvas.findByRole("button", { name: "Edited 1 file, ran 1 command · 1 failed" });
    await expect(canvas.queryByText("src/auth/cache.ts")).toBeNull();
    await expect(canvas.queryByText("make typecheck")).toBeNull();
  },
};

export const CompactTurnsPhone: AppStory = {
  ...CompactTurns,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  decorators: [PhoneSubagentReportDecorator],
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
};

/** Opening a work line lists its steps in place, on a rail between the two updates. */
export const CompactTurnOpened: AppStory = {
  // Pixel executes this play function for the visual snapshot, while the
  // app-level UI test covers expansion behavior without Storybook's manager-page timing.
  tags: ["!test"],
  render: () => <AppWithMocks setup={() => setupSessionStory("hyper")} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const workLine = await canvas.findByRole(
      "button",
      { name: "Read 2 files, ran 1 command" },
      { timeout: 15_000 }
    );
    await userEvent.click(workLine);
    await waitFor(() => expect(workLine).toHaveAttribute("aria-expanded", "true"), {
      timeout: 15_000,
    });
    await canvas.findByText("src/auth/cache.ts");
    // Density snapshot, not a focus one: headless Chromium treats scripted focus as :focus-visible.
    workLine.blur();
  },
};

/**
 * What compact density never folds, and what a live turn shows: an answered question and a plan
 * stay in the conversation, and the turn in progress shows its updates with a line under the
 * latest that names the step it is on. No step mounts as a row under that line.
 */
export const CompactStopsAndLiveTurn: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const liveStartedAt = Date.now() - 39_000;
        const questions = [
          {
            question: "Should expired sessions be deleted or only rejected?",
            header: "Expiry",
            options: [
              { label: "Reject only", description: "Leave the row for the audit log." },
              { label: "Delete", description: "Remove the row at once." },
            ],
            multiSelect: false,
          },
        ];
        return setupSimpleChatStory({
          // Its own workspace: the test runner plays a file's stories in one page, where the
          // default workspace still holds the session of the stories above.
          workspaceId: "ws-density-stops",
          userPreferences: { appearance: { transcriptDensity: "hyper" } },
          messages: [
            createUserMessage("stops-user-1", "Plan the session cleanup job", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 120_000,
            }),
            createAssistantMessage("stops-assistant-1", "", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 118_000,
              toolCalls: [
                createFileReadTool(
                  "stops-read-1",
                  "src/auth/session.ts",
                  "export function verify() {}"
                ),
                createWebSearchTool("stops-search-1", "session cleanup cron best practices", 4),
                createGenericTool(
                  "stops-question-1",
                  "ask_user_question",
                  { questions },
                  { questions, answers: { [questions[0].question]: "Reject only" } }
                ),
                createFileReadTool("stops-read-2", "src/jobs/index.ts", "export const jobs = [];"),
                text("Here is the plan.", STABLE_TIMESTAMP - 70_000),
                createProposePlanTool(
                  "stops-plan-1",
                  [
                    "# Session cleanup job",
                    "",
                    "1. Add `jobs/expireSessions.ts`.",
                    "2. Run it hourly.",
                  ].join("\n")
                ),
              ],
            }),
            createUserMessage("stops-user-2", "Go ahead", {
              historySequence: 3,
              timestamp: liveStartedAt,
            }),
            createAssistantMessage("stops-assistant-2", "Adding the job first.", {
              historySequence: 4,
              timestamp: liveStartedAt + 2_000,
              toolCalls: [
                createFileEditTool("live-edit-1", "src/jobs/expireSessions.ts", EDIT_DIFF),
                createFileReadTool("live-read-1", "src/jobs/index.ts", "export const jobs = [];"),
                text("Registering it and running the tests.", liveStartedAt + 20_000),
                createFileEditTool("live-edit-2", "src/jobs/index.ts", EDIT_DIFF),
                createPendingTool("live-test-1", "bash", {
                  script: "make test",
                  timeout_secs: 120,
                  model_intent: "Running the test suite",
                }),
              ],
            }),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The live line names the running step in place.
    await canvas.findByRole("button", { name: "Running the test suite" }, { timeout: 15_000 });
    // The turn's updates are in view. The running call is not a row that comes and goes, and
    // the steps before it are behind their own line.
    await canvas.findByText("Adding the job first.");
    await canvas.findByText("Registering it and running the tests.");
    await canvas.findByRole("button", { name: "Edited 1 file, read 1 file" });
    await expect(canvas.queryByText("make test")).toBeNull();
    await expect(canvas.queryByText("src/jobs/expireSessions.ts")).toBeNull();
    // Stops stay in the conversation.
    await canvas.findByText("Here is the plan.");
    await canvas.findByText("Session cleanup job");
  },
};

const REVIEW_REPORT_TITLE = "Token check reviewed";

/**
 * Prompts the machine writes in the middle of the agent's work (a sub-agent's report, the
 * wake-up that follows it) are steps of that work: they fold with the steps around them, and
 * opened they sit on the left with those steps, not in user bubbles on the right.
 * A turn the user stopped earlier carries no divider: the conversation went on.
 */
export const CompactMachineSteps: AppStory = {
  // The Pixel snapshot budget is spent: the play function is the contract.
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const at = (seconds: number) => STABLE_TIMESTAMP - 600_000 + seconds * 1000;
        return setupSimpleChatStory({
          workspaceId: "ws-density-machine-steps",
          userPreferences: { appearance: { transcriptDensity: "hyper" } },
          messages: [
            createUserMessage("steps-user-0", "Review the auth module", {
              historySequence: 1,
              timestamp: at(0),
            }),
            // Stopped by the user, who then asked again.
            createAssistantMessage("steps-assistant-0", "Starting with the session store.", {
              historySequence: 2,
              timestamp: at(2),
              partial: true,
              toolCalls: [
                createFileReadTool("steps-read-0", "src/auth/store.ts", "export const store = {};"),
              ],
            }),
            createUserMessage("steps-user-1", "Use two sub-agents for it", {
              historySequence: 3,
              timestamp: at(20),
            }),
            createAssistantMessage("steps-assistant-1", "", {
              historySequence: 4,
              timestamp: at(22),
              toolCalls: [
                createFileReadTool(
                  "steps-read-1",
                  "src/auth/session.ts",
                  "export function verify() {}"
                ),
                text("Two sub-agents are reviewing it. I will report when they finish.", at(30)),
              ],
            }),
            createSubagentReportMessage("steps-report-1", {
              historySequence: 5,
              timestamp: at(150),
              taskId: "task-review-1",
              agentType: "explore",
              title: REVIEW_REPORT_TITLE,
              reportMarkdown: "The token check compares in constant time.",
            }),
            createSubagentReportMessage("steps-report-2", {
              historySequence: 6,
              timestamp: at(151),
              taskId: "task-review-2",
              agentType: "explore",
              title: "Expiry handling reviewed",
              reportMarkdown: "Expired sessions are rejected before the store is read.",
            }),
            createUserMessage(
              "steps-wake-1",
              `${BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted} Read the reports and continue.`,
              { historySequence: 7, timestamp: at(152), synthetic: true }
            ),
            createAssistantMessage("steps-assistant-2", "", {
              historySequence: 8,
              timestamp: at(154),
              toolCalls: [
                createFileReadTool(
                  "steps-read-2",
                  "src/auth/expiry.ts",
                  "export const ttl = 3600;"
                ),
                text("Both reviews agree: the module is sound.", at(170)),
              ],
            }),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Both reviews agree: the module is sound.", {}, { timeout: 15_000 });
    // One line for each run of steps between two things the agent wrote. Closed, the reports
    // and the wake-up are behind the lines.
    const lines = canvas.getAllByTestId("work-bundle");
    await expect(lines).toHaveLength(3);
    await expect(canvas.queryByText(REVIEW_REPORT_TITLE)).toBeNull();
    await expect(canvasElement.querySelector("[data-background-work-wake]")).toBeNull();
    // The stopped turn further up has no divider and no control.
    await expect(canvas.queryByText(/^interrupted$/i)).toBeNull();

    // The transcript shows a report where the agent was when the sub-agent finished: with the
    // work before the reply. The wake-up heads the work it started.
    await userEvent.click(lines[1]);
    await userEvent.click(lines[2]);
    const [reportSteps, wakeSteps] = await canvas.findAllByTestId("work-bundle-steps");
    await within(reportSteps).findByText(REVIEW_REPORT_TITLE);
    await expect(wakeSteps.querySelector("[data-background-work-wake]")).not.toBeNull();
    // A report is a step on the agent's side: its row starts at the left edge of the steps.
    const report = within(reportSteps)
      .getByText(REVIEW_REPORT_TITLE)
      .closest("[data-message-block]");
    if (!(report instanceof HTMLElement)) throw new Error("The report row is not a message block");
    const offset = report.getBoundingClientRect().left - reportSteps.getBoundingClientRect().left;
    if (offset > 24) throw new Error(`The report row sits ${offset}px in: it reads as a prompt`);
  },
};

const LONG_SESSION_TURNS = 6;
const LONG_SESSION_STEPS_PER_TURN = 30;
// An update before every third step: two steps, nine runs of three, and the last step.
const LONG_SESSION_LINES_PER_TURN = 11;

/**
 * A long session: every turn is dozens of steps, so the transcript is hundreds of rows while it
 * reads as six exchanges with their updates.
 */
function createLongSession(): ChatMuxMessage[] {
  const start = STABLE_TIMESTAMP - 6 * 3_600_000;
  const messages: ChatMuxMessage[] = [];
  for (let turn = 1; turn <= LONG_SESSION_TURNS; turn++) {
    const turnStart = start + turn * 600_000;
    const steps: NonNullable<Parameters<typeof createAssistantMessage>[2]["toolCalls"]> = [];
    for (let step = 1; step <= LONG_SESSION_STEPS_PER_TURN; step++) {
      const id = `long-${turn}-${step}`;
      if (step % 3 === 0) {
        steps.push(
          text(`Step ${step} of part ${turn}: checking the next module.`, turnStart + step * 9_000)
        );
      }
      steps.push(
        step % 5 === 0
          ? createFileEditTool(id, `src/part${turn}/module${step}.ts`, EDIT_DIFF)
          : step % 2 === 0
            ? createBashTool(id, `make test-part-${turn}`, "ok", 0, 30, 4_000, "Running the tests")
            : createFileReadTool(id, `src/part${turn}/module${step}.ts`, "export {};")
      );
    }
    steps.push(
      text(
        `Part ${turn} is done: its six modules are migrated and their tests pass.`,
        turnStart + 290_000
      )
    );
    messages.push(
      createUserMessage(`long-user-${turn}`, `Migrate part ${turn} to the new session API`, {
        historySequence: turn * 2 - 1,
        timestamp: turnStart,
      }),
      createAssistantMessage(`long-assistant-${turn}`, "", {
        historySequence: turn * 2,
        timestamp: turnStart + 2_000,
        toolCalls: steps,
      })
    );
  }
  return messages;
}

/**
 * A long session in compact density. Nothing is cut out of it: every earlier turn still shows
 * its prompt, its updates and its reply.
 */
export const CompactLongSession: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
          workspaceId: "ws-density-long",
          userPreferences: { appearance: { transcriptDensity: "hyper" } },
          messages: createLongSession(),
        });
      }}
    />
  ),
  // The play function is the contract here; CompactTurns is the snapshot of the same layout.
  parameters: { pixel: PIXEL_DISABLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The oldest turn is in the transcript with the newest: nothing is replaced by a marker.
    await canvas.findByText("Migrate part 1 to the new session API", undefined, {
      timeout: 15_000,
    });
    const oldestReply = await canvas.findByText(/^Part 1 is done/);
    const latestReply = await canvas.findByText(new RegExp(`^Part ${LONG_SESSION_TURNS} is done`));
    await expect(canvas.queryByText(/hidden for performance/i)).toBeNull();
    await expect(canvas.queryByRole("button", { name: /load older/i })).toBeNull();
    await canvas.findByText("Step 3 of part 1: checking the next module.");
    await waitFor(() =>
      expect(canvas.getAllByTestId("work-bundle")).toHaveLength(
        LONG_SESSION_TURNS * LONG_SESSION_LINES_PER_TURN
      )
    );

    // With a pointer, only the latest reply keeps its actions in view; an older reply shows
    // them when the pointer or the keyboard is on it. Touch always shows them.
    if (window.matchMedia("(hover: hover)").matches) {
      const metaOpacity = (reply: HTMLElement) => {
        const meta = reply.closest("[data-message-block]")?.querySelector("[data-message-meta]");
        return meta ? getComputedStyle(meta).opacity : undefined;
      };
      await expect(metaOpacity(latestReply)).toBe("1");
      await expect(metaOpacity(oldestReply)).toBe("0");
    }
  },
};

const LONG_STRETCH_STEPS = 40;

/**
 * A stretch with no update in it is as long as its steps. Opened, its line stays at the top of
 * the transcript while the steps scroll under it, so it can be closed from anywhere in them:
 * before, closing it meant scrolling all the way back up to the line.
 */
export const CompactLongStretchOpened: AppStory = {
  // The Pixel snapshot budget is spent: the play function is the contract.
  parameters: { pixel: PIXEL_DISABLED },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const start = STABLE_TIMESTAMP - 600_000;
        return setupSimpleChatStory({
          workspaceId: "ws-density-long-stretch",
          userPreferences: { appearance: { transcriptDensity: "hyper" } },
          messages: [
            createUserMessage("stretch-user", "Audit every module for the old session API", {
              historySequence: 1,
              timestamp: start,
            }),
            createAssistantMessage("stretch-assistant", "Reading the modules.", {
              historySequence: 2,
              timestamp: start + 2_000,
              toolCalls: [
                ...Array.from({ length: LONG_STRETCH_STEPS }, (_, step) =>
                  createFileReadTool(`stretch-read-${step}`, `src/module${step}.ts`, "export {};")
                ),
                text("None of them uses the old API.", start + 120_000),
              ],
            }),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const line = await canvas.findByRole(
      "button",
      { name: `Read ${LONG_STRETCH_STEPS} files` },
      { timeout: 15_000 }
    );
    await userEvent.click(line);
    const steps = await canvas.findByTestId("work-bundle-steps");
    const scrollport = canvasElement.querySelector('[role="log"]')?.parentElement;
    if (!(scrollport instanceof HTMLElement)) throw new Error("No transcript scrollport");
    if (steps.getBoundingClientRect().height <= scrollport.clientHeight) {
      throw new Error("The opened steps fit on screen: the story no longer tests a long stretch");
    }

    // Scroll into the middle of the steps: the line's own place is far above the screen.
    const middle = within(steps).getByText(`src/module${LONG_STRETCH_STEPS / 2}.ts`);
    middle.scrollIntoView({ block: "center" });
    await waitFor(() => {
      const top = scrollport.getBoundingClientRect().top;
      const lineBox = line.getBoundingClientRect();
      if (steps.getBoundingClientRect().top >= top) {
        throw new Error("The transcript did not scroll into the steps");
      }
      if (lineBox.top < top || lineBox.top > top + 24) {
        throw new Error(`The opened line is ${lineBox.top - top}px from the top of the transcript`);
      }
      // Nothing covers it: the pointer reaches the line, not a step scrolled under it.
      const hit = document.elementFromPoint(lineBox.left + 4, lineBox.top + lineBox.height / 2);
      if (hit === null || !line.contains(hit)) {
        throw new Error("The opened line is covered by the steps under it");
      }
    });

    await userEvent.click(line);
    await waitFor(() => expect(canvas.queryByTestId("work-bundle-steps")).toBeNull());
    await canvas.findByText("None of them uses the old API.");
  },
};

/** Detailed: every step is a row, and only runs of routine calls fold. */
export const DetailedTranscript: AppStory = {
  render: () => <AppWithMocks setup={() => setupSessionStory("normal")} />,
};
