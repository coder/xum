/**
 * Backs the "Save open session tapes" and "Reveal session tapes folder" palette commands
 * (experiment `sessionTapes`). Returns only counts and the folder path: tapes hold the full
 * chat, so their content is never read here. The folder comes from backend config only.
 *
 * No experiment gate: saving only finalizes captures that already exist, and revealing never
 * starts recording.
 */
import { ensurePrivateDir } from "@/node/utils/fs";
import { stopSessionTapeCaptures } from "./sessionTapeRecorder";

/** Opens a folder in the OS file manager; rejects when it cannot. */
export type SessionTapesFolderRevealer = (dir: string) => Promise<void>;

export class SessionTapeFolderService {
  private readonly dir: string;
  private revealPath: SessionTapesFolderRevealer | null = null;

  constructor(options: { dir: string }) {
    this.dir = options.dir;
  }

  /** Desktop only; `xum server` has no revealer. */
  setRevealer(revealPath: SessionTapesFolderRevealer): void {
    this.revealPath = revealPath;
  }

  /** Finalizes every open capture now (trailer reason "stopped"). */
  async saveOpen(): Promise<{ written: number; dir: string }> {
    return { written: await stopSessionTapeCaptures(), dir: this.dir };
  }

  /**
   * Without a revealer the folder is left untouched and the caller shows the path. A revealer
   * failure rejects, so it never looks like the server-mode result.
   */
  async revealFolder(): Promise<{ dir: string; revealed: boolean }> {
    if (this.revealPath == null) return { dir: this.dir, revealed: false };
    // Same owner-only mode the recorder uses, so revealing never loosens it.
    await ensurePrivateDir(this.dir);
    await this.revealPath(this.dir);
    return { dir: this.dir, revealed: true };
  }
}
