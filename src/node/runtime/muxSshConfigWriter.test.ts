import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MUX_CODER_HOST_SUFFIX,
  MUX_CODER_SSH_BLOCK_END,
  MUX_CODER_SSH_BLOCK_START,
} from "@/constants/coder";
import { ensureMuxCoderSSHConfigFile } from "./muxSshConfigWriter";

function renderExpectedMuxBlock(coderBinaryPath: string): string {
  const quotedPath = `"${coderBinaryPath.replaceAll('"', String.raw`\"`)}"`;

  return [
    MUX_CODER_SSH_BLOCK_START,
    `Host *.${MUX_CODER_HOST_SUFFIX}`,
    "  ConnectTimeout 0",
    "  LogLevel ERROR",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
    `  ProxyCommand ${quotedPath} "ssh" "--stdio" "--hostname-suffix" "${MUX_CODER_HOST_SUFFIX}" "%h"`,
    MUX_CODER_SSH_BLOCK_END,
  ].join("\n");
}

describe("ensureMuxCoderSSHConfigFile", () => {
  const coderBinaryPath = "/usr/local/bin/coder";
  let tempDirs: string[] = [];

  async function makeSSHConfigPath(): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-writer-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, ".ssh", "config");
  }

  async function writeSSHConfig(sshConfigPath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(sshConfigPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(sshConfigPath, content, "utf8");
  }

  async function readSSHConfig(sshConfigPath: string): Promise<string> {
    return fs.readFile(sshConfigPath, "utf8");
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it("creates block from an empty config", async () => {
    const sshConfigPath = await makeSSHConfigPath();

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toBe(`${renderExpectedMuxBlock(coderBinaryPath)}\n`);
  });

  it("preserves existing config file mode", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    await writeSSHConfig(sshConfigPath, "Host github.com\n");
    await fs.chmod(sshConfigPath, 0o644);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const mode = await fs.stat(sshConfigPath).then((stats) => stats.mode & 0o777);
    expect(mode).toBe(0o644);
  });

  it("defaults to 0o600 for a newly created config file", async () => {
    const sshConfigPath = await makeSSHConfigPath();

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const mode = await fs.stat(sshConfigPath).then((stats) => stats.mode & 0o777);
    expect(mode).toBe(0o600);
  });

  it("preserves symlinked SSH config paths by writing through to the symlink target", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-writer-link-"));
    tempDirs.push(tempDir);

    const sshDir = path.join(tempDir, ".ssh");
    const sshConfigPath = path.join(sshDir, "config");
    const dotfilesDir = path.join(tempDir, "dotfiles");
    const targetConfigPath = path.join(dotfilesDir, "ssh_config");

    await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(dotfilesDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(targetConfigPath, "Host github.com\n", "utf8");
    await fs.symlink(path.relative(sshDir, targetConfigPath), sshConfigPath);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const linkStats = await fs.lstat(sshConfigPath);
    expect(linkStats.isSymbolicLink()).toBe(true);

    const targetContent = await readSSHConfig(targetConfigPath);
    expect(targetContent).toContain("Host *.mux--coder");
    expect(targetContent).toContain('--hostname-suffix" "mux--coder" "%h"');

    const linkedContent = await readSSHConfig(sshConfigPath);
    expect(linkedContent).toBe(targetContent);
  });

  it("preserves dangling symlink by writing to the intended target path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-test-"));
    tempDirs.push(tempDir);

    const targetPath = path.join(tempDir, "dotfiles", "ssh_config");
    const symlinkPath = path.join(tempDir, "config");

    // Create directory for the target but NOT the target file itself (dangling symlink).
    await fs.mkdir(path.join(tempDir, "dotfiles"), { recursive: true });
    await fs.symlink(targetPath, symlinkPath);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath: symlinkPath });

    // Symlink must still exist and point to the target.
    const stat = await fs.lstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    const linkTarget = await fs.readlink(symlinkPath);
    expect(linkTarget).toBe(targetPath);

    // Content was written to the target file (which now exists).
    const content = await fs.readFile(targetPath, "utf8");
    expect(content).toContain(MUX_CODER_SSH_BLOCK_START);

    // Reading through the symlink yields the same content.
    const throughLink = await fs.readFile(symlinkPath, "utf8");
    expect(throughLink).toBe(content);
  });

  it("preserves dangling multi-hop symlink chain", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-test-"));
    tempDirs.push(tempDir);

    const targetPath = path.join(tempDir, "dotfiles", "ssh_config");
    const linkA = path.join(tempDir, "linkA");
    const configLink = path.join(tempDir, "config");

    // Create directory but NOT the target file (dangling).
    await fs.mkdir(path.join(tempDir, "dotfiles"), { recursive: true });
    await fs.symlink(targetPath, linkA);
    await fs.symlink(linkA, configLink);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath: configLink });

    // Both symlinks must survive.
    expect((await fs.lstat(configLink)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(linkA)).isSymbolicLink()).toBe(true);

    // Target was created with mux block.
    const content = await fs.readFile(targetPath, "utf8");
    expect(content).toContain(MUX_CODER_SSH_BLOCK_START);
  });

  it("preserves multi-hop symlink chain by writing to final target", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ssh-test-"));
    tempDirs.push(tempDir);

    const realFile = path.join(tempDir, "real_ssh_config");
    const linkA = path.join(tempDir, "linkA");
    const configLink = path.join(tempDir, "config");

    await fs.writeFile(realFile, "", { mode: 0o644 });
    await fs.symlink(realFile, linkA);
    await fs.symlink(linkA, configLink);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath: configLink });

    // Both symlinks must remain intact.
    const configStat = await fs.lstat(configLink);
    expect(configStat.isSymbolicLink()).toBe(true);
    const linkAStat = await fs.lstat(linkA);
    expect(linkAStat.isSymbolicLink()).toBe(true);

    // Content was written to the final real file.
    const content = await fs.readFile(realFile, "utf8");
    expect(content).toContain(MUX_CODER_SSH_BLOCK_START);

    // Reading through the chain yields the same content.
    const throughChain = await fs.readFile(configLink, "utf8");
    expect(throughChain).toBe(content);
  });

  it("appends block to existing non-mux config while preserving existing bytes", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const existingContent = ["Host github.com", "  User git", ""].join("\n");
    await writeSSHConfig(sshConfigPath, existingContent);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content.slice(0, existingContent.length)).toBe(existingContent);
    expect(content).toBe(`${existingContent}${renderExpectedMuxBlock(coderBinaryPath)}\n`);
  });

  it("uses mux--coder suffix without mutating existing *.coder host globs", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const existingContent = [
      "Host *.coder",
      "  User legacy-user",
      "  ProxyCommand /usr/local/bin/coder-legacy --stdio %h",
      "",
    ].join("\n");
    await writeSSHConfig(sshConfigPath, existingContent);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content.slice(0, existingContent.length)).toBe(existingContent);
    expect(content).toContain("Host *.mux--coder");
    expect(content).toContain('--hostname-suffix" "mux--coder" "%h"');
  });

  it("replaces an existing mux block and preserves surrounding content", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const originalBinaryPath = "/opt/coder-old";
    const existingContent = [
      "Host github.com",
      "  User git",
      renderExpectedMuxBlock(originalBinaryPath),
      "Host internal",
      "  User dev",
      "",
    ].join("\n");

    await writeSSHConfig(sshConfigPath, existingContent);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    const expected = [
      "Host github.com",
      "  User git",
      renderExpectedMuxBlock(coderBinaryPath),
      "Host internal",
      "  User dev",
      "",
    ].join("\n");

    expect(content).toBe(expected);
  });

  it("replaces mux block when it is at the very start of the file", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const originalBinaryPath = "/opt/coder-old";
    const userContent = ["Host github.com", "  User git", ""].join("\n");
    const existingContent = `${renderExpectedMuxBlock(originalBinaryPath)}\n${userContent}`;
    await writeSSHConfig(sshConfigPath, existingContent);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toBe(`${renderExpectedMuxBlock(coderBinaryPath)}\n${userContent}`);
  });

  it("replaces mux block when it is at the very end with no trailing newline", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const originalBinaryPath = "/opt/coder-old";
    const userContent = ["Host github.com", "  User git"].join("\n");
    const existingContent = `${userContent}\n${renderExpectedMuxBlock(originalBinaryPath)}`;
    await writeSSHConfig(sshConfigPath, existingContent);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toBe(`${userContent}\n${renderExpectedMuxBlock(coderBinaryPath)}`);
  });

  it("is idempotent when called repeatedly with the same binary path", async () => {
    const sshConfigPath = await makeSSHConfigPath();

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });
    const firstWrite = await readSSHConfig(sshConfigPath);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });
    const secondWrite = await readSSHConfig(sshConfigPath);

    expect(secondWrite).toBe(firstWrite);
  });

  it("updates ProxyCommand when binary path changes", async () => {
    const sshConfigPath = await makeSSHConfigPath();

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });
    await ensureMuxCoderSSHConfigFile({
      coderBinaryPath: "/Applications/Coder.app/Contents/MacOS/coder",
      sshConfigPath,
    });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toContain(
      'ProxyCommand "/Applications/Coder.app/Contents/MacOS/coder" "ssh" "--stdio" "--hostname-suffix" "mux--coder" "%h"'
    );
    expect(content).not.toContain(
      'ProxyCommand "/usr/local/bin/coder" "ssh" "--stdio" "--hostname-suffix" "mux--coder" "%h"'
    );
  });

  it("supports binary paths with spaces", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const spacedPath = "/usr/local/my dir/coder";

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath: spacedPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toContain('ProxyCommand "/usr/local/my dir/coder"');
  });

  it("escapes embedded double quotes in binary path", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const quotedPath = '/path/to/"coder"';

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath: quotedPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toContain('ProxyCommand "/path/to/\\"coder\\""');
  });

  it("quotes paths containing shell metacharacters", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const trickyPath = "/usr/$HOME/`whoami`/$(id)/coder";

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath: trickyPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    // Double-quoting preserves the literal path in the SSH config file.
    // On POSIX, $ and backticks may expand at exec time — this is an accepted
    // tradeoff shared by coder/coder and coder/vscode-coder. Realistic binary
    // paths from PATH resolution never contain these characters.
    expect(content).toContain('ProxyCommand "/usr/$HOME/`whoami`/$(id)/coder"');
  });

  it("escapes embedded single quotes in binary path", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const pathWithQuote = "/usr/local/it's/coder";

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath: pathWithQuote, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toContain('ProxyCommand "/usr/local/it\'s/coder"');
  });

  it("preserves backslashes in Windows-style paths", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const windowsPath = "C:\\Program Files\\Coder\\bin\\coder.exe";

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath: windowsPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toContain('ProxyCommand "C:\\Program Files\\Coder\\bin\\coder.exe"');
  });

  it("rejects binary paths containing newlines", async () => {
    const sshConfigPath = await makeSSHConfigPath();

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(
      ensureMuxCoderSSHConfigFile({ coderBinaryPath: "/path\n/coder", sshConfigPath })
    ).rejects.toThrow(/newline/i);
  });

  it("adds a separating newline before appending when existing content has no trailing newline", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const existingContent = ["Host github.com", "  User git"].join("\n");
    await writeSSHConfig(sshConfigPath, existingContent);

    await ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath });

    const content = await readSSHConfig(sshConfigPath);
    expect(content).toBe(`${existingContent}\n${renderExpectedMuxBlock(coderBinaryPath)}\n`);
  });

  it("throws on duplicate markers", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const corruptedConfig = [
      MUX_CODER_SSH_BLOCK_START,
      MUX_CODER_SSH_BLOCK_START,
      "Host *.mux--coder",
      MUX_CODER_SSH_BLOCK_END,
      "",
    ].join("\n");

    await writeSSHConfig(sshConfigPath, corruptedConfig);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath })).rejects.toThrow(
      /duplicate/i
    );
  });

  it("throws on duplicate END markers", async () => {
    const sshConfigPath = await makeSSHConfigPath();
    const corruptedConfig = [
      MUX_CODER_SSH_BLOCK_START,
      "Host *.mux--coder",
      MUX_CODER_SSH_BLOCK_END,
      MUX_CODER_SSH_BLOCK_END,
      "",
    ].join("\n");

    await writeSSHConfig(sshConfigPath, corruptedConfig);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath })).rejects.toThrow(
      /duplicate/i
    );
  });

  it.each([
    {
      caseName: "only START marker is present",
      config: [MUX_CODER_SSH_BLOCK_START, "Host *.mux--coder", ""].join("\n"),
    },
    {
      caseName: "only END marker is present",
      config: ["Host *.mux--coder", MUX_CODER_SSH_BLOCK_END, ""].join("\n"),
    },
  ])("throws on mismatched markers when $caseName", async ({ config }) => {
    const sshConfigPath = await makeSSHConfigPath();
    await writeSSHConfig(sshConfigPath, config);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath })).rejects.toThrow(
      /mismatched/i
    );
  });

  it("uses collision-proof temp paths when concurrent calls share a timestamp", async () => {
    const sshConfigPath = await makeSSHConfigPath();

    const nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const uuidSpy = spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("aaaa-1111" as ReturnType<typeof crypto.randomUUID>)
      .mockReturnValueOnce("bbbb-2222" as ReturnType<typeof crypto.randomUUID>);
    const writeFileSpy = spyOn(fs, "writeFile");

    try {
      await Promise.all([
        ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath }),
        ensureMuxCoderSSHConfigFile({ coderBinaryPath, sshConfigPath }),
      ]);

      const tempPaths = writeFileSpy.mock.calls
        .map(([filePath]) => filePath as string)
        .filter((p) => p.includes(".mux-tmp."));

      // Both calls must have used distinct temp paths despite identical PID + timestamp.
      expect(tempPaths.length).toBeGreaterThanOrEqual(2);
      expect(new Set(tempPaths).size).toBe(tempPaths.length);
    } finally {
      nowSpy.mockRestore();
      uuidSpy.mockRestore();
      writeFileSpy.mockRestore();
    }
  });
});
