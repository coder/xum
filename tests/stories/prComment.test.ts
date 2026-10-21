import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commentBody, MARKER, upsertComment, type CommentContext } from "./prComment";
import { CLIPPED_NOTE, NO_OUTPUT_NOTE } from "./summary";

// Real reports of `make test-stories` under Haiku, trimmed: a red web job (a planted exact
// failure in smoke.e2e.ts plus one pass) and a green Electron job.
const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "testdata", `${name}.report.json`), "utf8");
const RED = fixture("red");
const GREEN = fixture("green");

const WEB = "tests/stories/.e2e/stories-20261021T185031Z-1";
const ELECTRON = "tests/stories/.e2e/stories-electron-20261021T185359Z-2";
const REPROS = "tests/bugbash/.e2e/agent-repros-20261021T185339Z-3";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xum-story-comment-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const job = (folder: string, report: string) => {
  write(`${folder}/report.json`, report);
  write(`${folder}.spend.json`, JSON.stringify({ spentUsd: 0.12, capUsd: 1, refused: 0 }));
};

const ctx: CommentContext = {
  apiUrl: "https://api.github.test",
  serverUrl: "https://github.test",
  repository: "coder/xum",
  pullRequest: 7,
  headSha: "a".repeat(40),
  runId: "99",
  runAttempt: "2",
  model: "anthropic:claude-haiku-5-5",
};

interface Comment {
  id: number;
  user: { login: string };
  body: string;
}
/** A GitHub REST API for one PR, in memory: what fetch reaches, and every call it got. */
function fakeGitHub(comments: Comment[], head = ctx.headSha) {
  const calls: { method: string; url: string; body?: { body: string } }[] = [];
  const fetchFn = (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    // prComment.ts sends each body as a JSON string.
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as { body: string }) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const json = (value: unknown) => Promise.resolve(Response.json(value));
    if (u.pathname === "/repos/coder/xum/pulls/7") return json({ head: { sha: head } });
    if (u.pathname === "/repos/coder/xum/issues/7/comments" && method === "GET") {
      const page = Number(u.searchParams.get("page"));
      const per = Number(u.searchParams.get("per_page"));
      return json(comments.slice((page - 1) * per, page * per));
    }
    if (method === "POST") return json({ html_url: "https://github.test/new" });
    if (method === "PATCH") return json({ html_url: "https://github.test/edited" });
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  const writes = () => calls.filter((c) => c.method === "POST" || c.method === "PATCH");
  return { fetchFn, calls, writes };
}
const bot = (id: number, body: string) => ({ id, user: { login: "github-actions[bot]" }, body });

test("a user's comment that starts with the marker is never edited: a new one is posted", async () => {
  job(WEB, RED);
  const gh = fakeGitHub([{ id: 1, user: { login: "someone" }, body: `${MARKER}\nmine` }]);
  expect(await upsertComment(root, ctx, "token", gh.fetchFn)).toMatchObject({ action: "created" });
  expect(gh.writes().map((c) => [c.method, new URL(c.url).pathname])).toEqual([
    ["POST", "/repos/coder/xum/issues/7/comments"],
  ]);
  expect(gh.writes()[0].body?.body.split("\n")[0]).toBe(MARKER);
});

test("the bot's marked comment is edited, on a later page too; one with the marker lower is not ours", async () => {
  job(WEB, RED);
  const others = Array.from({ length: 150 }, (_, i) => bot(100 + i, `chatter ${i}`));
  others[20] = bot(5, `quoted:\n${MARKER}`);
  others[120] = bot(6, `${MARKER}\nold page`);
  const gh = fakeGitHub(others);
  expect(await upsertComment(root, ctx, "token", gh.fetchFn)).toMatchObject({ action: "updated" });
  expect(gh.writes().map((c) => [c.method, new URL(c.url).pathname])).toEqual([
    ["PATCH", "/repos/coder/xum/issues/comments/6"],
  ]);
});

