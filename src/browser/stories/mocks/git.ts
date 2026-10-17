// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS MOCKS
// ═══════════════════════════════════════════════════════════════════════════════
export interface GitStatusFixture {
  ahead?: number;
  behind?: number;
  dirty?: number;
  headCommit?: string;
  originCommit?: string;
  /** Checked-out branch; the branch selector resolves to it (and offers copy) once reported. */
  headBranch?: string;

  // Optional overrides for line-delta display (additions/deletions)
  outgoingAdditions?: number;
  outgoingDeletions?: number;
  incomingAdditions?: number;
  incomingDeletions?: number;
}

export function createGitStatusOutput(fixture: GitStatusFixture): string {
  const { ahead = 0, behind = 0, dirty = 0 } = fixture;

  // Provide deterministic defaults so existing stories still show something
  // when the indicator switches to line-delta mode.
  const outgoingAdditions = fixture.outgoingAdditions ?? ahead * 12 + dirty * 2;
  const outgoingDeletions = fixture.outgoingDeletions ?? ahead * 4 + Math.max(0, dirty - 1);
  const incomingAdditions = fixture.incomingAdditions ?? behind * 10;
  const incomingDeletions = fixture.incomingDeletions ?? behind * 3;

  const lines = fixture.headBranch ? ["---HEAD_BRANCH---", fixture.headBranch] : [];
  lines.push("---PRIMARY---", "main", "---AHEAD_BEHIND---", `${ahead} ${behind}`);
  lines.push("---DIRTY---");
  lines.push(String(dirty));
  lines.push("---LINE_DELTA---");
  lines.push(`${outgoingAdditions} ${outgoingDeletions} ${incomingAdditions} ${incomingDeletions}`);

  return lines.join("\n");
}
