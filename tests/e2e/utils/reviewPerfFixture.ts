import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { type Page } from "@playwright/test";
import { TUTORIAL_STATE_KEY } from "../../../src/common/constants/storage";

export const LARGE_CHANGE_ROOT = "src/review/perf-large-change";
const LARGE_CHANGE_GROUP_COUNT = 20;
const LARGE_CHANGE_BUCKETS_PER_GROUP = 10;
const LARGE_CHANGE_FILES_PER_BUCKET = 5;
const LARGE_CHANGE_FILE_COUNT =
  LARGE_CHANGE_GROUP_COUNT * LARGE_CHANGE_BUCKETS_PER_GROUP * LARGE_CHANGE_FILES_PER_BUCKET;

const LARGE_FILE_CHANGE_ROOT = "src/review/perf-large-file";
const LARGE_FILE_CHANGE_PATH = `${LARGE_FILE_CHANGE_ROOT}/hunk-iteration.ts`;
const LARGE_FILE_LINE_COUNT = 1_500;
const LARGE_FILE_HUNK_COUNT = 150;
const LARGE_FILE_HUNK_SPACING = 10;
const MARK_READ_ITERATION_ROOT = "src/review/mark-read-iteration";
const MARK_READ_ITERATION_FILE_COUNT = 4;

export interface LargeReviewDiffSummary {
  rootPath: string;
  fileCount: number;
  directoryCount: number;
  hunkCount: number;
  addedLines: number;
  deletedLines: number;
  changedLinesPerFile: number;
}

export interface LargeReviewSingleFileDiffSummary extends LargeReviewDiffSummary {
  filePath: string;
  lineCount: number;
  hunkSpacing: number;
}

interface LargeReviewDiffOptions {
  changedLinesPerFile?: number;
}

interface LargeReviewSingleFileDiffOptions {
  hunkCount?: number;
  hunkSpacing?: number;
  lineCount?: number;
}

function runGitCommand(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status === 0) {
    return result.stdout;
  }

  const stderr = result.stderr.trim();
  throw new Error(
    `git ${args.join(" ")} failed in ${cwd}: ${stderr || `exit ${result.status ?? "unknown"}`}`
  );
}

function buildLargeReviewFixtureSource(
  fileIndex: number,
  variant: "base" | "modified",
  changedLinesPerFile: number
): string {
  const fileId = String(fileIndex + 1).padStart(3, "0");
  const status = variant === "base" ? "pending" : "ready";
  const normalizedChangedLines = Math.max(1, Math.trunc(changedLinesPerFile));
  const probeLines = Array.from({ length: normalizedChangedLines }, (_, lineIndex) => {
    const lineId = String(lineIndex + 1).padStart(3, "0");
    return `  probeLine${lineId}: "${status}-${fileId}-${lineId}",`;
  });

  return [
    `export const reviewProbe${fileId} = {`,
    `  id: ${fileIndex + 1},`,
    `  checksum: ${5_000 + fileIndex},`,
    `  summary: "Perf review probe ${fileId}",`,
    ...probeLines,
    "};",
    "",
  ].join("\n");
}

function normalizeLargeReviewSingleFileOptions(
  options: LargeReviewSingleFileDiffOptions
): Required<LargeReviewSingleFileDiffOptions> {
  const hunkCount = Math.max(1, Math.trunc(options.hunkCount ?? LARGE_FILE_HUNK_COUNT));
  // Keep hunks far enough apart that Git's default diff context does not merge
  // neighboring changes; otherwise the perf fixture stops exercising hunk iteration.
  const hunkSpacing = Math.max(10, Math.trunc(options.hunkSpacing ?? LARGE_FILE_HUNK_SPACING));
  const minimumLineCount = 1 + (hunkCount - 1) * hunkSpacing;
  const lineCount = Math.max(
    minimumLineCount,
    Math.trunc(options.lineCount ?? LARGE_FILE_LINE_COUNT)
  );

  return { hunkCount, hunkSpacing, lineCount };
}

