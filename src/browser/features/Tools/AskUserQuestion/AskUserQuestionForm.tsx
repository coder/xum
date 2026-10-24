import { AlertTriangle, Check } from "lucide-react";
import { Fragment, type KeyboardEvent, type RefObject, useEffect, useRef } from "react";

import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "@/browser/features/Tools/Shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "@/browser/features/Tools/Shared/toolUtils";
import { useAutoResizeTextarea } from "@/browser/hooks/useAutoResizeTextarea";
import { cn } from "@/common/lib/utils";
import type { AskUserQuestionQuestion } from "@/common/types/tools";

import {
  type DraftAnswer,
  type DraftAnswers,
  draftToAnswerString,
  EMPTY_DRAFT,
  getDescriptionsForLabels,
  isQuestionAnswered,
  OTHER_VALUE,
  toggleDraftOption,
} from "./askUserQuestionDrafts";

/** Copy that differs between blocking (Plan) and non-blocking (Exec) questions. */
export const ASK_USER_QUESTION_HINTS = {
  blocking: {
    header: "Answer below, or type a message in chat to cancel.",
    footer: "Tip: type a message in chat to cancel these questions.",
  },
  nonBlocking: {
    header: "The agent keeps working; your answers reach it after its current step.",
    footer: "Your answers are sent to the agent as a message.",
  },
} as const;

/** The ask_user_question card header: one for a single card and for the dock's chained form. */
export function AskUserQuestionHeader(props: {
  expanded: boolean;
  onToggle: () => void;
  /** Shown under the tool name while the questions take answers. */
  hint: string | null;
  status: ToolStatus;
}): JSX.Element {
  return (
    <ToolHeader onClick={props.onToggle}>
      <ExpandIcon expanded={props.expanded}>▶</ExpandIcon>
      <ToolIcon toolName="ask_user_question" />
      <div className="flex min-w-0 flex-1 flex-col">
        <ToolName>ask_user_question</ToolName>
        {props.hint != null && (
          <div className="text-secondary text-[10px] leading-tight">{props.hint}</div>
        )}
      </div>
      <StatusIndicator status={props.status}>{getStatusDisplay(props.status)}</StatusIndicator>
    </ToolHeader>
  );
}

/** One ask_user_question call's questions on the form. */
export interface AskUserQuestionFormGroup {
  key: string;
  questions: readonly AskUserQuestionQuestion[];
  drafts: DraftAnswers;
}

/** One question on the form, at its index in the flattened tab order. */
interface FormEntry {
  groupKey: string;
  question: AskUserQuestionQuestion;
  draft: DraftAnswer | undefined;
  answered: boolean;
  index: number;
}

interface FormSection {
  key: string;
  entries: FormEntry[];
}

function buildSections(groups: readonly AskUserQuestionFormGroup[]): FormSection[] {
  let index = 0;
  return groups.map((group) => ({
    key: group.key,
    entries: group.questions.map((question) => {
      const draft = group.drafts[question.question];
      return {
        groupKey: group.key,
        question,
        draft,
        answered: isQuestionAnswered(draft),
        index: index++,
      };
    }),
  }));
}

/** Between two calls' tabs or Summary rows; plays find it by its data attribute. */
function GroupDivider(props: { className: string }): JSX.Element {
  return <span aria-hidden="true" data-question-group-divider="" className={props.className} />;
}

function onEnterOrSpace(action: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      action();
    }
  };
}

/** A question (or Summary) tab: the active tab, a finished one, or one still to do. */
function getQuestionTabClassName(active: boolean, done: boolean): string {
  return cn(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
    active
      ? "border-accent bg-accent text-accent-foreground shadow-sm"
      : done
        ? "border-success/40 bg-success/10 text-success-text hover:bg-success/20"
        : "border-white/10 bg-white/5 text-secondary hover:border-white/20 hover:text-foreground"
  );
}

function QuestionTab(props: {
  label: string;
  active: boolean;
  done: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={getQuestionTabClassName(props.active, props.done)}
      onClick={props.onClick}
    >
      {props.label}
      {props.done && !props.active && <Check aria-hidden="true" className="h-3 w-3" />}
    </button>
  );
}

function QuestionTabs(props: {
  sections: readonly FormSection[];
  activeIndex: number;
  summaryIndex: number;
  answeredCount: number;
  onActivate: (index: number) => void;
}): JSX.Element {
  const isOnSummary = props.activeIndex === props.summaryIndex;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.sections.map((section, sectionIndex) => (
        <Fragment key={section.key}>
          {sectionIndex > 0 && <GroupDivider className="h-4 w-px shrink-0 bg-white/15" />}
          {section.entries.map((entry) => (
            <QuestionTab
              key={entry.question.question}
              label={entry.question.header}
              active={entry.index === props.activeIndex}
              done={entry.answered}
              onClick={() => props.onActivate(entry.index)}
            />
          ))}
        </Fragment>
      ))}
      <QuestionTab
        label="Summary"
        active={isOnSummary}
        done={props.answeredCount === props.summaryIndex}
        onClick={() => props.onActivate(props.summaryIndex)}
      />
      {props.summaryIndex > 0 && (
        <span className="text-muted counter-nums ml-auto text-[10px]">
          {props.answeredCount}/{props.summaryIndex} answered
        </span>
      )}
    </div>
  );
}

