import { z } from "zod";

// The ask_user_question argument schemas, apart from toolDefinitions.ts (which re-exports them):
// the renderer's eager open-question selector (openAskUserQuestions.ts, used by
// StreamingMessageAggregator) parses args with AskUserQuestionToolArgsSchema, and importing
// toolDefinitions.ts there put every tool schema into the main chunk (#7363). Import only zod.

export const AskUserQuestionOptionSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const AskUserQuestionQuestionSchema = z
  .object({
    question: z.string().min(1),
    header: z.string().min(1).max(32).describe("Short UI label"),
    options: z.array(AskUserQuestionOptionSchema).min(2).max(4),
    multiSelect: z.boolean(),
  })
  .strict()
  .superRefine((question, ctx) => {
    const labels = question.options.map((o) => o.label);
    const labelSet = new Set(labels);
    if (labelSet.size !== labels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Option labels must be unique within a question",
        path: ["options"],
      });
    }

    // Claude Code provides "Other" automatically; do not include it explicitly.
    if (labels.some((label) => label.trim().toLowerCase() === "other")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Do not include an 'Other' option; it is provided automatically",
        path: ["options"],
      });
    }
  });

export const AskUserQuestionToolArgsSchema = z
  .object({
    questions: z.array(AskUserQuestionQuestionSchema).min(1).max(4),
    // Optional prefilled answers (Claude Code supports this, though Xum typically won't use it)
    answers: z.record(z.string(), z.string()).nullish(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const questionTexts = args.questions.map((q) => q.question);
    const questionTextSet = new Set(questionTexts);
    if (questionTextSet.size !== questionTexts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question text must be unique across questions",
        path: ["questions"],
      });
    }
  });