function buildLargeReviewSingleFileSource(
  variant: "base" | "modified",
  options: Required<LargeReviewSingleFileDiffOptions>
): string {
  const status = variant === "base" ? "pending" : "ready";
  const changedLineNumbers = new Set<number>();
  for (let hunkIndex = 0; hunkIndex < options.hunkCount; hunkIndex += 1) {
    changedLineNumbers.add(1 + hunkIndex * options.hunkSpacing);
  }

  const lines = Array.from({ length: options.lineCount }, (_, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const lineId = String(lineNumber).padStart(4, "0");
    if (changedLineNumbers.has(lineNumber)) {
      return `export const reviewLargeChangedLine${lineId} = "${status}-${lineId}";`;
    }
    return `export const reviewLargeContextLine${lineId} = "stable-${lineId}";`;
  });

  return `${lines.join("\n")}\n`;
}

function countGitDiffHunks(diffOutput: string): number {
  return diffOutput.split("\n").filter((line) => line.startsWith("@@ ")).length;
}

export async function disableReviewTutorial(page: Page): Promise<void> {
  await page.evaluate((tutorialStateKey) => {
    const raw = window.localStorage.getItem(tutorialStateKey);
    const parsed = raw
      ? (JSON.parse(raw) as { disabled?: boolean; completed?: Record<string, boolean> })
      : null;
    window.localStorage.setItem(
      tutorialStateKey,
      JSON.stringify({
        disabled: parsed?.disabled ?? false,
        completed: {
          ...(parsed?.completed ?? {}),
          review: true,
        },
      })
    );
  }, TUTORIAL_STATE_KEY);

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
}

export function seedLargeReviewDiff(
  workspacePath: string,
  options: LargeReviewDiffOptions = {}
): LargeReviewDiffSummary {
  const changedLinesPerFile = Math.max(1, Math.trunc(options.changedLinesPerFile ?? 1));
  const filePaths: string[] = [];
  let fileIndex = 0;

  for (let groupIndex = 0; groupIndex < LARGE_CHANGE_GROUP_COUNT; groupIndex += 1) {
    const groupId = String(groupIndex + 1).padStart(2, "0");
    for (let bucketIndex = 0; bucketIndex < LARGE_CHANGE_BUCKETS_PER_GROUP; bucketIndex += 1) {
      const bucketId = String(bucketIndex + 1).padStart(2, "0");
      for (
        let bucketFileIndex = 0;
        bucketFileIndex < LARGE_CHANGE_FILES_PER_BUCKET;
        bucketFileIndex += 1
      ) {
        const relativePath = [
          LARGE_CHANGE_ROOT,
          `group-${groupId}`,
          `bucket-${bucketId}`,
          `probe-${String(fileIndex + 1).padStart(3, "0")}.ts`,
        ].join("/");
        const filePath = path.join(workspacePath, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          buildLargeReviewFixtureSource(fileIndex, "base", changedLinesPerFile),
          "utf-8"
        );
        filePaths.push(relativePath);
        fileIndex += 1;
      }
    }
  }

  if (filePaths.length !== LARGE_CHANGE_FILE_COUNT) {
    throw new Error(
      `Expected ${LARGE_CHANGE_FILE_COUNT} generated files, received ${filePaths.length}`
    );
  }

  runGitCommand(workspacePath, ["add", LARGE_CHANGE_ROOT]);
  runGitCommand(workspacePath, ["commit", "-q", "-m", "Seed review perf fixture"]);

  for (const [index, relativePath] of filePaths.entries()) {
    const filePath = path.join(workspacePath, ...relativePath.split("/"));
    fs.writeFileSync(
      filePath,
      buildLargeReviewFixtureSource(index, "modified", changedLinesPerFile),
      "utf-8"
    );
  }

  const hunkCount = filePaths.length;
  let addedLines = 0;
  let deletedLines = 0;
  const numstatOutput = runGitCommand(workspacePath, ["diff", "HEAD", "--numstat"]).trim();
  const numstatLines = numstatOutput.split("\n").filter(Boolean);
  if (numstatLines.length !== filePaths.length) {
    throw new Error(
      `Expected ${filePaths.length} changed files in seeded diff, received ${numstatLines.length}`
    );
  }

  for (const line of numstatLines) {
    const [addedText = "0", deletedText = "0"] = line.split("\t");
    addedLines += Number.parseInt(addedText, 10) || 0;
    deletedLines += Number.parseInt(deletedText, 10) || 0;
  }

  return {
    rootPath: LARGE_CHANGE_ROOT,
    fileCount: filePaths.length,
    directoryCount:
      2 + LARGE_CHANGE_GROUP_COUNT + LARGE_CHANGE_GROUP_COUNT * LARGE_CHANGE_BUCKETS_PER_GROUP,
    hunkCount,
    addedLines,
    deletedLines,
    changedLinesPerFile,
  };
}

