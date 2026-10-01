import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
import {
  getSelfIdentity,
  judgeHolder,
  linuxBirth,
  setSelfIdentityForTests,
  type HolderEvidence,
  type ProcessIdentity,
} from "./processLiveness";

// Bridge from the Lean model in formal/process-liveness to the real judgeHolder.
//
// `tsModel` transcribes ProcessLiveness/TsJudge.lean (tsJudge) and `specModel` transcribes
// ProcessLiveness/Spec.lean (specJudge), both over the same abstract evidence. The exhaustive
// case set drives the REAL judgeHolder (kill(pid, 0) is stubbed per case; start times are real
// /proc reads of real pids) and checks:
// 1. the Lean transcription of the TS branches matches the real function on every case;
// 2. the real function disagrees with the proven spec only in the classified findings.
// The `test.failing` cases at the end are minimal repros of those findings, each next to a
// passing control. Remove `.failing` (and the class from KNOWN_DISAGREEMENTS) once fixed.
//
// Linux only: start times come from /proc, which the model's Linux cases need.

type KillOutcome = "alive" | "eperm" | "esrch" | "other";
type Birth = { ticks: string } | { other: string } | null;
interface AbstractRecord {
  birth: Birth;
  bootId: string | null;
  pidNs: string | null;
  machineId: string | null;
  platform: string | null;
}
interface Evidence {
  pid: number;
  selfPid: number;
  ownTokenLive: boolean;
  /** null: legacy record (no identity). */
  record: AbstractRecord | null;
  legacyBirth: Birth;
  self: Omit<AbstractRecord, "birth">;
  kill: KillOutcome;
  /** linuxBirth(pid): the pid's current start time, or null when unreadable. */
  current: string | null;
}

const birthEq = (current: string, birth: NonNullable<Birth>) =>
  "ticks" in birth && birth.ticks === current;
const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;

/** ProcessLiveness/TsJudge.lean tsJudge (true = dead). */
function tsModel(e: Evidence): boolean {
  const rest = (r: AbstractRecord, linuxDomain: boolean) => {
    if (e.pid === e.selfPid) return !e.ownTokenLive;
    if (e.kill === "esrch") return true;
    if (!linuxDomain || r.birth === null || e.current === null) return false;
    return !birthEq(e.current, r.birth);
  };
  const r = e.record;
  if (r === null) {
    if (e.kill === "esrch") return true;
    const b = e.legacyBirth;
    return b !== null && "ticks" in b && e.current !== null && e.current !== b.ticks;
  }
  if (differs(r.platform, e.self.platform)) return true;
  if (e.self.bootId !== null && e.self.pidNs !== null) {
    if (r.bootId === null || r.pidNs === null) return false;
    if (r.bootId !== e.self.bootId || r.pidNs !== e.self.pidNs) return true;
    return rest(r, true);
  }
  if (r.bootId !== null || r.pidNs !== null) return false;
  return rest(r, false);
}

/** ProcessLiveness/Spec.lean specJudge (true = dead). */
function specModel(e: Evidence): boolean {
  const p = e.self.platform;
  const r = e.record;
  if (p === null) return false;
  if (p === "linux") {
    if (r === null) return false;
    if (differs(r.platform, "linux")) return true;
    const { bootId: sb, pidNs: sn } = e.self;
    if (sb === null || sn === null || r.bootId === null || r.pidNs === null) return false;
    if (r.bootId !== sb || r.pidNs !== sn) return true;
    if (e.pid === e.selfPid) return !e.ownTokenLive;
    if (e.kill === "esrch") return true;
    if (r.birth === null || e.current === null) return false;
    return !birthEq(e.current, r.birth);
  }
  if (r !== null) {
    if (differs(r.platform, p)) return true;
    if (e.pid === e.selfPid) return !e.ownTokenLive;
    return e.kill === "esrch";
  }
  if (e.pid === e.selfPid) return false;
  return e.kill === "esrch";
}