test("a PR head that moved on means no write: the newer push owns the comment", async () => {
  job(WEB, RED);
  const gh = fakeGitHub([bot(6, `${MARKER}\nold`)], "b".repeat(40));
  expect(await upsertComment(root, ctx, "token", gh.fetchFn)).toMatchObject({ action: "skipped" });
  expect(gh.writes()).toEqual([]);
});

test("no job output gives the note, so the comment still says what happened", () => {
  expect(commentBody(root, ctx)).toBe(`${MARKER}\n${NO_OUTPUT_NOTE}\n`);
});

test("three full pages fit in one comment: passing jobs fold first, then the rest is clipped", () => {
  // Each report grows until e2e's page of it is large: failure blocks, and a long table of
  // tests, one file each. Past e2e's own cap (60,000 characters) e2e drops the table itself.
  const grow = (text: string, times: number) => {
    const report = JSON.parse(text) as {
      run: { results: { id: string; status: string; titlePath: string[] }[] };
    };
    const first = report.run.results.find((r) => r.status !== "passed") ?? report.run.results[0];
    report.run.results = Array.from({ length: times }, (_, i) => ({
      ...first,
      id: `${first.id}-${i}`,
      testId: `test-${i}`,
      file: `file-${i}.e2e.ts`,
      titlePath: [`${"a long title ".repeat(10)}${i}`],
    }));
    return JSON.stringify(report);
  };
  const count = 150; // tests a job: a page of 33-45k characters, below e2e's cap
  job(WEB, grow(RED, count));
  job(ELECTRON, grow(GREEN, count));
  job(REPROS, grow(RED, count));
  fs.mkdirSync(path.join(root, "first-try"));

  const body = commentBody(root, ctx);
  expect(body.length).toBeLessThan(65_536);
  const headlines = body.split("\n").filter((line) => line.startsWith("### "));
  expect(headlines).toEqual([
    `### 🔴 e2e stories (Haiku): ${count} failed`,
    `### 🟢 e2e Electron stories (Haiku): ${count} passed`,
    `### 🔴 e2e agent repros (Haiku): ${count} failed`,
  ]);
  // The green job keeps only its head; both red ones keep their failures, clipped.
  const sections = body.split("\n### ");
  expect(sections[2]).not.toContain("<details>");
  for (const red of [sections[1], sections[3]]) {
    expect(red).toContain("ASSERTION_FAILED");
    expect(red).toContain(CLIPPED_NOTE);
  }
  expect(body.match(/^Spend: /gm)?.length).toBe(3);
  // Every fold the clip cut open is closed again.
  expect(body.match(/<details>/g)?.length).toBe(body.match(/<\/details>/g)?.length);
  expect(body).toContain("`stories-reports-2`, folder `first-try`");
});

test("a test title with a mention and an issue number renders as code, not a link", () => {
  job(WEB, RED.replaceAll("the agent opens the playground workspace", "ping @someone #1 now"));
  const body = commentBody(root, ctx);
  expect(body).toContain("ping `@someone` `#1` now");
  expect(body).not.toMatch(/(^|[^`])@someone/m);
  expect(body).not.toMatch(/(^|[^`])#1\b/m);
});

test("a source link encodes each path segment, under the job's e2e project", () => {
  job(WEB, RED.replaceAll('"smoke.e2e.ts"', '"my dir/a#b?.e2e.ts"'));
  job(REPROS, RED.replaceAll('"smoke.e2e.ts"', '"repros/100%.e2e.ts"'));
  const body = commentBody(root, ctx);
  const blob = `https://github.test/coder/xum/blob/${ctx.headSha}`;
  expect(body).toContain(`(${blob}/tests/stories/my%20dir/a%23b%3F.e2e.ts#L19)`);
  expect(body).toContain(`(${blob}/tests/bugbash/repros/100%25.e2e.ts#L19)`);
});