export interface ReviewMarkReadIterationDiffSummary extends LargeReviewDiffSummary {
  filePaths: string[];
}

export function seedReviewMarkReadIterationDiff(
  workspacePath: string
): ReviewMarkReadIterationDiffSummary {
  const filePaths = Array.from({ length: MARK_READ_ITERATION_FILE_COUNT }, (_, fileIndex) => {
    const fileId = String(fileIndex + 1).padStart(2, "0");
    return `${MARK_READ_ITERATION_ROOT}/probe-${fileId}.ts`;
  });

  for (const [fileIndex, relativePath] of filePaths.entries()) {
    const filePath = path.join(workspacePath, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buildLargeReviewFixtureSource(fileIndex, "base", 1), "utf-8");
  }

  runGitCommand(workspacePath, ["add", MARK_READ_ITERATION_ROOT]);
  runGitCommand(workspacePath, ["commit", "-q", "-m", "Seed mark-read review fixture"]);

  for (const [fileIndex, relativePath] of filePaths.entries()) {
    const filePath = path.join(workspacePath, ...relativePath.split("/"));
    fs.writeFileSync(filePath, buildLargeReviewFixtureSource(fileIndex, "modified", 1), "utf-8");
  }

  const diffOutput = runGitCommand(workspacePath, ["diff", "HEAD", "--", MARK_READ_ITERATION_ROOT]);
  const hunkCount = countGitDiffHunks(diffOutput);
  if (hunkCount !== filePaths.length) {
    throw new Error(`Expected ${filePaths.length} mark-read hunks, received ${hunkCount}`);
  }

  const numstatOutput = runGitCommand(workspacePath, [
    "diff",
    "HEAD",
    "--numstat",
    "--",
    MARK_READ_ITERATION_ROOT,
  ]).trim();
  let addedLines = 0;
  let deletedLines = 0;
  for (const line of numstatOutput.split("\n").filter(Boolean)) {
    const [addedText = "0", deletedText = "0"] = line.split("\t");
    addedLines += Number.parseInt(addedText, 10) || 0;
    deletedLines += Number.parseInt(deletedText, 10) || 0;
  }

  return {
    rootPath: MARK_READ_ITERATION_ROOT,
    filePaths,
    fileCount: filePaths.length,
    directoryCount: 3,
    hunkCount,
    addedLines,
    deletedLines,
    changedLinesPerFile: 1,
  };
}

const HYDRATION_JUMP_CHANGE_ROOT = "src/review/hydration-jump";
const HYDRATION_JUMP_CHANGE_PATH = `${HYDRATION_JUMP_CHANGE_ROOT}/hydration-jump.ts`;
const HYDRATION_JUMP_LINE_COUNT = 1_000;
const HYDRATION_JUMP_CHANGED_LINE = 500;

export interface ReviewHydrationJumpDiffSummary extends LargeReviewDiffSummary {
  filePath: string;
  lineCount: number;
  changedLineNumber: number;
  selectedAddedText: string;
}

function buildReviewHydrationJumpSource(
  variant: "base" | "modified",
  lineCount: number,
  changedLineNumber: number
): string {
  const status = variant === "base" ? "pending" : "ready";
  const lines = Array.from({ length: lineCount }, (_, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const lineId = String(lineNumber).padStart(4, "0");
    if (lineNumber === changedLineNumber) {
      return `export const reviewHydrationJumpChangedLine${lineId} = "${status}-${lineId}";`;
    }
    return `export const reviewHydrationJumpContextLine${lineId} = "stable-${lineId}";`;
  });

  return `${lines.join("\n")}\n`;
}