/** Auto-resizing textarea for "Other" text input. */
function AutoResizeTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
}): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea(textareaRef, props.value, 30);

  return (
    <textarea
      ref={textareaRef}
      // Keep the empty natural height at one line (textareas default to rows=2) so
      // useAutoResizeTextarea can leave empty drafts to CSS sizing without measuring.
      rows={1}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        // Submit on Enter without shift (shift+Enter for newline)
        if (e.key === "Enter" && !e.shiftKey && props.value.trim().length > 0) {
          e.preventDefault();
          props.onSubmit();
        }
      }}
      className={cn(
        "border border-white/10 bg-code-bg text-foreground placeholder:text-muted",
        "w-full rounded-md px-3 py-2 text-sm",
        "transition-colors hover:border-white/20",
        "focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/50 focus-visible:outline-none",
        "resize-none min-h-[2.5rem] max-h-[30vh] overflow-y-auto"
      )}
    />
  );
}

function OptionRow(props: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 transition-colors select-none",
        props.checked ? "bg-accent/10 hover:bg-accent/15" : "hover:bg-white/5"
      )}
      onClick={props.onToggle}
      onKeyDown={onEnterOrSpace(props.onToggle)}
    >
      <Checkbox
        checked={props.checked}
        onCheckedChange={props.onToggle}
        onClick={(e) => e.stopPropagation()}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col">
        <div
          className={cn(
            "text-sm leading-snug",
            props.checked ? "text-foreground font-medium" : "text-foreground"
          )}
        >
          {props.label}
        </div>
        <div className="text-muted-foreground text-[11px] leading-snug">{props.description}</div>
      </div>
    </div>
  );
}

function QuestionBody(props: {
  question: AskUserQuestionQuestion;
  draft: DraftAnswer;
  onToggle: (label: string) => void;
  onOtherTextChange: (value: string) => void;
  onOtherSubmit: () => void;
}): JSX.Element {
  const options = [
    ...props.question.options.map((opt) => ({
      label: opt.label,
      displayLabel: opt.label,
      description: opt.description,
    })),
    { label: OTHER_VALUE, displayLabel: "Other", description: "Provide a custom answer." },
  ];
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <div className="text-foreground text-sm leading-snug font-medium">
          {props.question.question}
        </div>
        <div className="text-secondary text-[10px] tracking-wide uppercase">
          {props.question.multiSelect ? "Select one or more" : "Select one"}
        </div>
      </div>

      <div className="-mx-2 flex flex-col gap-0.5">
        {options.map((opt) => (
          <OptionRow
            key={opt.label}
            label={opt.displayLabel}
            description={opt.description}
            checked={props.draft.selected.includes(opt.label)}
            onToggle={() => props.onToggle(opt.label)}
          />
        ))}

        {props.draft.selected.includes(OTHER_VALUE) && (
          <div className="mt-1.5 px-2">
            <AutoResizeTextarea
              placeholder="Type your answer"
              value={props.draft.otherText}
              onChange={props.onOtherTextChange}
              onSubmit={props.onOtherSubmit}
            />
          </div>
        )}
      </div>
    </>
  );
}

