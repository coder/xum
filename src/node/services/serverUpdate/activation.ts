import { lstatSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { InstallLayout } from "./installLayout";

export function activateUpdate(layout: InstallLayout, stagedBin: string): void {
  if (
    !lstatSync(layout.launcher).isSymbolicLink() ||
    realpathSync(layout.launcher) !== layout.entry
  ) {
    throw new Error("Server launcher changed since startup");
  }
  realpathSync(stagedBin);
  const temporary = `${layout.launcher}.${randomUUID()}.tmp`;
  symlinkSync(stagedBin, temporary);
  try {
    renameSync(temporary, layout.launcher);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}
