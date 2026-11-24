import { describe, expect, test } from "bun:test";
import { allowedOnDisk } from "./agentLoop.inMemory.diskRule.testHarness";

const ROOT = "/cfg";
const LOGS = "/xum/logs";
const allowed = allowedOnDisk(ROOT, LOGS);
const row = (api: string, arg: string, extra: { fdPath?: string; arg2?: string } = {}) =>
  allowed({ api, arg, site: "src/x.ts:1", ...extra });

describe("the disk rule of the in-memory loop proof", () => {
  test("Config's paths under its root pass, its session dirs and worktrees do not", () => {
    expect(row("fsp.readFile", "/cfg/config.json")).toBe(true);
    expect(row("fsp.readFile", "/cfg/sessions/ws/chat.jsonl")).toBe(false);
    expect(row("fsp.stat", "/cfg/src/project/branch")).toBe(false);
    expect(row("fsp.readFile", "/elsewhere/config.json")).toBe(false);
  });

  test("a .. segment cannot leave the root", () => {
    expect(row("fsp.stat", "/cfg/x/../../outside")).toBe(false);
  });

  test("only Config's lstat of an ancestor of the root passes", () => {
    expect(row("fs.lstatSync", "/")).toBe(true);
    expect(row("fsp.stat", "/")).toBe(false);
  });

  test("the log sink's own files pass, other files in the logs dir do not", () => {
    expect(row("fs.mkdirSync", LOGS)).toBe(true);
    expect(row("fs.open", "/xum/logs/mux.log")).toBe(true);
    expect(row("fs.renameSync", "/xum/logs/mux.log", { arg2: "/xum/logs/mux.1.log" })).toBe(true);
    expect(row("fsp.writeFile", "/xum/logs/session.jsonl")).toBe(false);
  });

  test("a two-path call needs both paths allowed", () => {
    expect(row("fsp.copyFile", "/cfg/a.json", { arg2: "/tmp/outside" })).toBe(false);
  });

  test("stdout and stderr pass only for fs and Bun file writes", () => {
    expect(row("Bun.file", "fd/1")).toBe(true);
    expect(row("fs.write", "fd/2")).toBe(true);
    expect(row("net.connect", "fd/1")).toBe(false);
  });

  test("another fd passes only when the trap saw it open on an allowed path", () => {
    expect(row("fs.write", "fd/9", { fdPath: "/xum/logs/mux.log" })).toBe(true);
    expect(row("fs.write", "fd/9", { fdPath: "/etc/hostname" })).toBe(false);
    expect(row("fs.readSync", "fd/9")).toBe(false);
  });
});
