import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { resolveBackupContents } from "@/common/config/schemas/settingsBackup";
import { MAX_BACKUP_PLUGIN_ENTRIES, type SettingsBackupInput } from "@/common/orpc/schemas/backup";
import { acquirePluginMutationLock } from "@/node/services/agentPlugins/journals";
import { createBackupGitRepo, createBackupPayloadStore } from "./adapters";
import { BackupService } from "./backupService";
import {
  collectPluginBackup,
  PLUGIN_BACKUP_DIR,
  PLUGIN_BACKUP_MANIFEST_PATH,
  readPluginRestore,
} from "./agentPluginBackup";
import { captureRejection, commitAll, runGit, writeFixtureFile } from "./testHelpers";

const DEFAULT_CONTENTS = resolveBackupContents({});
const PLUGINS_OFF = resolveBackupContents({ includePlugins: false });

function shaOf(seed: string): string {
  return seed.charCodeAt(0).toString(16).padStart(2, "0").repeat(20);
}

/** A registry row as the installer writes it, trust fields included. */
function registryRow(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    scope: "global",
    source: {
      type: "git",
      url: `https://github.com/example/${name}.git`,
      ref: "main",
      refType: "branch",
    },
    lockedSha: shaOf(name),
    installedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    importedComponents: { skills: ["review"], mcpServers: ["docs"] },
    componentConsent: {
      skills: { review: "fingerprint" },
      mcpServers: { docs: "fingerprint" },
      workflows: {},
      agents: {},
      slashCommands: {},
    },
    autoUpdate: true,
    ...overrides,
  };
}

async function exists(target: string): Promise<boolean> {
  return await fs.access(target).then(
    () => true,
    () => false
  );
}

async function writeRegistry(root: string, rows: unknown[]): Promise<void> {
  await fs.writeFile(path.join(root, "plugins.json"), JSON.stringify({ plugins: rows }), "utf-8");
}

async function writeGeneratedPlugin(root: string, name: string, generatedFrom: unknown) {
  await writeFixtureFile(
    root,
    `plugins/${name}/plugin.json`,
    JSON.stringify({ name, extensions: { mux: { generatedFrom } } })
  );
}