/** The confirmed findings: which real-vs-spec disagreements each one explains. */
// A (fixed): a machine-id mismatch was judged a retired domain even when boot id and PID
// namespace proved the same domain. judgeHolder no longer reads the machine id, so it has no
// class here and any regression shows up as an unexplained disagreement.
const KNOWN_DISAGREEMENTS: Record<string, (e: Evidence) => boolean> = {
  // B1, B2, B3 are deferred (#4480); the classes are disjoint.
  // B1: legacy records skip the domain checks on Linux (TS dead on ESRCH or a start-time
  // mismatch, spec refuses: missing evidence).
  B1: (e) => e.record === null && e.self.platform === "linux",
  // B2: a Linux observer that cannot read its own boot id or namespace skips the domain checks
  // (TS dead on ESRCH, spec refuses).
  B2: (e) =>
    e.record !== null &&
    e.self.platform === "linux" &&
    (e.self.bootId === null || e.self.pidNs === null),
  // B3: a macOS/Windows observer refuses a record that names a Linux boot id or namespace,
  // while the same record without them is reclaimed (TS refuses, spec dead on ESRCH).
  B3: (e) =>
    e.record !== null &&
    e.self.platform !== "linux" &&
    (e.record.bootId !== null || e.record.pidNs !== null),
};

// ── Driving the real function ──────────────────────────────────────────────────────────────

function killStub(outcome: KillOutcome) {
  return spyOn(process, "kill").mockImplementation(() => {
    if (outcome === "alive") return true;
    const error = new Error(outcome) as NodeJS.ErrnoException;
    error.code = outcome === "other" ? "EINVAL" : outcome.toUpperCase();
    throw error;
  });
}

function realJudge(e: Evidence): { dead: boolean; why?: string } {
  const identity = (r: AbstractRecord): ProcessIdentity => ({
    birth: r.birth === null ? null : "ticks" in r.birth ? r.birth.ticks : r.birth.other,
    bootId: r.bootId,
    pidNs: r.pidNs,
    machineId: r.machineId,
    platform: r.platform,
    hostname: "recorded-host",
  });
  const legacy = e.legacyBirth;
  const holder: HolderEvidence =
    e.record === null
      ? {
          pid: e.pid,
          legacyBirth: legacy === null ? null : "ticks" in legacy ? legacy.ticks : legacy.other,
        }
      : { pid: e.pid, identity: identity(e.record) };
  setSelfIdentityForTests({ ...e.self, birth: null, hostname: "observer-host" });
  const stub = killStub(e.kill);
  try {
    const verdict = judgeHolder(holder, e.ownTokenLive);
    return verdict.dead ? { dead: true } : { dead: false, why: verdict.why };
  } finally {
    stub.mockRestore();
  }
}

/** A pid with no /proc entry: kill is stubbed, so only its unreadable start time matters. */
function unusedPid(): number {
  for (let pid = 4_194_000; pid > 1000; pid--) if (!existsSync(`/proc/${pid}`)) return pid;
  throw new Error("no unused pid");
}

