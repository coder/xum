/**
 * Which pop-out terminal windows are open, per workspace, and which session each one shows.
 * Kept free of Electron imports so the close rules are unit-testable under bun.
 */
export class TerminalWindowRegistry<W> {
  private readonly byWorkspace = new Map<string, Map<W, string | undefined>>();

  add(workspaceId: string, window: W, sessionId: string | undefined): void {
    let windows = this.byWorkspace.get(workspaceId);
    if (!windows) {
      windows = new Map();
      this.byWorkspace.set(workspaceId, windows);
    }
    windows.set(window, sessionId);
  }

  remove(workspaceId: string, window: W): void {
    const windows = this.byWorkspace.get(workspaceId);
    if (!windows) return;
    windows.delete(window);
    if (windows.size === 0) this.byWorkspace.delete(workspaceId);
  }

  /**
   * The windows to close for a workspace: only those showing `sessionId` when given (one pop-out's
   * shell exited, #5739), otherwise all of them.
   */
  select(workspaceId: string, sessionId?: string): W[] {
    const windows = this.byWorkspace.get(workspaceId);
    if (!windows) return [];
    return [...windows]
      .filter(([, shown]) => sessionId === undefined || shown === sessionId)
      .map(([window]) => window);
  }
}
