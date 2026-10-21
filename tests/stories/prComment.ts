/**
 * The PR story lane's results as one comment on the PR (pr.yml stories-pr-comment), after
 * stories.yml uploaded its reports. The user's picks: each PR where the Haiku lane runs gets one
 * comment, with a section per sandbox job, and each push edits it. The body is the job
 * summary's page (summary.ts storyPage), with the links that only a PR run has.
 *
 * `bun tests/stories/prComment.ts <reports dir> [--dry-run]`: `<reports dir>` holds the
 * artifact `stories-reports-<attempt>` (the checkout's job outputs, and `first-try/` after the
 * lane's 5xx retry). `--dry-run` prints the body and calls nothing. Else it reads GITHUB_TOKEN,
 * GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
 * PR_NUMBER, HEAD_SHA, SOURCE_SHA and REPORTS_ARTIFACT, and BUGBASH_MODEL for the titles.
 *
 * The write token never meets PR code from the checkout: the job runs this file from the PR's
 * base commit, and the reports are data that the PR's tests wrote. The e2e renderer escapes their
 * text. (The job's steps come from the PR's pr.yml, as for any pull_request job: see pr.yml.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { jobSections, storyPage } from "./summary";

/** The comment's first line, exactly: how the next run finds the comment to edit. */
export const MARKER = "<!-- xum-stories-pr-comment -->";
/** The account GITHUB_TOKEN posts as. A user's comment never matches, marker or not. */
const BOT_LOGIN = "github-actions[bot]";
/** Under GitHub's 65,536-character limit for a comment body, with room to spare. */
export const MAX_BODY_CHARS = 64_000;
const PER_PAGE = 100;
/** A guard against a server that never sends a short page: 10,000 comments. */
const MAX_PAGES = 100;

export interface CommentContext {
  apiUrl: string;
  serverUrl: string;
  repository: string;
  pullRequest: number;
  /** The PR head commit (the event's head.sha): the comment is written only while it is the head. */
  headSha: string;
  /**
   * The commit the lane checked out and tested: the PR merge commit (github.sha). Source links
   * point here, so their lines match the report even when the branch is behind its base (Codex
   * review of #7140).
   */
  sourceSha: string;
  runId: string;
  runAttempt: string;
  /**
   * The artifact the reports came from: the lane job's upload (stories.yml reports_artifact).
   * A rerun of only the comment job has a newer run_attempt than that upload (Codex review of
   * #7140), so the retry note names this, not stories-reports-<runAttempt>.
   */
  reportsArtifact: string;
  model?: string;
}