function* cases(): Generator<Evidence> {
  const otherPid = process.ppid;
  const pids = [
    { pid: otherPid, current: linuxBirth(otherPid) },
    { pid: process.pid, current: linuxBirth(process.pid) },
    { pid: unusedPid(), current: null },
  ];
  const someTicks = linuxBirth(otherPid);
  if (someTicks === null) throw new Error("expected a readable /proc start time");
  const selves: Array<Evidence["self"]> = [
    { platform: "linux", bootId: "boot", pidNs: "ns", machineId: "machine" },
    { platform: "linux", bootId: "boot", pidNs: null, machineId: "machine" },
    { platform: "darwin", bootId: null, pidNs: null, machineId: null },
  ];
  const kills: KillOutcome[] = ["alive", "eperm", "esrch", "other"];
  for (const self of selves)
    for (const { pid, current } of pids) {
      const births: Birth[] = [
        null,
        { ticks: current ?? someTicks },
        { ticks: "linux-ticks:1" },
        { other: "ps-lstart:Mon Jan  1 00:00:00 2024" },
      ];
      const records: Array<AbstractRecord | null> = [null];
      for (const platform of [null, "linux", "darwin"])
        for (const bootId of [null, "boot", "boot-2"])
          for (const pidNs of [null, "ns", "ns-2"])
            for (const machineId of [null, "machine", "machine-2"])
              for (const birth of births)
                records.push({ birth, bootId, pidNs, machineId, platform });
      for (const record of records)
        for (const legacyBirth of record === null ? births : [null])
          for (const kill of kills)
            for (const ownTokenLive of [false, true])
              yield {
                pid,
                selfPid: process.pid,
                ownTokenLive,
                record,
                legacyBirth,
                self,
                kill,
                current,
              };
    }
}

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("judgeHolder against the Lean model", () => {
  afterEach(() => setSelfIdentityForTests(undefined));

  test("the Lean transcription of the TS branches matches judgeHolder on every case", () => {
    const mismatches: string[] = [];
    const reasons = new Set<string>();
    let total = 0;
    for (const e of cases()) {
      total++;
      const real = realJudge(e);
      reasons.add(real.why ?? "dead");
      if (real.dead !== tsModel(e) && mismatches.length < 5) mismatches.push(JSON.stringify(e));
    }
    expect(mismatches).toEqual([]);
    expect(total).toBeGreaterThan(20_000);
    // Every refusal branch of judgeHolder (8 distinct reasons) and the dead verdict were reached.
    expect(reasons.size).toBe(9);
  });

  test("judgeHolder disagrees with the proven spec only in the classified findings", () => {
    const unexplained: string[] = [];
    const seen = new Map<string, number>();
    for (const e of cases()) {
      // A simulated macOS observer still reads real Linux start times here; a real one cannot
      // (linuxBirth is null off Linux), so its legacy start-time cases are not meaningful.
      if (e.self.platform !== "linux" && e.record === null && e.legacyBirth !== null) continue;
      // kill(own pid, 0) cannot fail with ESRCH: the observer exists.
      if (e.pid === e.selfPid && e.kill === "esrch") continue;
      const real = realJudge(e).dead;
      if (real === specModel(e)) continue;
      const finding = Object.keys(KNOWN_DISAGREEMENTS).find((id) => KNOWN_DISAGREEMENTS[id](e));
      if (finding === undefined) {
        if (unexplained.length < 5) unexplained.push(JSON.stringify(e));
        continue;
      }
      seen.set(finding, (seen.get(finding) ?? 0) + 1);
    }
    expect(unexplained).toEqual([]);
    // Each finding still shows up; when one is fixed, drop it from KNOWN_DISAGREEMENTS.
    for (const id of Object.keys(KNOWN_DISAGREEMENTS))
      expect(seen.get(id) ?? 0, id).toBeGreaterThan(0);
  });
});

// ── Confirmed findings ─────────────────────────────────────────────────────────────────────

const linuxSelf: ProcessIdentity = {
  birth: null,
  bootId: "boot",
  pidNs: "ns",
  machineId: "machine",
  platform: "linux",
  hostname: null,
};

/** judgeHolder with kill(pid, 0) stubbed and this process seen as `self`. */
function judgeAs(
  self: ProcessIdentity,
  holder: HolderEvidence,
  kill: KillOutcome
): ReturnType<typeof judgeHolder> {
  setSelfIdentityForTests(self);
  const stub = killStub(kill);
  try {
    return judgeHolder(holder, false);
  } finally {
    stub.mockRestore();
  }
}

/** A live, unrelated process; stop it with the returned function. */
function liveProcess(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("failed to spawn a live process");
  return { pid: child.pid, stop: () => child.kill("SIGKILL") };
}