function SummaryRow(props: { entry: FormEntry; onActivate: (index: number) => void }): JSX.Element {
  const { question, draft } = props.entry;
  const answered = isQuestionAnswered(draft);
  const descriptions = answered ? getDescriptionsForLabels(question, draft.selected) : [];
  const activate = () => props.onActivate(props.entry.index);
  return (
    <div
      role="button"
      tabIndex={0}
      className="bg-code-bg flex cursor-pointer items-start gap-2 rounded border border-white/5 px-2.5 py-1.5 transition-colors hover:border-white/15 hover:bg-white/5"
      onClick={activate}
      onKeyDown={onEnterOrSpace(activate)}
    >
      {answered ? (
        <Check aria-hidden="true" className="text-success-text mt-0.5 h-3 w-3 shrink-0" />
      ) : (
        <AlertTriangle aria-hidden="true" className="text-warning mt-0.5 h-3 w-3 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-secondary text-[10px] tracking-wide uppercase">{question.header}</div>
        <div className="text-sm leading-snug">
          {answered ? (
            <span className="text-foreground">{draftToAnswerString(question, draft)}</span>
          ) : (
            <span className="text-muted italic">Not answered</span>
          )}
        </div>
        {descriptions.length > 0 && (
          <div className="text-muted-foreground text-[11px] italic">{descriptions.join("; ")}</div>
        )}
      </div>
    </div>
  );
}

function AnswerSummary(props: {
  sections: readonly FormSection[];
  unansweredCount: number;
  onActivate: (index: number) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-foreground text-sm font-medium">Review your answers</div>
      {props.unansweredCount > 0 && (
        <div className="border-warning/30 bg-warning/10 text-warning flex items-center gap-1.5 rounded border px-2 py-1 text-[11px]">
          <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>
            {props.unansweredCount} question{props.unansweredCount > 1 ? "s" : ""} not answered
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1">
        {props.sections.map((section, sectionIndex) => (
          <Fragment key={section.key}>
            {sectionIndex > 0 && <GroupDivider className="my-1 block border-t border-white/10" />}
            {section.entries.map((entry) => (
              <SummaryRow
                key={entry.question.question}
                entry={entry}
                onActivate={props.onActivate}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function FormFooter(props: {
  hint: string;
  isOnSummary: boolean;
  isSubmitting: boolean;
  submitButtonRef: RefObject<HTMLButtonElement>;
  onSubmit: () => void;
  onNext: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-2">
      <div className="text-muted min-w-0 flex-1 text-[10px] italic">{props.hint}</div>
      {props.isOnSummary ? (
        <Button
          ref={props.submitButtonRef}
          disabled={props.isSubmitting}
          onClick={props.onSubmit}
          size="sm"
        >
          {props.isSubmitting ? "Submitting…" : "Submit answers"}
        </Button>
      ) : (
        <Button onClick={props.onNext} size="sm" variant="outline">
          Next
        </Button>
      )}
    </div>
  );
}

export interface AskUserQuestionFormProps {
  /** One group per ask_user_question call, in tab order. */
  groups: readonly AskUserQuestionFormGroup[];
  /** Index into every group's questions, flattened; the question count means Summary. */
  activeIndex: number;
  onActivate: (index: number) => void;
  onDraftChange: (
    groupKey: string,
    question: string,
    update: (draft: DraftAnswer) => DraftAnswer
  ) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  submitError: string | null;
  footerHint: string;
}

/**
 * The answering form: question tabs, the active question's options, the Summary and the
 * Next/Submit footer. One group renders a single call's form; the dock chains several open calls
 * into one form, with a divider between calls, one Summary and one Submit.
 */
export function AskUserQuestionForm(props: AskUserQuestionFormProps): JSX.Element {
  const sections = buildSections(props.groups);
  const entries = sections.flatMap((section) => section.entries);
  const summaryIndex = entries.length;
  const isOnSummary = props.activeIndex === summaryIndex;
  const current = isOnSummary ? null : entries[Math.min(props.activeIndex, summaryIndex - 1)];
  const answeredCount = entries.filter((entry) => entry.answered).length;
  const submitButtonRef = useRef<HTMLButtonElement>(null);

  // Focus submit button when reaching summary so Enter submits
  useEffect(() => {
    if (isOnSummary) {
      submitButtonRef.current?.focus();
    }
  }, [isOnSummary]);

  const toggleOption = (entry: FormEntry, label: string) => {
    const isSelecting = !(entry.draft ?? EMPTY_DRAFT).selected.includes(label);
    props.onDraftChange(entry.groupKey, entry.question.question, (draft) =>
      toggleDraftOption(entry.question, draft, label)
    );
    // For single-select questions, auto-advance *only* when the user selects
    // a non-Other option (avoid useEffect auto-advance that breaks back-nav).
    if (!entry.question.multiSelect && isSelecting && label !== OTHER_VALUE) {
      props.onActivate(entry.index + 1);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-3">
        <QuestionTabs
          sections={sections}
          activeIndex={props.activeIndex}
          summaryIndex={summaryIndex}
          answeredCount={answeredCount}
          onActivate={props.onActivate}
        />

        {current && (
          <QuestionBody
            question={current.question}
            draft={current.draft ?? EMPTY_DRAFT}
            onToggle={(label) => toggleOption(current, label)}
            onOtherTextChange={(value) =>
              props.onDraftChange(current.groupKey, current.question.question, (draft) => ({
                ...draft,
                otherText: value,
              }))
            }
            onOtherSubmit={() => props.onActivate(current.index + 1)}
          />
        )}

        {isOnSummary && (
          <AnswerSummary
            sections={sections}
            unansweredCount={summaryIndex - answeredCount}
            onActivate={props.onActivate}
          />
        )}

        {props.submitError && <ErrorBox>{props.submitError}</ErrorBox>}
      </div>

      <FormFooter
        hint={props.footerHint}
        isOnSummary={isOnSummary}
        isSubmitting={props.isSubmitting}
        submitButtonRef={submitButtonRef}
        onSubmit={props.onSubmit}
        onNext={() => props.onActivate(props.activeIndex + 1)}
      />
    </>
  );
}