export function seedReviewHydrationJumpDiff(workspacePath: string): ReviewHydrationJumpDiffSummary {
  const filePath = path.join(workspacePath, ...HYDRATION_JUMP_CHANGE_PATH.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    buildReviewHydrationJumpSource("base", HYDRATION_JUMP_LINE_COUNT, HYDRATION_JUMP_CHANGED_LINE),
    "utf-8"
  );

  runGitCommand(workspacePath, ["add", HYDRATION_JUMP_CHANGE_PATH]);
  runGitCommand(workspacePath, ["commit", "-q", "-m", "Seed hydration jump review fixture"]);

  fs.writeFileSync(
    filePath,
    buildReviewHydrationJumpSource(
      "modified",
      HYDRATION_JUMP_LINE_COUNT,
      HYDRATION_JUMP_CHANGED_LINE
    ),
    "utf-8"
  );

  const diffOutput = runGitCommand(workspacePath, [
    "diff",
    "HEAD",
    "--",
    HYDRATION_JUMP_CHANGE_PATH,
  ]);
  const hunkCount = countGitDiffHunks(diffOutput);
  if (hunkCount !== 1) {
    throw new Error(`Expected one hydration-jump hunk, received ${hunkCount}`);
  }

  const numstatOutput = runGitCommand(workspacePath, [
    "diff",
    "HEAD",
    "--numstat",
    "--",
    HYDRATION_JUMP_CHANGE_PATH,
  ]).trim();
  const [addedText = "0", deletedText = "0"] = numstatOutput.split("\t");
  const lineId = String(HYDRATION_JUMP_CHANGED_LINE).padStart(4, "0");

  return {
    rootPath: HYDRATION_JUMP_CHANGE_ROOT,
    filePath: HYDRATION_JUMP_CHANGE_PATH,
    fileCount: 1,
    directoryCount: 3,
    hunkCount,
    addedLines: Number.parseInt(addedText, 10) || 0,
    deletedLines: Number.parseInt(deletedText, 10) || 0,
    changedLinesPerFile: 1,
    lineCount: HYDRATION_JUMP_LINE_COUNT,
    changedLineNumber: HYDRATION_JUMP_CHANGED_LINE,
    selectedAddedText: `ready-${lineId}`,
  };
}

export function seedLargeReviewSingleFileDiff(
  workspacePath: string,
  options: LargeReviewSingleFileDiffOptions = {}
): LargeReviewSingleFileDiffSummary {
  const normalizedOptions = normalizeLargeReviewSingleFileOptions(options);
  const filePath = path.join(workspacePath, ...LARGE_FILE_CHANGE_PATH.split("/"));

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildLargeReviewSingleFileSource("base", normalizedOptions), "utf-8");

  runGitCommand(workspacePath, ["add", LARGE_FILE_CHANGE_PATH]);
  runGitCommand(workspacePath, ["commit", "-q", "-m", "Seed large review file perf fixture"]);

  fs.writeFileSync(
    filePath,
    buildLargeReviewSingleFileSource("modified", normalizedOptions),
    "utf-8"
  );

  const diffOutput = runGitCommand(workspacePath, ["diff", "HEAD", "--", LARGE_FILE_CHANGE_PATH]);
  const hunkCount = countGitDiffHunks(diffOutput);
  if (hunkCount !== normalizedOptions.hunkCount) {
    throw new Error(
      `Expected ${normalizedOptions.hunkCount} hunks in large-file fixture, received ${hunkCount}`
    );
  }

  const numstatOutput = runGitCommand(workspacePath, [
    "diff",
    "HEAD",
    "--numstat",
    "--",
    LARGE_FILE_CHANGE_PATH,
  ]).trim();
  const [addedText = "0", deletedText = "0"] = numstatOutput.split("\t");

  return {
    rootPath: LARGE_FILE_CHANGE_ROOT,
    filePath: LARGE_FILE_CHANGE_PATH,
    fileCount: 1,
    directoryCount: 3,
    hunkCount,
    addedLines: Number.parseInt(addedText, 10) || 0,
    deletedLines: Number.parseInt(deletedText, 10) || 0,
    changedLinesPerFile: hunkCount,
    lineCount: normalizedOptions.lineCount,
    hunkSpacing: normalizedOptions.hunkSpacing,
  };
}