describe("backup of the managed plugin list", () => {
  let tempDir: string;
  let muxRoot: string;
  let originPath: string;
  let cacheRoot: string;
  let settings: SettingsBackupInput;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-plugin-backup-"));
    muxRoot = path.join(tempDir, "mux-root");
    originPath = path.join(tempDir, "origin.git");
    cacheRoot = path.join(tempDir, "cache");
    await fs.mkdir(muxRoot, { recursive: true });
    await runGit(["init", "--bare", "--initial-branch=main", originPath]);
    settings = { repoUrl: originPath, branch: "main", path: "xum" };
    config = new Config(muxRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function prepare() {
    const gitRepo = createBackupGitRepo({ cacheRoot });
    const payload = createBackupPayloadStore({ config });
    const repository = await gitRepo.prepare(settings);
    const managed = path.join(repository.rootDir, settings.path);
    const request = { repositoryRoot: repository.rootDir, managedPath: settings.path };
    return { gitRepo, payload, repository, managed, request };
  }

  /** The lock a plugin install, update or uninstall holds; calling what it returns finishes it. */
  const startMutation = () => acquirePluginMutationLock(muxRoot, { timeoutMs: 0 });
  /** Long enough that a read which ignored the lock would be done. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  async function readSidecar(managed: string): Promise<unknown> {
    return JSON.parse(
      await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8")
    ) as unknown;
  }

  describe("push", () => {
    it("writes the source and the pin of every managed plugin, and no local trust state", async () => {
      await writeRegistry(muxRoot, [
        registryRow("zeta", {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v2.0.0",
            refType: "tag",
            subpath: "packages/zeta",
          },
        }),
        registryRow("alpha"),
      ]);
      const { payload, managed, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      expect(exported.secretFiles).toEqual([]);
      const sidecar = (await readSidecar(managed)) as { schemaVersion: number; plugins: unknown[] };
      expect(sidecar.schemaVersion).toBe(1);
      expect(sidecar.plugins).toEqual([
        {
          name: "alpha",
          source: {
            type: "git",
            url: "https://github.com/example/alpha.git",
            ref: "main",
            refType: "branch",
          },
          lockedSha: shaOf("alpha"),
          importedComponents: { skills: ["review"], mcpServers: ["docs"] },
        },
        {
          name: "zeta",
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v2.0.0",
            refType: "tag",
            subpath: "packages/zeta",
          },
          lockedSha: shaOf("zeta"),
          importedComponents: { skills: ["review"], mcpServers: ["docs"] },
        },
      ]);
      const raw = await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8");
      for (const local of ["componentConsent", "installedAt", "updatedAt", "autoUpdate"]) {
        expect(raw).not.toContain(local);
      }
    });

    it("writes no install method, whatever marker a plugin's plugin.json carries", async () => {
      await writeRegistry(muxRoot, [registryRow("skills-only"), registryRow("own-manifest")]);
      await writeGeneratedPlugin(muxRoot, "skills-only", { kind: "skills" });
      await writeFixtureFile(
        muxRoot,
        "plugins/own-manifest/plugin.json",
        '{"name":"own-manifest"}'
      );
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      expect(sidecar.plugins.map((p) => p.name)).toEqual(["own-manifest", "skills-only"]);
      expect(sidecar.plugins.filter((p) => "method" in p)).toEqual([]);
    });

    it("leaves out a plugin Xum generated from a Claude Code marketplace entry, and logs it", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      await writeRegistry(muxRoot, [registryRow("skills-only"), registryRow("from-market")]);
      await writeGeneratedPlugin(muxRoot, "skills-only", { kind: "skills" });
      // The registry row names the repository the entry resolved to, which can differ from the
      // marketplace's own repository: the row alone cannot rebuild the entry.
      await writeGeneratedPlugin(muxRoot, "from-market", {
        kind: "claude-marketplace",
        entry: "Market-Entry",
      });
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((p) => p.name)).toEqual(["skills-only"]);
      const logged = info.mock.calls
        .filter(([message]) => String(message).includes("Claude Code marketplace entry"))
        .map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged).toEqual(["from-market"]);
      info.mockRestore();
    });

    it("writes no list with the flag off, and drops one pushed before", async () => {
      await writeRegistry(muxRoot, [registryRow("alpha")]);
      const { payload, managed, request } = await prepare();
      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });
      expect(await exists(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH))).toBe(true);

      await payload.exportTo({ ...request, contents: PLUGINS_OFF });

      expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
    });

    it("writes no list when plugins.json does not exist", async () => {
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
    });

    it.each([
      [
        "more than 512 imported skills",
        {
          importedComponents: {
            skills: Array.from({ length: 513 }, (_, index) => `skill-${index}`),
            mcpServers: [],
          },
        },
        "importedComponents.skills",
      ],
      [
        "a repository URL over 2048 characters",
        {
          source: {
            type: "git",
            url: `https://github.com/example/${"x".repeat(3000)}.git`,
            ref: "main",
            refType: "branch",
          },
        },
        "source.url",
      ],
      [
        "a folder the installer refuses",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "main",
            refType: "branch",
            subpath: "../mono",
          },
        },
        "source.subpath",
      ],
      [
        "a folder written with its slashes (the installer takes it without them)",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "main",
            refType: "branch",
            subpath: "/plugins/beta/",
          },
        },
        "source.subpath",
      ],
      [
        "a URL the installer's source parser refuses (the schema reads ext as an scp host)",
        {
          source: { type: "git", url: "ext::payload", ref: "main", refType: "branch" },
        },
        "source.url",
      ],
      [
        "a URL with a query the installer strips",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git?x=1",
            ref: "main",
            refType: "branch",
          },
        },
        "source.url",
      ],
      [
        "a URL with a fragment the installer strips",
        {
          source: {
            type: "git",
            url: "git@github.com:example/mono.git#main",
            ref: "main",
            refType: "branch",
          },
        },
        "source.url",
      ],
      [
        "a ref git cannot hold",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "feature branch",
            refType: "branch",
          },
        },
        "source.ref",
      ],
      ["a commit that is not a full id", { lockedSha: "abc123" }, "lockedSha"],
      [
        "a ref with a bidi character (a branch the installer takes)",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "ma\u202Ein",
            refType: "branch",
          },
        },
        "source.ref",
      ],
      [
        "a ref with a zero-width joiner (a branch the installer takes)",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "ma\u200Din",
            refType: "branch",
          },
        },
        "source.ref",
      ],
      [
        "a ref with a soft hyphen (a branch the installer takes)",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "ma\u00ADin",
            refType: "branch",
          },
        },
        "source.ref",
      ],
      [
        "a ref with an emoji tag character (a branch the installer takes)",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "ma\u{E0067}in",
            refType: "branch",
          },
        },
        "source.ref",
      ],
      [
        "a ref over 256 characters",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "b".repeat(257),
            refType: "branch",
          },
        },
        "source.ref",
      ],
      [
        "a folder over 1024 characters",
        {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "main",
            refType: "branch",
            subpath: "a".repeat(1025),
          },
        },
        "source.subpath",
      ],
      [
        "an MCP server name over 256 characters",
        { importedComponents: { skills: [], mcpServers: ["m".repeat(257)] } },
        "importedComponents.mcpServers",
      ],
      [
        "a URL that starts with a dash (git would read it as an option)",
        {
          source: { type: "git", url: "-ux:touch", ref: "main", refType: "branch" },
        },
        "source.url",
      ],
    ])(
      "leaves out a plugin with %s, logs its name and the field, and still pushes the others",
      async (_label, overrides, field) => {
        const info = spyOn(log, "info").mockImplementation(() => undefined);
        await writeRegistry(muxRoot, [registryRow("alpha"), registryRow("held-back", overrides)]);
        const { payload, managed, request } = await prepare();

        await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

        const sidecar = (await readSidecar(managed)) as { plugins: Array<{ name: string }> };
        expect(sidecar.plugins.map((plugin) => plugin.name)).toEqual(["alpha"]);
        const logged = info.mock.calls.filter(([message]) =>
          String(message).includes("the backup list cannot hold")
        );
        expect(logged).toHaveLength(1);
        expect(String(logged[0]?.[0])).toContain(field);
        expect(logged[0]?.[1]).toEqual({ plugin: "held-back" });
        // The log names the plugin and the field, never a URL, a ref or a name it holds.
        expect(JSON.stringify(info.mock.calls)).not.toContain("github.com");
        info.mockRestore();
      }
    );

    it("leaves out a plugin installed from a path, a file URL or a host on this machine, and logs it", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      const local = (url: string) => ({ type: "git", url, ref: "main", refType: "branch" });
      const keptUrls = {
        alpha: undefined,
        "ssh-host": "git@github.com:example/ssh-host.git",
        "name-has-localhost": "https://github.com/example/localhost.git",
        "host-starts-with-localhost": "ssh://git@localhost.example.com/example/repo.git",
        // scp-style ssh to a host named `file`: a remote source, which the backup schema reads.
        "scp-host-named-file": "file:host/share/scp-host-named-file.git",
        // A user before a one-letter host is no drive: Git for Windows reads `h:` alone as one.
        "scp-user-one-letter-host": "git@h:example/scp-user-one-letter-host.git",
        // `%20` has no other spelling, so a producer escapes it: this install must still push.
        "escaped-space": "https://dev.azure.com/org/My%20Project/_git/escaped-space",
      } as const;
      const leftOutUrls = {
        "abs-path": "/home/someone/plugins/abs-path",
        "file-url": "file:///home/someone/plugins/file-url",
        "file-url-upper": "FILE:///home/someone/plugins/file-url-upper",
        "nt-share": "/??/UNC/someone/share/nt-share.git",
        "home-path": "~/plugins/home-path",
        "drive-path": "C:\\plugins\\drive-path",
        // Git for Windows opens a drive-relative path as a local folder, not as ssh to a host `C`.
        "drive-relative-path": "C:plugins/drive-relative-path",
        "drive-relative-namespace": String.raw`\\?\C:\plugins\drive-relative-namespace`,
        "ssh-localhost": "ssh://user@localhost/home/someone/repo.git",
        "git-loopback": "git://127.0.0.1/someone/repo.git",
        "scp-localhost": "localhost:someone/repo.git",
        "scp-user-localhost": "user@localhost:someone/repo.git",
        "ipv6-loopback": "ssh://user@[::1]/someone/repo.git",
        "scp-ipv6-loopback": "git@[::1]:someone/repo.git",
        "all-zeros": "http://0.0.0.0/someone/repo.git",
      };
      await writeRegistry(muxRoot, [
        ...Object.entries(keptUrls).map(([name, url]) =>
          registryRow(name, url === undefined ? {} : { source: local(url) })
        ),
        ...Object.entries(leftOutUrls).map(([name, url]) =>
          registryRow(name, { source: local(url) })
        ),
      ]);
      const { payload, managed, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((p) => p.name)).toEqual(Object.keys(keptUrls).sort());
      expect(
        await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8")
      ).not.toContain("someone");
      expect(exported.secretFiles).toEqual([]);
      const logged = info.mock.calls
        .filter(([message]) => String(message).includes("its source is on this machine"))
        .map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged.sort()).toEqual(Object.keys(leftOutUrls).sort());
      info.mockRestore();
    });

    it("leaves out a plugin whose URL has whitespace, a control character or a format character, and logs it", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      // The installer takes an scp-style source with a space, so that plugin works here: the push
      // must not fail for it, or no backup could be made.
      const withUrl = (url: string) => ({ type: "git", url, ref: "main", refType: "branch" });
      const spacedUrls = {
        "scp-with-space": "gitbox:srv/my repos/r.git",
        "https-with-space": "https://github.com/example/two words.git",
        "control-character": "https://github.com/example/re\u0007po.git",
        "right-to-left-mark": "https://github.com/exam\u200Fple/repo.git",
      };
      await writeRegistry(muxRoot, [
        registryRow("alpha"),
        ...Object.entries(spacedUrls).map(([name, url]) =>
          registryRow(name, { source: withUrl(url) })
        ),
      ]);
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((plugin) => plugin.name)).toEqual(["alpha"]);
      const logged = info.mock.calls
        .filter(([message]) => String(message).includes("a format character"))
        .map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged.sort()).toEqual(Object.keys(spacedUrls).sort());
      info.mockRestore();
    });

    it("leaves out a plugin whose URL escapes a letter, a digit or one of - . _ ~, and logs it", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      const withUrl = (url: string) => ({ type: "git", url, ref: "main", refType: "branch" });
      const escapedUrls = {
        // The publish-time secret scan reads the list as written, so this token would pass it.
        "escaped-token": `https://example.com/%67hp_${"a".repeat(36)}/repo.git`,
        "escaped-digit": "https://example.com/org/%31/escaped-digit.git",
        "escaped-tilde": "https://example.com/%7Eorg/escaped-tilde.git",
      };
      await writeRegistry(muxRoot, [
        registryRow("alpha"),
        ...Object.entries(escapedUrls).map(([name, url]) =>
          registryRow(name, { source: withUrl(url) })
        ),
      ]);
      const { payload, managed, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((plugin) => plugin.name)).toEqual(["alpha"]);
      expect(exported.secretFiles).toEqual([]);
      const logged = info.mock.calls
        .filter(([message]) => String(message).includes("as a percent escape"))
        .map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged.sort()).toEqual(Object.keys(escapedUrls).sort());
      info.mockRestore();
    });

    it("leaves out a plugin that hides a token behind an allowed percent escape, and logs only its name", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      const withUrl = (url: string) => ({ type: "git", url, ref: "main", refType: "branch" });
      const hiddenUrls = {
        // `%20` ends the word before the token, so the raw scan finds no `\bghp_`.
        "token-after-space": `https://example.com/%20ghp_${"a".repeat(36)}/repo.git`,
        "key-header": "https://example.com/-----BEGIN%20PRIVATE%20KEY-----/repo.git",
        // An escape of an escape decodes to the token on a second read.
        "double-escaped": `https://example.com/%2520ghp_${"b".repeat(36)}/repo.git`,
        // A malformed escape has no reading to rely on (left out for that, not for a token).
        "malformed-escape": "https://example.com/%E0%A4%A/repo.git",
      };
      await writeRegistry(muxRoot, [
        registryRow("alpha"),
        // A `%20` that hides nothing keeps working, and stays in the list.
        registryRow("spaced", { source: withUrl("https://dev.azure.com/org/My%20Project/_git/x") }),
        ...Object.entries(hiddenUrls).map(([name, url]) =>
          registryRow(name, { source: withUrl(url) })
        ),
      ]);
      const { payload, managed, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const text = await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8");
      const sidecar = JSON.parse(text) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((plugin) => plugin.name)).toEqual(["alpha", "spaced"]);
      expect(text).not.toContain("ghp_");
      expect(text).not.toContain("PRIVATE");
      expect(exported.secretFiles).toEqual([]);
      const logged = info.mock.calls
        .filter(([message]) => String(message).includes("percent escape"))
        .map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged.sort()).toEqual(Object.keys(hiddenUrls).sort());
      // The log names the plugin only: no URL and no token.
      const everything = JSON.stringify(info.mock.calls);
      for (const leak of ["ghp_", "PRIVATE", "example.com"]) expect(everything).not.toContain(leak);
      info.mockRestore();
    });

    it("leaves out a plugin that hides a token behind an escape of two to four levels, and lists a space escaped up to four times", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      const withUrl = (url: string) => ({ type: "git", url, ref: "main", refType: "branch" });
      const token = "a".repeat(36);
      await writeRegistry(muxRoot, [
        registryRow("alpha"),
        // `%2520` is a space escaped twice: it hides nothing, so the plugin stays listed.
        registryRow("spaced-twice", {
          source: withUrl("https://dev.azure.com/org/My%2520Project/_git/x"),
        }),
        // `%2567` is `%67`, which is `g`: the first pass sees only a percent sign.
        registryRow("g-twice", { source: withUrl(`https://example.com/%2567hp_${token}/r.git`) }),
        registryRow("g-thrice", {
          source: withUrl(`https://example.com/%252567hp_${token}/r.git`),
        }),
        // A space escaped twice right before a token: no pass of the raw scan finds the token.
        registryRow("space-twice-token", {
          source: withUrl(`https://example.com/%2520ghp_${token}/r.git`),
        }),
        // Four levels is the most the check decodes. A space escaped four times hides nothing and
        // stays listed. A token behind four levels shows in the fourth form, and is left out.
        registryRow("spaced-four-levels", {
          source: withUrl("https://dev.azure.com/org/My%25252520Project/_git/x"),
        }),
        registryRow("token-four-levels", {
          source: withUrl(`https://example.com/%25252520ghp_${token}/r.git`),
        }),
        // A fifth level is left after the four passes: nothing says how a reader decodes it.
        registryRow("space-five-levels", {
          source: withUrl("https://dev.azure.com/org/My%2525252520Project/_git/x"),
        }),
      ]);
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const text = await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8");
      const sidecar = JSON.parse(text) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((plugin) => plugin.name)).toEqual([
        "alpha",
        "spaced-four-levels",
        "spaced-twice",
      ]);
      expect(text).not.toContain("ghp_");
      const logged = info.mock.calls.map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged.sort()).toEqual([
        "g-thrice",
        "g-twice",
        "space-five-levels",
        "space-twice-token",
        "token-four-levels",
      ]);
      expect(JSON.stringify(info.mock.calls)).not.toContain(token);
      info.mockRestore();
    });

    it("lists a plugin on a ref the installer takes, and leaves out one with a format character", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      const withRef = (name: string, ref: string) =>
        registryRow(name, {
          source: {
            type: "git",
            url: `https://github.com/example/${name}.git`,
            ref,
            refType: "branch",
          },
        });
      // Real git holds all of these as branches, resolves them in `ls-remote` and clones them with
      // `--branch <ref>`, which takes the next argument as its value even when it starts with a dash.
      const listedRefs = {
        main: "main",
        "branch-head": "HEAD",
        "branch-refs-foo": "refs/foo",
        "branch-refs-team": "refs/team",
        "branch-dash-x": "-x",
      };
      // The list refuses what the card would show as another ref: bidi, joiner, soft hyphen, tag.
      const leftOutRefs = {
        "ref-bidi": "ma\u202Ein",
        "ref-joiner": "ma\u200Din",
        "ref-soft-hyphen": "ma\u00ADin",
        "ref-emoji-tag": "ma\u{E0067}in",
      };
      await writeRegistry(muxRoot, [
        ...Object.entries(listedRefs).map(([name, ref]) => withRef(name, ref)),
        ...Object.entries(leftOutRefs).map(([name, ref]) => withRef(name, ref)),
      ]);
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as {
        plugins: Array<{ name: string; source: { ref: string } }>;
      };
      expect(sidecar.plugins.map((plugin) => [plugin.name, plugin.source.ref])).toEqual(
        Object.entries(listedRefs).sort(([a], [b]) => a.localeCompare(b))
      );
      const logged = info.mock.calls
        .filter(([message]) => String(message).includes("source.ref"))
        .map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged.sort()).toEqual(Object.keys(leftOutRefs).sort());
      info.mockRestore();
    });

    it("leaves out a plugin that hides a token behind a JSON escape in a component name", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      const token = `ghp_${"a".repeat(36)}`;
      const imported = (skills: string[], mcpServers: string[]) => ({
        importedComponents: { skills, mcpServers },
      });
      // The installer takes these names. JSON writes the first character as `\n`, `\t` or `\u0001`,
      // so the token has no word boundary in the file the publish-time scan reads.
      const hidden = {
        "server-newline": imported([], [`\n${token}`]),
        "skill-tab": imported([`\t${token}`], []),
        "server-control": imported([], [`\u0001${token}`]),
      };
      await writeRegistry(muxRoot, [
        registryRow("alpha"),
        // Control characters that hide nothing stay listed.
        registryRow("multi-line", imported(["two\nlines"], ["a\tb"])),
        ...Object.entries(hidden).map(([name, overrides]) => registryRow(name, overrides)),
      ]);
      const { payload, managed, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const text = await fs.readFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "utf-8");
      const sidecar = JSON.parse(text) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((plugin) => plugin.name)).toEqual(["alpha", "multi-line"]);
      expect(text).not.toContain("ghp_");
      expect(exported.secretFiles).toEqual([]);
      const logged = info.mock.calls
        .filter(([message]) => String(message).includes("control character"))
        .map(([, fields]) => (fields as { plugin: string }).plugin);
      expect(logged.sort()).toEqual(Object.keys(hidden).sort());
      expect(JSON.stringify(info.mock.calls)).not.toContain("ghp_");
      info.mockRestore();
    });

    it("leaves out a plugin that hides a token in its ref or its folder behind an escape", async () => {
      const info = spyOn(log, "info").mockImplementation(() => undefined);
      const source = (extra: Record<string, unknown>) => ({
        type: "git",
        url: "https://github.com/example/mono.git",
        ref: "main",
        refType: "branch",
        ...extra,
      });
      await writeRegistry(muxRoot, [
        registryRow("alpha"),
        registryRow("ref-token", { source: source({ ref: `%20ghp_${"a".repeat(36)}` }) }),
        registryRow("folder-token", {
          source: source({ subpath: `plugins/%20ghp_${"a".repeat(36)}` }),
        }),
      ]);
      const { payload, managed, request } = await prepare();

      await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      const sidecar = (await readSidecar(managed)) as { plugins: Array<{ name: string }> };
      expect(sidecar.plugins.map((plugin) => plugin.name)).toEqual(["alpha"]);
      expect(JSON.stringify(info.mock.calls)).not.toContain("ghp_");
      info.mockRestore();
    });

    describe("a registry this build cannot read whole", () => {
      const registryFile = () => path.join(muxRoot, "plugins.json");

      async function exportFailure(contents = DEFAULT_CONTENTS) {
        const { payload, managed, request } = await prepare();
        const error = await captureRejection(payload.exportTo({ ...request, contents }));
        return { error: error as { code?: string; message: string }, managed };
      }

      it("refuses the push for a plugins.json that is not JSON, naming the file and the way out", async () => {
        await fs.writeFile(registryFile(), "{ not json", "utf-8");

        const { error, managed } = await exportFailure();

        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toContain(registryFile());
        expect(error.message).toContain('Turning off "Agent plugins"');
        expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
      });

      it("refuses the push for a plugins.json that is not a registry", async () => {
        await fs.writeFile(registryFile(), JSON.stringify({ plugins: "none" }), "utf-8");

        const { error } = await exportFailure();

        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toContain(registryFile());
      });

      it("refuses the push when one entry is one this build cannot read, and counts them", async () => {
        const futureRow = { name: "future", source: { type: "archive", url: "https://x/y.tgz" } };
        await writeRegistry(muxRoot, [registryRow("alpha"), futureRow, registryRow("beta")]);

        const { error } = await exportFailure();

        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toContain(registryFile());
        expect(error.message).toContain("1 of 3 entries");
        expect(error.message).toContain('Turning off "Agent plugins"');
      });

      it("refuses the push when two entries name the same plugin, and counts the second as unreadable", async () => {
        // Both rows pass the schema, so only their name tells them apart from a healthy list.
        await writeRegistry(muxRoot, [
          registryRow("alpha"),
          registryRow("beta"),
          registryRow("alpha", { lockedSha: shaOf("z") }),
        ]);

        const { error, managed } = await exportFailure();

        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toContain(registryFile());
        expect(error.message).toContain("1 of 3 entries");
        expect(error.message).toContain('Turning off "Agent plugins"');
        expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
      });

      it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "refuses the push for a plugins.json it cannot read from disk",
        async () => {
          await writeRegistry(muxRoot, [registryRow("alpha")]);
          await fs.chmod(registryFile(), 0o000);
          try {
            const { error } = await exportFailure();

            expect(error.code).toBe("IO_ERROR");
            expect(error.message).toContain(registryFile());
          } finally {
            await fs.chmod(registryFile(), 0o600);
          }
        }
      );

      it("still backs up without the plugin list once the flag is off", async () => {
        await fs.writeFile(registryFile(), "{ not json", "utf-8");
        const { payload, managed, request } = await prepare();

        await payload.exportTo({ ...request, contents: PLUGINS_OFF });

        expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
      });
    });

    describe("a registry with more plugins than one backup lists", () => {
      /** Rows only: the export reads the registry, never a plugin folder, so nothing is installed. */
      const manyRows = (count: number) =>
        Array.from({ length: count }, (_, index) =>
          registryRow(`plugin-${String(index).padStart(4, "0")}`)
        );

      it("refuses the push instead of keeping the first plugins, and says why and what to do", async () => {
        await writeRegistry(muxRoot, manyRows(MAX_BACKUP_PLUGIN_ENTRIES + 3));
        const { payload, managed, request } = await prepare();

        const error = (await captureRejection(
          payload.exportTo({ ...request, contents: DEFAULT_CONTENTS })
        )) as { code?: string; message: string };

        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toContain(String(MAX_BACKUP_PLUGIN_ENTRIES + 3));
        expect(error.message).toContain(String(MAX_BACKUP_PLUGIN_ENTRIES));
        expect(error.message).toContain('Turning off "Agent plugins"');
        expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
      });

      it("still backs up without the list once the flag is off", async () => {
        await writeRegistry(muxRoot, manyRows(MAX_BACKUP_PLUGIN_ENTRIES + 1));
        const { payload, managed, request } = await prepare();

        await payload.exportTo({ ...request, contents: PLUGINS_OFF });

        expect(await exists(path.join(managed, PLUGIN_BACKUP_DIR))).toBe(false);
      });

      it("lists every plugin of a registry at the cap", async () => {
        await writeRegistry(muxRoot, manyRows(MAX_BACKUP_PLUGIN_ENTRIES));
        const { payload, managed, request } = await prepare();

        await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

        const sidecar = (await readSidecar(managed)) as { plugins: unknown[] };
        expect(sidecar.plugins).toHaveLength(MAX_BACKUP_PLUGIN_ENTRIES);
      });
    });

    describe("against a plugin install, update or uninstall in progress", () => {
      const listedNames = (manifest: Awaited<ReturnType<typeof collectPluginBackup>>) =>
        manifest?.plugins.map((plugin) => `${plugin.name}@${plugin.lockedSha}`);

      it("waits for the mutation, then lists the registry and the markers it left", async () => {
        await writeRegistry(muxRoot, [registryRow("alpha"), registryRow("beta")]);
        const finishMutation = await startMutation();
        let done = false;
        const collecting = collectPluginBackup(muxRoot).finally(() => {
          done = true;
        });

        // A read that ignored the lock would be done long before this.
        await settle();
        expect(done).toBe(false);
        // The mutation lands while the read waits: beta is uninstalled, alpha moves to a new
        // commit, gamma is installed from a Claude Code marketplace entry (which the list omits).
        await writeRegistry(muxRoot, [
          registryRow("alpha", { lockedSha: shaOf("z") }),
          registryRow("gamma"),
        ]);
        await writeGeneratedPlugin(muxRoot, "gamma", {
          kind: "claude-marketplace",
          entry: "Gamma",
        });
        await finishMutation();

        const manifest = await collecting;
        expect(listedNames(manifest)).toEqual([`alpha@${shaOf("z")}`]);
      });

      it("fails the push with an IO_ERROR when the mutation outlasts the wait", async () => {
        await writeRegistry(muxRoot, [registryRow("alpha")]);
        const finishMutation = await startMutation();

        const error = (await captureRejection(collectPluginBackup(muxRoot, 50))) as {
          code?: string;
          message: string;
        };

        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toContain("modifying plugins");
        expect(error.message).toContain('Turning off "Agent plugins"');
        await finishMutation();
        // The failed wait took nothing: the mutation's release leaves the lock free.
        expect(listedNames(await collectPluginBackup(muxRoot, 50))).toEqual([
          `alpha@${shaOf("alpha")}`,
        ]);
      });

      it("frees the lock after a read, whether it lists the plugins or fails", async () => {
        await writeRegistry(muxRoot, [registryRow("alpha")]);
        await collectPluginBackup(muxRoot);
        await (
          await startMutation()
        )();

        await fs.writeFile(path.join(muxRoot, "plugins.json"), "{ not json", "utf-8");
        await captureRejection(collectPluginBackup(muxRoot));
        await (
          await startMutation()
        )();
      });
    });

    it("holds a list that looks like a secret for the push review", async () => {
      await writeRegistry(muxRoot, [
        registryRow("alpha", {
          source: {
            type: "git",
            url: `https://github.com/example/ghp_${"a".repeat(36)}.git`,
            ref: "main",
            refType: "branch",
          },
        }),
      ]);
      const { payload, request } = await prepare();

      const exported = await payload.exportTo({ ...request, contents: DEFAULT_CONTENTS });

      expect(exported.secretFiles).toEqual([PLUGIN_BACKUP_MANIFEST_PATH]);
    });
  });

  describe("preview and restore", () => {
    /** A backup of `rows`, pushed from this root and read back through the store. */
    async function backupOf(rows: unknown[]) {
      await writeRegistry(muxRoot, rows);
      const prepared = await prepare();
      await prepared.payload.exportTo({ ...prepared.request, contents: DEFAULT_CONTENTS });
      return prepared;
    }

    async function useLocalRegistry(rows: unknown[]) {
      await fs.rm(path.join(muxRoot, "plugins"), { recursive: true, force: true });
      await writeRegistry(muxRoot, rows);
    }

    it("compares each listed plugin with this machine's managed installs", async () => {
      const { payload, request } = await backupOf([
        registryRow("missing-one"),
        registryRow("same-one"),
        registryRow("moved-one"),
        registryRow("unmanaged-one"),
        registryRow("gone-one"),
      ]);
      await useLocalRegistry([
        registryRow("same-one"),
        registryRow("moved-one", { lockedSha: shaOf("z") }),
        registryRow("gone-one"),
      ]);
      await writeFixtureFile(muxRoot, "plugins/same-one/plugin.json", "{}");
      await writeFixtureFile(muxRoot, "plugins/unmanaged-one/plugin.json", "{}");

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      const statuses = Object.fromEntries(
        (preview.plugins.rows ?? []).map((row) => [row.name, row.status])
      );
      expect(statuses).toEqual({
        "missing-one": "missing",
        "same-one": "installed",
        "moved-one": "conflict",
        "unmanaged-one": "conflict",
        // Listed in the registry at the same commit, but its folder is gone: not installed.
        "gone-one": "folderMissing",
      });
      expect(preview.plugins.skipped).toBe(false);
    });

    describe("against a plugin install, update or uninstall in progress", () => {
      it("waits for the mutation, then compares with the registry and folders it left", async () => {
        const { payload, request } = await backupOf([registryRow("alpha"), registryRow("beta")]);
        await useLocalRegistry([registryRow("alpha"), registryRow("beta")]);
        await writeFixtureFile(muxRoot, "plugins/alpha/plugin.json", "{}");
        await writeFixtureFile(muxRoot, "plugins/beta/plugin.json", "{}");
        const finishMutation = await startMutation();
        let done = false;
        const previewing = payload
          .previewRestore({ ...request, contents: DEFAULT_CONTENTS })
          .finally(() => {
            done = true;
          });

        await settle();
        expect(done).toBe(false);
        // Beta is uninstalled while the read waits: its registry row and its folder go together.
        await writeRegistry(muxRoot, [registryRow("alpha")]);
        await fs.rm(path.join(muxRoot, "plugins", "beta"), { recursive: true });
        await finishMutation();

        const statuses = Object.fromEntries(
          (await previewing).plugins.rows.map((row) => [row.name, row.status])
        );
        expect(statuses).toEqual({ alpha: "installed", beta: "missing" });
      });

      it("fails with an IO_ERROR that names the way out when the mutation outlasts the wait", async () => {
        const { managed } = await backupOf([registryRow("alpha")]);
        await writeFixtureFile(muxRoot, "plugins/alpha/plugin.json", "{}");
        const finishMutation = await startMutation();

        const error = (await captureRejection(
          readPluginRestore({
            muxRoot,
            sourceDir: managed,
            contents: DEFAULT_CONTENTS,
            lockTimeoutMs: 50,
          })
        )) as { code?: string; message: string };

        expect(error.code).toBe("IO_ERROR");
        expect(error.message).toContain("modifying plugins");
        expect(error.message).toContain('Turning off "Agent plugins" restores');
        await finishMutation();
        // The failed wait took nothing, and a read frees the lock when it is done.
        const report = await readPluginRestore({
          muxRoot,
          sourceDir: managed,
          contents: DEFAULT_CONTENTS,
          lockTimeoutMs: 50,
        });
        expect(report.rows.map((row) => row.status)).toEqual(["installed"]);
        await (
          await startMutation()
        )();
      });

      it("takes no lock with the flag off, which is the way out the error names", async () => {
        const { managed } = await backupOf([registryRow("alpha")]);
        const finishMutation = await startMutation();

        const off = await readPluginRestore({
          muxRoot,
          sourceDir: managed,
          contents: PLUGINS_OFF,
          lockTimeoutMs: 50,
        });

        expect(off.skipped).toBe(true);
        await finishMutation();
      });
    });

    it("reads a plugin of the same name and commit from another repository, spelling or folder as in use", async () => {
      const source = (url: string, subpath?: string) => ({
        type: "git",
        url,
        ref: "main",
        refType: "branch",
        ...(subpath === undefined ? {} : { subpath }),
      });
      const mono = "https://github.com/example/mono.git";
      const { payload, request } = await backupOf([
        registryRow("same-other-slashes", { source: source(mono, "plugins/a") }),
        registryRow("other-spelling", { source: source(mono, "plugins/a") }),
        registryRow("same-over-ssh", { source: source(mono, "plugins/a") }),
        registryRow("other-folder", { source: source(mono, "plugins/a") }),
        registryRow("no-folder", { source: source(mono, "plugins/a") }),
        registryRow("other-repo", { source: source(mono, "plugins/a") }),
        registryRow("other-repo-gone", { source: source(mono, "plugins/a") }),
        registryRow("same-gone", { source: source(mono, "plugins/a") }),
      ]);
      await useLocalRegistry([
        // The same URL as written, so only the slashes of the folder differ.
        registryRow("same-other-slashes", { source: source(mono, "/plugins/a/") }),
        // The same repository in another spelling is another source: the user approves it once.
        registryRow("other-spelling", {
          source: source("https://GitHub.com:443/example/mono/", "plugins/a"),
        }),
        registryRow("same-over-ssh", {
          source: source("git@github.com:example/mono", "plugins/a"),
        }),
        registryRow("other-folder", { source: source(mono, "plugins/b") }),
        registryRow("no-folder", { source: source(mono) }),
        registryRow("other-repo", {
          source: source("https://github.com/someone/mono.git", "plugins/a"),
        }),
        registryRow("other-repo-gone", {
          source: source("https://github.com/someone/mono.git", "plugins/a"),
        }),
        registryRow("same-gone", { source: source(mono, "plugins/a") }),
      ]);
      for (const name of [
        "same-other-slashes",
        "other-spelling",
        "same-over-ssh",
        "other-folder",
        "no-folder",
        "other-repo",
      ]) {
        await writeFixtureFile(muxRoot, `plugins/${name}/plugin.json`, "{}");
      }

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      const statuses = Object.fromEntries(
        (preview.plugins.rows ?? []).map((row) => [row.name, row.status])
      );
      expect(statuses).toEqual({
        "same-other-slashes": "installed",
        "other-spelling": "conflict",
        "same-over-ssh": "conflict",
        "other-folder": "conflict",
        "no-folder": "conflict",
        "other-repo": "conflict",
        // Another source cannot be a plugin whose folder is gone: a reinstall would still collide.
        "other-repo-gone": "conflict",
        "same-gone": "folderMissing",
      });
    });

    it("reads the https form of a listed ssh source as that plugin, and nothing else as it", async () => {
      const source = (url: string) => ({ type: "git", url, ref: "main", refType: "branch" });
      const { payload, request } = await backupOf([
        registryRow("ssh-listed", { source: source("git@github.com:example/ssh-listed.git") }),
        registryRow("ssh-url-listed", {
          source: source("ssh://git@host.example:2222/example/ssh-url-listed.git"),
        }),
        registryRow("https-listed", {
          source: source("https://github.com/example/https-listed.git"),
        }),
        registryRow("another-path", { source: source("git@github.com:example/another-path.git") }),
        registryRow("another-port", {
          source: source("ssh://git@host.example:2222/example/another-port.git"),
        }),
      ]);
      await useLocalRegistry([
        // Installed by a review from the https address of the listed ssh source.
        registryRow("ssh-listed", { source: source("https://github.com/example/ssh-listed.git") }),
        registryRow("ssh-url-listed", {
          source: source("https://host.example/example/ssh-url-listed.git"),
        }),
        // Installed over ssh where the backup lists the https address.
        registryRow("https-listed", { source: source("git@github.com:example/https-listed.git") }),
        registryRow("another-path", { source: source("https://github.com/example/elsewhere.git") }),
        registryRow("another-port", {
          source: source("ssh://git@host.example:2200/example/another-port.git"),
        }),
      ]);
      for (const name of [
        "ssh-listed",
        "ssh-url-listed",
        "https-listed",
        "another-path",
        "another-port",
      ]) {
        await writeFixtureFile(muxRoot, `plugins/${name}/plugin.json`, "{}");
      }

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      expect(Object.fromEntries(preview.plugins.rows.map((row) => [row.name, row.status]))).toEqual(
        {
          "ssh-listed": "installed",
          "ssh-url-listed": "installed",
          "https-listed": "installed",
          "another-path": "conflict",
          "another-port": "conflict",
        }
      );
    });

    it("hands back the pin and the source a reinstall needs", async () => {
      const { payload, request } = await backupOf([
        registryRow("alpha", {
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v1.0.0",
            refType: "tag",
            subpath: "plugins/alpha",
          },
        }),
      ]);
      await useLocalRegistry([]);

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      expect(preview.plugins.rows).toEqual([
        {
          name: "alpha",
          source: {
            type: "git",
            url: "https://github.com/example/mono.git",
            ref: "v1.0.0",
            refType: "tag",
            subpath: "plugins/alpha",
          },
          lockedSha: shaOf("alpha"),
          importedComponents: { skills: ["review"], mcpServers: ["docs"] },
          status: "missing",
        },
      ]);
    });

    it("reports the list on restore and installs nothing", async () => {
      const { payload, request } = await backupOf([registryRow("alpha")]);
      await useLocalRegistry([]);
      const registryBefore = await fs.readFile(path.join(muxRoot, "plugins.json"), "utf-8");

      const restored = await payload.restore({
        ...request,
        contents: DEFAULT_CONTENTS,
        snapshotPath: path.join(tempDir, "snapshot"),
        matchedProjects: [],
      });

      expect(restored.plugins.rows.map((row) => [row.name, row.status])).toEqual([
        ["alpha", "missing"],
      ]);
      expect(await fs.readFile(path.join(muxRoot, "plugins.json"), "utf-8")).toBe(registryBefore);
      expect(await exists(path.join(muxRoot, "plugins"))).toBe(false);
      expect(restored.changedFiles.some((file) => file.includes("plugin"))).toBe(false);
    });

    it("skips the list with the flag off and reports that it did", async () => {
      const { payload, request } = await backupOf([registryRow("alpha")]);
      await useLocalRegistry([]);

      const preview = await payload.previewRestore({ ...request, contents: PLUGINS_OFF });
      const restored = await payload.restore({
        ...request,
        contents: PLUGINS_OFF,
        snapshotPath: path.join(tempDir, "snapshot"),
        matchedProjects: [],
      });

      expect(preview.plugins.rows).toEqual([]);
      expect(preview.plugins.skipped).toBe(true);
      expect(restored.plugins.rows).toEqual([]);
      expect(restored.plugins.skipped).toBe(true);
    });

    it("restores a backup that has no list as before", async () => {
      await writeFixtureFile(muxRoot, "AGENTS.md", "instructions\n");
      const { payload, request } = await backupOf([]);

      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });

      expect(preview.plugins.rows).toEqual([]);
      expect(preview.plugins.skipped).toBe(false);
    });

    async function writeSidecar(managed: string, content: string) {
      await fs.writeFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), content, "utf-8");
    }

    /** What a preview and a restore validation make of the list as it is checked out now. */
    async function previewAndValidate(
      payload: Awaited<ReturnType<typeof prepare>>["payload"],
      request: Awaited<ReturnType<typeof prepare>>["request"]
    ) {
      const preview = await payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS });
      await payload.validateRestore({ ...request, contents: DEFAULT_CONTENTS });
      return preview;
    }

    it("reports a list that is not JSON and still previews and validates the restore", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      await writeSidecar(managed, "{ not json");

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows).toEqual([]);
      expect(preview.plugins.warnings).toHaveLength(1);
      expect(preview.plugins.skipped).toBe(false);
    });

    it.each([
      ["a list that is not an object", "[]"],
      ["a list of another version", JSON.stringify({ schemaVersion: 2, plugins: [] })],
      ["a list without a plugins array", JSON.stringify({ schemaVersion: 1 })],
    ])("skips the whole list for %s, and reports it", async (_label, content) => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      await writeSidecar(managed, content);

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows).toEqual([]);
      expect(preview.plugins.warnings).toHaveLength(1);
    });

    it("leaves out a row this build cannot read and keeps the others", async () => {
      const { payload, managed, request } = await backupOf([
        registryRow("alpha"),
        registryRow("beta"),
      ]);
      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      const [alpha, beta] = sidecar.plugins;
      const future = {
        ...alpha,
        name: "future",
        source: { type: "archive", url: "https://example.com/future.tgz" },
      };
      await writeSidecar(
        managed,
        JSON.stringify({ schemaVersion: 1, plugins: [alpha, future, beta] })
      );

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows.map((row) => row.name)).toEqual(["alpha", "beta"]);
      expect(preview.plugins.warnings).toHaveLength(1);
      expect(preview.plugins.warnings?.[0]).toContain("future");
    });

    it("leaves out a row with no name, a row whose entry breaks the schema, and a repeated name", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      const [alpha] = sidecar.plugins;
      const rows = [
        alpha,
        { source: alpha?.source },
        { ...alpha, name: "pinned-to-a-branch", lockedSha: "main" },
        alpha,
      ];
      await writeSidecar(managed, JSON.stringify({ schemaVersion: 1, plugins: rows }));

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows.map((row) => row.name)).toEqual(["alpha"]);
      expect(preview.plugins.warnings).toHaveLength(3);
    });

    it("leaves out a row whose url git would read as an option or a network share, and a row pinned to a short id", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      const [alpha] = sidecar.plugins;
      const option = {
        ...alpha,
        name: "option-url",
        source: { type: "git", url: "--upload-pack=x", ref: "main", refType: "branch" },
      };
      const short = { ...alpha, name: "short-id", lockedSha: "a".repeat(39) };
      const share = {
        ...alpha,
        name: "unc-share",
        source: { type: "git", url: "//host/share/repo.git", ref: "main", refType: "branch" },
      };
      await writeSidecar(
        managed,
        JSON.stringify({ schemaVersion: 1, plugins: [alpha, option, short, share] })
      );

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows.map((row) => row.name)).toEqual(["alpha"]);
      expect(preview.plugins.warnings).toHaveLength(3);
    });

    it("leaves out a row whose folder the installer refuses or whose ref git cannot hold", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      const [alpha] = sidecar.plugins;
      const mono = "https://github.com/example/mono.git";
      const source = (extra: Record<string, unknown>) => ({
        type: "git",
        url: mono,
        ref: "main",
        refType: "branch",
        ...extra,
      });
      const rows = [
        alpha,
        { ...alpha, name: "absolute-folder", source: source({ subpath: "/plugins/demo" }) },
        { ...alpha, name: "parent-folder", source: source({ subpath: "../demo" }) },
        { ...alpha, name: "git-folder", source: source({ subpath: ".git" }) },
        { ...alpha, name: "spaced-ref", source: source({ ref: "feature branch" }) },
        { ...alpha, name: "short-id-ref", source: source({ ref: "abc1234" }) },
        { ...alpha, name: "kept-folder", source: source({ subpath: "plugins/demo" }) },
      ];
      await writeSidecar(managed, JSON.stringify({ schemaVersion: 1, plugins: rows }));

      const preview = await previewAndValidate(payload, request);

      // A row the install review would refuse is never offered for it.
      expect(preview.plugins.rows.map((row) => row.name)).toEqual(["alpha", "kept-folder"]);
      expect(preview.plugins.warnings).toHaveLength(5);
    });

    it("leaves out a row whose url the installer's source parser refuses or rewrites", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      const [alpha] = sidecar.plugins;
      const withUrl = (name: string, url: string) => ({
        ...alpha,
        name,
        source: { type: "git", url, ref: "main", refType: "branch" },
      });
      const rows = [
        alpha,
        // The schema reads `ext` as an scp host: the preview would refuse it as a remote helper.
        withUrl("remote-helper", "ext::payload"),
        // The parser strips a query and a fragment, so the preview would fetch another URL than
        // the row names.
        withUrl("with-query", "https://github.com/example/repo.git?x=1"),
        withUrl("with-fragment", "git@github.com:example/repo.git#main"),
      ];
      await writeSidecar(managed, JSON.stringify({ schemaVersion: 1, plugins: rows }));

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows.map((row) => row.name)).toEqual(["alpha"]);
      expect(preview.plugins.warnings).toHaveLength(3);
    });

    it("reads only the first rows of an oversized list and caps the warnings", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const sidecar = (await readSidecar(managed)) as { plugins: Array<Record<string, unknown>> };
      const [alpha] = sidecar.plugins;
      const broken = Array.from({ length: 12 }, (_, i) => ({ name: `broken-${i}` }));
      const valid = Array.from({ length: 510 }, (_, i) => ({ ...alpha, name: `plugin-${i}` }));
      await writeSidecar(
        managed,
        JSON.stringify({ schemaVersion: 1, plugins: [...broken, ...valid] })
      );

      const preview = await previewAndValidate(payload, request);

      // 522 rows: the first 512 are read, so 12 broken rows and 500 valid ones. The 12 problems
      // become 10 row warnings, one "2 more" line and one line about the rows past 512.
      expect(preview.plugins.rows).toHaveLength(500);
      expect(preview.plugins.warnings).toHaveLength(12);
      // The summary lines name how many problems the cap hid and how many rows were never read.
      expect(preview.plugins.warnings?.at(-2)).toMatch(/\b2\b/);
      expect(preview.plugins.warnings?.at(-1)).toMatch(/\b512\b/);
    });

    it("reports a list that is a symlink out of the backup without following it", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const outside = path.join(tempDir, "outside.json");
      const sidecar = (await readSidecar(managed)) as { plugins: unknown[] };
      await fs.writeFile(outside, JSON.stringify(sidecar), "utf-8");
      const manifest = path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH);
      await fs.rm(manifest);
      await fs.symlink(outside, manifest);

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows).toEqual([]);
      expect(preview.plugins.warnings).toHaveLength(1);
    });

    it("reports a sidecar folder that is a symlink without reading through it", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      const outside = path.join(tempDir, "outside-sidecar");
      await fs.mkdir(outside, { recursive: true });
      await fs.copyFile(
        path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH),
        path.join(outside, path.basename(PLUGIN_BACKUP_MANIFEST_PATH))
      );
      const sidecarDir = path.dirname(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH));
      await fs.rm(sidecarDir, { recursive: true });
      await fs.symlink(outside, sidecarDir, "dir");

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows).toEqual([]);
      expect(preview.plugins.warnings).toHaveLength(1);
    });

    it("reports a sidecar folder with no list file", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      await fs.rm(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH));

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.rows).toEqual([]);
      expect(preview.plugins.warnings).toHaveLength(1);
    });

    it("reports no warnings for a list it can read whole", async () => {
      const { payload, request } = await backupOf([registryRow("alpha")]);

      const preview = await previewAndValidate(payload, request);

      expect(preview.plugins.warnings).toEqual([]);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "still throws when the list file cannot be read from disk",
      async () => {
        const { payload, managed, request } = await backupOf([registryRow("alpha")]);
        const manifest = path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH);
        await fs.chmod(manifest, 0o000);

        const error = await captureRejection(
          payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS })
        );
        await fs.chmod(manifest, 0o600);

        expect((error as { code?: string }).code).toBe("EACCES");
      }
    );

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "still throws when the sidecar folder cannot be searched",
      async () => {
        const { payload, managed, request } = await backupOf([registryRow("alpha")]);
        const sidecarDir = path.dirname(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH));
        await fs.chmod(sidecarDir, 0o000);

        const error = await captureRejection(
          payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS })
        );
        await fs.chmod(sidecarDir, 0o700);

        expect((error as { code?: string }).code).toBe("EACCES");
      }
    );

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "fails the preview, not reads a plugin as missing, when the plugins folder cannot be read",
      async () => {
        const { payload, request } = await backupOf([registryRow("alpha")]);
        await useLocalRegistry([]);
        const plugins = path.join(muxRoot, "plugins");
        await fs.mkdir(plugins);
        await fs.chmod(plugins, 0o000);
        try {
          const error = await captureRejection(
            payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS })
          );
          expect((error as { code?: string }).code).toBe("EACCES");
          // Validation reads only the list: it needs nothing from this machine's plugins folder.
          await payload.validateRestore({ ...request, contents: DEFAULT_CONTENTS });
        } finally {
          await fs.chmod(plugins, 0o700);
        }
      }
    );

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "fails the preview, not reads a plugin as installed, when its folder cannot be checked",
      async () => {
        const { payload, request } = await backupOf([registryRow("alpha")]);
        await useLocalRegistry([registryRow("alpha")]);
        const plugins = path.join(muxRoot, "plugins");
        await fs.mkdir(path.join(plugins, "alpha"), { recursive: true });
        await fs.chmod(plugins, 0o000);
        try {
          const error = await captureRejection(
            payload.previewRestore({ ...request, contents: DEFAULT_CONTENTS })
          );
          expect((error as { code?: string }).code).toBe("EACCES");
        } finally {
          await fs.chmod(plugins, 0o700);
        }
      }
    );

    it("lets a malformed list through when the flag is off", async () => {
      const { payload, managed, request } = await backupOf([registryRow("alpha")]);
      await fs.writeFile(path.join(managed, PLUGIN_BACKUP_MANIFEST_PATH), "{ not json", "utf-8");

      const preview = await payload.previewRestore({ ...request, contents: PLUGINS_OFF });

      expect(preview.plugins.skipped).toBe(true);
    });
  });

  describe("through the service", () => {
    function serviceFor(root: string): BackupService {
      return new BackupService(new Config(root), {
        gitRepo: createBackupGitRepo({ cacheRoot: path.join(root, "backup-cache") }),
        payload: createBackupPayloadStore({ config: new Config(root) }),
      });
    }

    async function pushFromFirstMachine(rows: unknown[]) {
      await writeFixtureFile(muxRoot, "AGENTS.md", "from the first machine\n");
      await writeRegistry(muxRoot, rows);
      const pushed = await serviceFor(muxRoot).push(settings);
      if (!pushed.success) throw new Error(pushed.error.message);
    }

    async function secondMachine(): Promise<string> {
      const root = path.join(tempDir, "second-root");
      await fs.mkdir(root, { recursive: true });
      return root;
    }

    it("offers the first machine's plugins on a second one without installing them", async () => {
      await pushFromFirstMachine([registryRow("alpha"), registryRow("beta")]);
      const second = await secondMachine();

      const restored = await serviceFor(second).restore(settings);

      if (!restored.success) throw new Error(restored.error.message);
      expect(await fs.readFile(path.join(second, "AGENTS.md"), "utf-8")).toBe(
        "from the first machine\n"
      );
      expect(restored.data.plugins.rows.map((row) => [row.name, row.status])).toEqual([
        ["alpha", "missing"],
        ["beta", "missing"],
      ]);
      expect(await exists(path.join(second, "plugins.json"))).toBe(false);
      expect(await exists(path.join(second, "plugins"))).toBe(false);
    });

    describe("push approval", () => {
      /** The second machine's install set, then its push (with the approval a user would give). */
      async function pushFromSecondMachine(
        rows: unknown[],
        options: { approvedPluginRemovalDigest?: string; plugins?: boolean } = {}
      ) {
        const root = await secondMachine();
        await writeRegistry(root, rows);
        return await serviceFor(root).push(
          { ...settings, includePlugins: options.plugins ?? true },
          { approvedPluginRemovalDigest: options.approvedPluginRemovalDigest }
        );
      }

      async function listedRows(): Promise<
        Array<{ name: string; lockedSha: string; source: { url: string; subpath?: string } }>
      > {
        const clone = path.join(tempDir, "inspect");
        await fs.rm(clone, { recursive: true, force: true });
        await runGit(["clone", "--quiet", originPath, clone]);
        const text = await fs
          .readFile(path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH), "utf-8")
          .catch(() => null);
        if (text === null) return [];
        return (JSON.parse(text) as { plugins: Awaited<ReturnType<typeof listedRows>> }).plugins;
      }

      async function listedNames(): Promise<string[]> {
        return (await listedRows()).map((row) => row.name);
      }

      /** Another machine's push, as far as this one can tell: the list in the repository changes. */
      async function keepOnlyInBackup(names: string[]) {
        const clone = path.join(tempDir, "tamper");
        await runGit(["clone", "--quiet", originPath, clone]);
        const file = path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH);
        const list = JSON.parse(await fs.readFile(file, "utf-8")) as {
          plugins: Array<{ name: string }>;
        };
        list.plugins = list.plugins.filter((plugin) => names.includes(plugin.name));
        await fs.writeFile(file, JSON.stringify(list), "utf-8");
        await commitAll(clone, "shrink the plugin list");
        await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);
      }

      function removalOf(result: Awaited<ReturnType<BackupService["push"]>>) {
        if (result.success) throw new Error("expected the push to be refused");
        expect(result.error.code).toBe("PLUGIN_REMOVAL_APPROVAL_REQUIRED");
        if (result.error.pluginRemoval == null) throw new Error("the refusal names no removal");
        return result.error.pluginRemoval;
      }

      it("refuses a push that leaves a listed plugin out, and names it", async () => {
        await pushFromFirstMachine([registryRow("alpha"), registryRow("beta")]);

        const refused = await pushFromSecondMachine([registryRow("gamma"), registryRow("beta")]);

        expect(removalOf(refused)).toMatchObject({ names: ["alpha"], wholeList: false });
        expect(await listedNames()).toEqual(["alpha", "beta"]);
      });

      const gitSource = (url: string, subpath?: string) => ({
        type: "git",
        url,
        ref: "main",
        refType: "branch",
        ...(subpath === undefined ? {} : { subpath }),
      });

      it("counts a plugin the machine now installs from another repository as removed", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        const otherSource = registryRow("alpha", {
          source: gitSource("https://github.com/someone-else/alpha.git"),
        });

        const refused = removalOf(await pushFromSecondMachine([otherSource]));

        expect(refused).toMatchObject({ names: ["alpha"], wholeList: false });
        expect((await listedRows())[0]?.source.url).toBe("https://github.com/example/alpha.git");

        const pushed = await pushFromSecondMachine([otherSource], {
          approvedPluginRemovalDigest: refused.approval,
        });
        expect(pushed.success).toBe(true);
        expect((await listedRows())[0]?.source.url).toBe(
          "https://github.com/someone-else/alpha.git"
        );
      });

      it("counts a plugin the machine now installs from another folder of the repository as removed", async () => {
        await pushFromFirstMachine([
          registryRow("alpha", {
            source: gitSource("https://github.com/example/mono.git", "plugins/alpha"),
          }),
        ]);

        const refused = await pushFromSecondMachine([
          registryRow("alpha", {
            source: gitSource("https://github.com/example/mono.git", "packages/alpha"),
          }),
        ]);

        expect(removalOf(refused).names).toEqual(["alpha"]);
      });

      it("keeps a plugin without approval when only its commit or ref moved", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);

        const pushed = await pushFromSecondMachine([
          registryRow("alpha", {
            lockedSha: shaOf("z"),
            source: { ...gitSource("https://github.com/example/alpha.git"), ref: "v2.0.0" },
          }),
        ]);

        expect(pushed.success).toBe(true);
        expect((await listedRows())[0]).toMatchObject({ name: "alpha", lockedSha: shaOf("z") });
      });

      it.each([
        ["a host in another case", "https://GitHub.com/example/alpha.git"],
        ["no .git", "https://github.com/example/alpha"],
        ["the default port", "https://github.com:443/example/alpha.git"],
        ["a trailing slash", "https://github.com/example/alpha.git/"],
      ])("asks for approval when the same repository is spelled with %s", async (_label, url) => {
        await pushFromFirstMachine([registryRow("alpha")]);

        const refused = await pushFromSecondMachine([
          registryRow("alpha", { source: gitSource(url) }),
        ]);

        expect(removalOf(refused).names).toEqual(["alpha"]);
      });

      it("asks for approval once when an ssh install is not exactly the https form of the listed URL", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        // The other machine has an SSH agent, so `example/alpha` shorthand became an scp URL there.
        // Its https form (no `.git`) is not the listed `...alpha.git`: another spelling, another source.
        const overSsh = [
          registryRow("alpha", { source: gitSource("git@github.com:example/alpha") }),
        ];

        const refused = await pushFromSecondMachine(overSsh);

        expect(removalOf(refused).names).toEqual(["alpha"]);
        expect((await listedRows()).map((row) => row.source.url)).toEqual([
          "https://github.com/example/alpha.git",
        ]);
        const approved = await pushFromSecondMachine(overSsh, {
          approvedPluginRemovalDigest: removalOf(refused).approval,
        });
        expect(approved.success).toBe(true);
        expect((await listedRows()).map((row) => row.source.url)).toEqual([
          "git@github.com:example/alpha",
        ]);
        // The backup now spells it that way, so the next push needs no approval.
        expect((await pushFromSecondMachine(overSsh)).success).toBe(true);
      });

      it("needs no approval when the install is the https form of the listed ssh source, or the other way round", async () => {
        const https = registryRow("alpha", {
          source: gitSource("https://github.com/example/alpha.git"),
        });
        const overSsh = registryRow("alpha", {
          source: gitSource("git@github.com:example/alpha.git"),
        });
        // The backup lists the ssh source. A review installed it from its https address.
        await pushFromFirstMachine([overSsh]);
        expect((await pushFromSecondMachine([https])).success).toBe(true);
        expect((await listedRows()).map((row) => row.source.url)).toEqual([
          "https://github.com/example/alpha.git",
        ]);

        // The machine that installed it over ssh pushes next, and is not asked in turn.
        expect((await pushFromSecondMachine([overSsh])).success).toBe(true);
        expect((await listedRows()).map((row) => row.source.url)).toEqual([
          "git@github.com:example/alpha.git",
        ]);
      });

      it.each([
        [
          "another port",
          "ssh://git@host.example:2222/example/alpha.git",
          "ssh://git@host.example:2200/example/alpha.git",
        ],
        ["another path", "git@github.com:example/alpha.git", "https://github.com/example/beta.git"],
        [
          "another host",
          "git@github.com:example/alpha.git",
          "https://gitlab.com/example/alpha.git",
        ],
        [
          "an ssh and an scp spelling",
          "ssh://git@github.com/example/alpha.git",
          "git@github.com:example/alpha.git",
        ],
      ])("still asks for approval for %s", async (_label, listed, installed) => {
        await pushFromFirstMachine([registryRow("alpha", { source: gitSource(listed) })]);

        const refused = await pushFromSecondMachine([
          registryRow("alpha", { source: gitSource(installed) }),
        ]);

        expect(removalOf(refused).names).toEqual(["alpha"]);
      });

      it("pushes a plugin whose ref the list refuses without it, and asks before it drops one that was listed", async () => {
        const withRef = (name: string, ref: string) =>
          registryRow(name, {
            source: {
              type: "git",
              url: `https://github.com/example/${name}.git`,
              ref,
              refType: "branch",
            },
          });
        await pushFromFirstMachine([withRef("alpha", "main"), withRef("beta", "main")]);

        // The installer takes a branch with a bidi mark (or a zero-width joiner), the list does not.
        const refused = removalOf(
          await pushFromSecondMachine([
            withRef("alpha", "main"),
            withRef("beta", "ma\u202Ein"),
            withRef("gamma", "ma\u200Din"),
          ])
        );
        // Only the plugin that was listed is named. `gamma` was never in the backup.
        expect(refused).toMatchObject({ names: ["beta"], wholeList: false, unreadable: false });
        expect(await listedNames()).toEqual(["alpha", "beta"]);

        const approved = await pushFromSecondMachine(
          [withRef("alpha", "main"), withRef("beta", "ma\u202Ein"), withRef("gamma", "ma\u200Din")],
          { approvedPluginRemovalDigest: refused.approval }
        );
        expect(approved.success).toBe(true);
        expect(await listedNames()).toEqual(["alpha"]);
      });

      it("pushes once the approval of that removal comes back with it", async () => {
        await pushFromFirstMachine([registryRow("alpha"), registryRow("beta")]);
        const refused = removalOf(await pushFromSecondMachine([registryRow("beta")]));

        const pushed = await pushFromSecondMachine([registryRow("beta")], {
          approvedPluginRemovalDigest: refused.approval,
        });

        expect(pushed.success).toBe(true);
        expect(await listedNames()).toEqual(["beta"]);
      });

      it("asks again when the removal changed since it was approved", async () => {
        await pushFromFirstMachine([registryRow("alpha"), registryRow("beta")]);
        const approved = removalOf(await pushFromSecondMachine([registryRow("gamma")]));
        await keepOnlyInBackup(["alpha"]);

        const again = await pushFromSecondMachine([registryRow("gamma")], {
          approvedPluginRemovalDigest: approved.approval,
        });

        expect(removalOf(again).names).toEqual(["alpha"]);
        expect(removalOf(again).approval).not.toBe(approved.approval);
        expect(await listedNames()).toEqual(["alpha"]);
      });

      it("refuses a flag-off push that deletes the whole list, and deletes it once approved", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);

        const refused = removalOf(
          await pushFromSecondMachine([registryRow("alpha")], { plugins: false })
        );
        expect(refused).toMatchObject({ names: ["alpha"], wholeList: true });
        expect(await listedNames()).toEqual(["alpha"]);

        const pushed = await pushFromSecondMachine([registryRow("alpha")], {
          plugins: false,
          approvedPluginRemovalDigest: refused.approval,
        });
        expect(pushed.success).toBe(true);
        expect(await listedNames()).toEqual([]);
      });

      it("guards a list it cannot read, which it cannot name, when the push writes none", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        const clone = path.join(tempDir, "tamper");
        await runGit(["clone", "--quiet", originPath, clone]);
        await fs.writeFile(path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH), "[]", "utf-8");
        await commitAll(clone, "break the plugin list");
        await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);

        const refused = removalOf(await pushFromSecondMachine([], { plugins: false }));

        expect(refused).toMatchObject({ names: [], wholeList: true });
      });

      it("refuses a push that would drop list entries this build cannot read, and drops them once approved", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        const clone = path.join(tempDir, "tamper");
        await runGit(["clone", "--quiet", originPath, clone]);
        const file = path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH);
        const list = JSON.parse(await fs.readFile(file, "utf-8")) as { plugins: unknown[] };
        // A row a newer Xum could write: a source kind this build does not know.
        list.plugins.push({ name: "future", source: { type: "archive", url: "https://x/y.tgz" } });
        await fs.writeFile(file, JSON.stringify(list), "utf-8");
        await commitAll(clone, "add a row from a newer build");
        await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);

        const refused = removalOf(await pushFromSecondMachine([registryRow("alpha")]));
        expect(refused).toMatchObject({ names: [], wholeList: false, unreadable: true });

        const pushed = await pushFromSecondMachine([registryRow("alpha")], {
          approvedPluginRemovalDigest: refused.approval,
        });
        expect(pushed.success).toBe(true);
        expect(await listedNames()).toEqual(["alpha"]);
      });

      /** Another machine's push of a change to the stored list file, applied to a fresh clone. */
      async function changeStoredList(change: (file: string) => Promise<void>) {
        const clone = path.join(tempDir, "tamper");
        await fs.rm(clone, { recursive: true, force: true });
        await runGit(["clone", "--quiet", originPath, clone]);
        await change(path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH));
        await commitAll(clone, "change the plugin list");
        await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);
      }

      it("asks again when another machine changes only the entries this build cannot read", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        const addFuture = (url: string) =>
          changeStoredList(async (file) => {
            const list = JSON.parse(await fs.readFile(file, "utf-8")) as {
              plugins: Array<{ name: string }>;
            };
            list.plugins = list.plugins.filter((plugin) => plugin.name !== "future");
            list.plugins.push({ name: "future", source: { type: "archive", url } } as never);
            await fs.writeFile(file, JSON.stringify(list), "utf-8");
          });
        await addFuture("https://x/one.tgz");
        const shown = removalOf(await pushFromSecondMachine([registryRow("alpha")]));

        // Same names and flags, other unreadable bytes: the approval of the card on screen no
        // longer covers what the push would drop.
        await addFuture("https://x/two.tgz");
        const again = removalOf(
          await pushFromSecondMachine([registryRow("alpha")], {
            approvedPluginRemovalDigest: shown.approval,
          })
        );

        expect(again).toMatchObject({ names: [], wholeList: false, unreadable: true });
        expect(again.approval).not.toBe(shown.approval);
        expect(await listedNames()).toEqual(["alpha", "future"]);
      });

      it("asks again when a list this build cannot read at all is unreadable for another reason", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        // No file to hash: the approval rests on why the list was not read.
        await changeStoredList(async (file) => {
          // The folder stays (git keeps no empty one), so the list is there but has no file.
          await fs.writeFile(path.join(path.dirname(file), "notes.txt"), "kept", "utf-8");
          await fs.rm(file);
        });
        const shown = removalOf(await pushFromSecondMachine([registryRow("alpha")]));
        const repeated = removalOf(await pushFromSecondMachine([registryRow("alpha")]));
        expect(repeated.approval).toBe(shown.approval);

        await changeStoredList(async (file) => {
          await fs.writeFile(path.join(tempDir, "outside.json"), "{}", "utf-8");
          await fs.symlink(path.join(tempDir, "outside.json"), file);
        });
        const again = removalOf(
          await pushFromSecondMachine([registryRow("alpha")], {
            approvedPluginRemovalDigest: shown.approval,
          })
        );

        expect(again).toMatchObject({ names: [], wholeList: false, unreadable: true });
        expect(again.approval).not.toBe(shown.approval);
      });

      it("asks again when the same names gain an unreadable part or the whole list", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        const namesOnly = removalOf(await pushFromSecondMachine([registryRow("beta")]));
        expect(namesOnly).toMatchObject({ names: ["alpha"], wholeList: false, unreadable: false });

        // The same name, now with the whole list going: the earlier approval does not cover it.
        const whole = removalOf(
          await pushFromSecondMachine([registryRow("beta")], {
            plugins: false,
            approvedPluginRemovalDigest: namesOnly.approval,
          })
        );
        expect(whole).toMatchObject({ names: ["alpha"], wholeList: true });

        const clone = path.join(tempDir, "tamper");
        await runGit(["clone", "--quiet", originPath, clone]);
        const file = path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH);
        const list = JSON.parse(await fs.readFile(file, "utf-8")) as { plugins: unknown[] };
        list.plugins.push({ name: "future", source: { type: "archive", url: "https://x/y.tgz" } });
        await fs.writeFile(file, JSON.stringify(list), "utf-8");
        await commitAll(clone, "add a row from a newer build");
        await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);

        // The same name, now with an unreadable part: the names-only approval does not cover it.
        const withUnreadable = removalOf(
          await pushFromSecondMachine([registryRow("beta")], {
            approvedPluginRemovalDigest: namesOnly.approval,
          })
        );
        expect(withUnreadable).toMatchObject({ names: ["alpha"], unreadable: true });
        expect(await listedNames()).toEqual(["alpha", "future"]);
      });

      it("treats a machine with nothing installed as removing the whole list", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);

        const refused = removalOf(await pushFromSecondMachine([]));

        expect(refused).toMatchObject({ names: ["alpha"], wholeList: true });
      });

      it("needs no approval for a first list, an unchanged list or a list that only grows", async () => {
        expect((await pushFromSecondMachine([registryRow("alpha")])).success).toBe(true);
        expect((await pushFromSecondMachine([registryRow("alpha")])).success).toBe(true);
        expect(
          (await pushFromSecondMachine([registryRow("alpha"), registryRow("beta")])).success
        ).toBe(true);
        expect(await listedNames()).toEqual(["alpha", "beta"]);
      });

      it("needs no approval to push with the flag off to a backup with no list", async () => {
        expect(
          (await pushFromSecondMachine([registryRow("alpha")], { plugins: false })).success
        ).toBe(true);
        expect(await listedNames()).toEqual([]);
      });

      it("still reports a secret after the removal is approved", async () => {
        await pushFromFirstMachine([registryRow("alpha")]);
        const secretRow = registryRow("beta", {
          source: {
            type: "git",
            url: `https://github.com/example/ghp_${"a".repeat(36)}.git`,
            ref: "main",
            refType: "branch",
          },
        });
        const refused = removalOf(await pushFromSecondMachine([secretRow]));

        const next = await pushFromSecondMachine([secretRow], {
          approvedPluginRemovalDigest: refused.approval,
        });

        expect(next.success).toBe(false);
        if (!next.success) expect(next.error.code).toBe("SECRET_DETECTED");
      });
    });

    it("reports the same rows from a preview", async () => {
      await pushFromFirstMachine([registryRow("alpha")]);

      const preview = await serviceFor(await secondMachine()).preview(settings);

      if (!preview.success) throw new Error(preview.error.message);
      expect(preview.data.plugins.rows.map((row) => row.name)).toEqual(["alpha"]);
    });

    describe("with a registry this build cannot read", () => {
      async function corruptSecondMachine(): Promise<string> {
        await pushFromFirstMachine([registryRow("alpha")]);
        const root = await secondMachine();
        await fs.writeFile(path.join(root, "plugins.json"), "{ not json", "utf-8");
        return root;
      }

      it("fails the push with an IO_ERROR that names the file, and leaves the backup as it was", async () => {
        const root = await corruptSecondMachine();

        const pushed = await serviceFor(root).push(settings);

        expect(pushed.success).toBe(false);
        if (pushed.success) return;
        expect(pushed.error.code).toBe("IO_ERROR");
        expect(pushed.error.message).toContain(path.join(root, "plugins.json"));
        expect(pushed.error.message).toContain('Turning off "Agent plugins"');
        const inspect = path.join(tempDir, "inspect-unchanged");
        await runGit(["clone", "--quiet", originPath, inspect]);
        const kept = JSON.parse(
          await fs.readFile(path.join(inspect, "xum", PLUGIN_BACKUP_MANIFEST_PATH), "utf-8")
        ) as { plugins: Array<{ name: string }> };
        expect(kept.plugins.map((plugin) => plugin.name)).toEqual(["alpha"]);
      });

      it("pushes without the list once the flag is off, after the usual removal approval", async () => {
        const root = await corruptSecondMachine();
        const flagOff = { ...settings, includePlugins: false };

        const refused = await serviceFor(root).push(flagOff);
        expect(refused.success).toBe(false);
        if (refused.success) return;
        expect(refused.error.code).toBe("PLUGIN_REMOVAL_APPROVAL_REQUIRED");

        const pushed = await serviceFor(root).push(flagOff, {
          approvedPluginRemovalDigest: refused.error.pluginRemoval?.approval,
        });
        expect(pushed.success).toBe(true);
      });

      it("reports the failure as the push half of a preview, and still shows the restore half", async () => {
        const root = await corruptSecondMachine();

        const preview = await serviceFor(root).preview(settings);

        if (!preview.success) throw new Error(preview.error.message);
        expect(preview.data.pushError).toContain(path.join(root, "plugins.json"));
        expect(preview.data.pushError).toContain('Turning off "Agent plugins"');
        expect(preview.data.plugins.rows.map((row) => [row.name, row.status])).toEqual([
          ["alpha", "missing"],
        ]);
      });
    });

    it("restores the settings when the plugin list is unreadable, and reports the warning", async () => {
      await pushFromFirstMachine([registryRow("alpha")]);
      const clone = path.join(tempDir, "tamper");
      await runGit(["clone", "--quiet", originPath, clone]);
      await fs.writeFile(path.join(clone, "xum", PLUGIN_BACKUP_MANIFEST_PATH), "[]", "utf-8");
      await commitAll(clone, "break the plugin list");
      await runGit(["-C", clone, "push", "--quiet", "origin", "HEAD:refs/heads/main"]);
      const second = await secondMachine();

      const preview = await serviceFor(second).preview(settings);
      const restored = await serviceFor(second).restore(settings);

      if (!preview.success) throw new Error(preview.error.message);
      expect(preview.data.plugins.warnings).toHaveLength(1);
      if (!restored.success) throw new Error(restored.error.message);
      expect(await fs.readFile(path.join(second, "AGENTS.md"), "utf-8")).toBe(
        "from the first machine\n"
      );
      expect(restored.data.plugins.rows).toEqual([]);
      expect(restored.data.plugins.warnings).toHaveLength(1);
      expect(await exists(path.join(second, "plugins.json"))).toBe(false);
    });
  });
});