/** A pid that exited (ESRCH). */
function deadPid(): number {
  for (;;) {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
}

/** True when acquireCrossProcessLock takes `record`'s lock within a short timeout. */
async function crossProcessLockTakes(record: Record<string, unknown>): Promise<boolean> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "liveness-formal-"));
  const lockPath = path.join(dir, "test.lock");
  try {
    await fsPromises.writeFile(lockPath, JSON.stringify({ acquiredAt: Date.now(), ...record }));
    try {
      const release = await acquireCrossProcessLock({
        lockPath,
        acquireTimeoutMs: 400,
        staleMs: 60_000,
        timeoutMessage: "lock busy",
      });
      await release();
      return true;
    } catch {
      return false;
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

describeLinux("process liveness findings", () => {
  afterEach(() => setSelfIdentityForTests(undefined));

  // A (fixed): same boot id and PID namespace (the same PID domain), a running pid with the
  // recorded start time, but another machine id (a `--pid=host` container with its own
  // /etc/machine-id, or a machine id rewritten while the holder runs). judgeHolder used to judge
  // the machine-id mismatch a retired domain and reclaim the live holder.
  test("A control: a same-domain live holder with our machine id is refused", async () => {
    const holder = liveProcess();
    try {
      const self = getSelfIdentity();
      const record = { v: 2, ...self, pid: holder.pid, token: "a", birth: linuxBirth(holder.pid) };
      expect(await crossProcessLockTakes(record)).toBe(false);
    } finally {
      holder.stop();
    }
  });
  test("A: a same-domain live holder with another machine id is refused", async () => {
    const holder = liveProcess();
    try {
      const self = getSelfIdentity();
      const record = {
        v: 2,
        ...self,
        machineId: `${self.machineId ?? "none"}-other`,
        pid: holder.pid,
        token: "a",
        birth: linuxBirth(holder.pid),
      };
      setSelfIdentityForTests({ ...self, machineId: self.machineId ?? "machine" });
      expect(await crossProcessLockTakes(record)).toBe(false);
    } finally {
      holder.stop();
    }
  });

  // B1: a record without domain evidence is refused as an identity record, but reclaimed on
  // ESRCH as a legacy one, including any crossProcessLock record whose `v` is not 2 (a newer
  // build's record, #4480): crossProcessLock.ts parseHolder drops its identity.
  test("B1 control: a v2 record without boot id or namespace is refused", async () => {
    setSelfIdentityForTests(linuxSelf);
    expect(await crossProcessLockTakes({ v: 2, pid: deadPid(), token: "b1" })).toBe(false);
  });
  test.failing("B1: the same record with another version is refused too", async () => {
    setSelfIdentityForTests(linuxSelf);
    expect(await crossProcessLockTakes({ v: 3, pid: deadPid(), token: "b1" })).toBe(false);
  });
  test.failing("B1: a legacy record is refused on Linux (missing domain evidence)", () => {
    expect(judgeAs(linuxSelf, { pid: 4242 }, "esrch").dead).toBe(false);
  });

  // B2: an observer that cannot read its own PID namespace (or boot id) treats itself as
  // non-Linux and reclaims on ESRCH without any domain evidence (processLiveness.ts linuxDomain).
  test("B2 control: an observer with its full domain refuses a record without one", () => {
    const record = { ...linuxSelf, bootId: null, pidNs: null };
    expect(judgeAs(linuxSelf, { pid: 4242, identity: record }, "esrch").dead).toBe(false);
  });
  test.failing("B2: an observer without its own namespace refuses it too", () => {
    const record = { ...linuxSelf, bootId: null, pidNs: null };
    const self = { ...linuxSelf, pidNs: null };
    expect(judgeAs(self, { pid: 4242, identity: record }, "esrch").dead).toBe(false);
  });

  // B3: on macOS/Windows a record naming a Linux boot id is refused forever, while the same
  // record without it is reclaimed on ESRCH (less evidence reclaims; the full record wedges).
  // Kept as is: the full record only refuses more, the safe direction.
  const darwinSelf: ProcessIdentity = {
    birth: null,
    bootId: null,
    pidNs: null,
    machineId: null,
    platform: "darwin",
    hostname: null,
  };
  test("B3 control: a macOS observer reclaims a gone holder without domain fields", () => {
    expect(judgeAs(darwinSelf, { pid: 4242, identity: darwinSelf }, "esrch").dead).toBe(true);
  });
  test.failing("B3: a macOS observer reclaims the same gone holder when it names a boot id", () => {
    const record = { ...darwinSelf, platform: null, bootId: "boot" };
    expect(judgeAs(darwinSelf, { pid: 4242, identity: record }, "esrch").dead).toBe(true);
  });
});