/** A link to `file` (from the checkout root) at the tested commit, each path segment encoded. */
export function sourceUrl(ctx: CommentContext, file: string, line: number): string {
  // encodeURIComponent leaves ( ) ! * ' as they are, and a ")" ends a markdown link early.
  const encode = (part: string) =>
    encodeURIComponent(part).replace(
      /[()!*']/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
  const segments = file.split("/").map(encode).join("/");
  return `${ctx.serverUrl}/${ctx.repository}/blob/${ctx.sourceSha}/${segments}#L${line}`;
}

/** The comment body: the marker, then the page of every job under `root`. */
export function commentBody(root: string, ctx: CommentContext): string {
  const runUrl = `${ctx.serverUrl}/${ctx.repository}/actions/runs/${ctx.runId}`;
  const sections = jobSections(root, {
    model: ctx.model,
    artifactsUrl: `${runUrl}#artifacts`,
    sourceUrl: (file, line) => sourceUrl(ctx, file, line),
  });
  // stories.yml's test step moves the first run's outputs there before the one retry.
  const retried = fs.existsSync(path.join(root, "first-try"));
  const note = retried
    ? `\nRetried once: the first run got a provider 5xx. Its reports are in the artifact ` +
      `\`${ctx.reportsArtifact}\`, folder \`first-try\`.\n`
    : "";
  const head = `${MARKER}\n`;
  const body = `${head}${storyPage(sections, MAX_BODY_CHARS - head.length - note.length)}${note}`;
  if (body.length > MAX_BODY_CHARS) throw new Error(`comment body is ${body.length} characters`);
  return body;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Api = (method: string, route: string, body?: unknown) => Promise<unknown>;

/** GitHub's REST API with the token. An error names the failed call, never the token. */
function client(ctx: CommentContext, token: string, fetchFn: Fetch): Api {
  return async (method, route, body) => {
    const response = await fetchFn(`${ctx.apiUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`GitHub responded ${response.status} to ${method} ${route}: ${detail}`);
    }
    return (await response.json()) as unknown;
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v != null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;

/** Ours: the bot wrote it and its first line is the marker, exactly (not one quoted in a reply). */
function isOurs(comment: unknown): boolean {
  const c = obj(comment);
  if (obj(c?.user)?.login !== BOT_LOGIN || typeof c?.body !== "string") return false;
  return c.body.split("\n", 1)[0].replace(/\r$/, "") === MARKER;
}

/** The id of our comment on the PR, or undefined. Pages through the list as @e2e-dev/github does. */
async function findComment(api: Api, issue: string): Promise<number | undefined> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const route = `${issue}/comments?per_page=${PER_PAGE}&page=${page}`;
    const comments = await api("GET", route);
    if (!Array.isArray(comments)) throw new Error(`GitHub answered GET ${route} with no list`);
    const id = obj(comments.find(isOurs))?.id;
    if (typeof id === "number") return id;
    if (comments.length < PER_PAGE) return undefined;
  }
  return undefined;
}

export type Outcome =
  | { action: "created" | "updated"; url: string }
  | { action: "skipped"; reason: string };

/** Creates or edits the PR's one story comment, unless a newer push moved the PR head. */
export async function upsertComment(
  root: string,
  ctx: CommentContext,
  token: string,
  fetchFn: Fetch = fetch
): Promise<Outcome> {
  const api = client(ctx, token, fetchFn);
  const repo = `/repos/${ctx.repository}`;
  // A newer push owns the comment: its own run writes it, and this older run must not
  // overwrite it (a re-run of an old run, or one that finished late).
  const head = obj(obj(await api("GET", `${repo}/pulls/${ctx.pullRequest}`))?.head)?.sha;
  if (head !== ctx.headSha)
    return { action: "skipped", reason: `the PR head moved to ${String(head)}, a newer run's` };
  const body = commentBody(root, ctx);
  const issue = `${repo}/issues/${ctx.pullRequest}`;
  const existing = await findComment(api, issue);
  const written =
    existing === undefined
      ? await api("POST", `${issue}/comments`, { body })
      : await api("PATCH", `${repo}/issues/comments/${existing}`, { body });
  const url = String(obj(written)?.html_url);
  return { action: existing === undefined ? "created" : "updated", url };
}

/** The context from the Actions env; a missing variable is a broken job, so it throws. */
function contextFromEnv(env: NodeJS.ProcessEnv, dryRun: boolean): CommentContext {
  const need = (name: string, fallback?: string) => {
    const value = env[name] ?? fallback;
    if (value == null || value === "") throw new Error(`${name} is not set`);
    return value;
  };
  // A dry run (a local check) needs none of them.
  const local = (fallback: string) => (dryRun ? fallback : undefined);
  const pullRequest = Number(need("PR_NUMBER", local("0")));
  if (!Number.isInteger(pullRequest)) throw new Error("PR_NUMBER is not a number");
  return {
    apiUrl: need("GITHUB_API_URL", "https://api.github.com"),
    serverUrl: need("GITHUB_SERVER_URL", "https://github.com"),
    repository: need("GITHUB_REPOSITORY", local("coder/xum")),
    pullRequest,
    headSha: need("HEAD_SHA", local("HEAD")),
    sourceSha: need("SOURCE_SHA", local("HEAD")),
    runId: need("GITHUB_RUN_ID", local("0")),
    runAttempt: need("GITHUB_RUN_ATTEMPT", local("1")),
    reportsArtifact: env.REPORTS_ARTIFACT || `stories-reports-${env.GITHUB_RUN_ATTEMPT ?? "1"}`,
    // Unset, or empty when the lane left no output: the titles then name no model.
    model: env.BUGBASH_MODEL === "" ? undefined : env.BUGBASH_MODEL,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  if (rest.length !== 1) {
    console.error("usage: bun tests/stories/prComment.ts <reports dir> [--dry-run]");
    process.exit(2);
  }
  const root = path.resolve(rest[0]);
  const ctx = contextFromEnv(process.env, dryRun);
  if (dryRun) {
    process.stdout.write(commentBody(root, ctx));
  } else {
    const token = process.env.GITHUB_TOKEN;
    if (token == null || token === "") throw new Error("GITHUB_TOKEN is not set");
    const outcome = await upsertComment(root, ctx, token);
    console.log(
      outcome.action === "skipped"
        ? `No comment: ${outcome.reason}.`
        : `Comment ${outcome.action}: ${outcome.url}`
    );
  }
}
