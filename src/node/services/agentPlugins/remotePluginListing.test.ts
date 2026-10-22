import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryPluginFs } from "./memoryPluginFs";
import { discoverAgentPluginsIn } from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import {
  MAX_LISTING_OUTPUT_BYTES,
  MAX_REMOTE_PLUGIN_ENTRIES,
  parseRemotePluginListing,
  parseTarFiles,
} from "./remotePluginListing";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-listing-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Writes files under `root` and returns their absolute paths. */
async function writeFiles(files: Record<string, string>): Promise<string[]> {
  const written: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    written.push(file);
  }
  return written;
}

/** A real (GNU) tar of `files`; `format` "pax" writes pax headers as bsdtar does. */
function tarOf(files: string[], format = "gnu"): Buffer {
  return Bun.spawnSync(["tar", `--format=${format}`, "-cf", "-", "-T", "-"], {
    stdin: Buffer.from(files.join("\n") + "\n"),
    stderr: "ignore",
  }).stdout;
}

/** A listing like the remote script prints, with a real (GNU) tar of `tarred` files. */
function listing(lines: string[], tarred: string[]): string {
  const tar = tarred.length === 0 ? "" : tarOf(tarred).toString("base64");
  const base64 = tar.match(/.{1,76}/g) ?? [];
  return [...lines, `ROOT\t\t${root}`, "T", ...base64, ".", "END", ""].join("\n");
}

const manifest = JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "kit" });

describe("parseRemotePluginListing", () => {
  test("a listing becomes a memory fs that discovery reads", async () => {
    const container = path.join(root, ".xum", "plugins");
    // A name over 100 bytes uses a GNU long-name header, and a hard link reuses its bytes.
    const longName = "x".repeat(120) + ".md";
    const files = await writeFiles({
      ".xum/plugins/kit/plugin.json": manifest,
      ".xum/plugins/kit/skills/review/SKILL.md": "---\nname: review\ndescription: d\n---\n",
      [`.xum/plugins/kit/skills/review/${longName}`]: "long",
    });
    const hardLink = path.join(container, "kit", "skills", "review", "copy.md");
    await fs.link(files[2], hardLink);
    const lines = [
      `K\t${container}\t${container}`,
      ...["kit", "kit/skills", "kit/skills/review"].map(
        (dir) => `D\t\t${path.join(container, dir)}`
      ),
      ...[...files, hardLink].map((file) => `F\t\t${file}`),
    ];
    const parsed = parseRemotePluginListing(listing(lines, [...files, hardLink]));
    if (parsed === null) throw new Error("listing refused");
    const memoryFs = createMemoryPluginFs(parsed.nodes, parsed.root, new Date(0));
    const { plugins } = await discoverAgentPluginsIn(memoryFs, [
      { path: container, scope: "project" },
    ]);
    expect(plugins.map((plugin) => plugin.rootPath)).toEqual([path.join(container, "kit")]);
    const read = (filePath: string) =>
      memoryFs.readFileCapped({
        filePath,
        pluginRoot: path.join(container, "kit"),
        maxBytes: 99,
        label: "f",
      });
    expect((await read(files[2])).content).toBe("long");
    expect((await read(hardLink)).content).toBe("long");
  });

  test("a tar that does not hold exactly the listed files refuses the listing", async () => {
    const [a, b] = await writeFiles({ "p/a.md": "a", "p/b.md": "b" });
    const both = [`F\t\t${a}`, `F\t\t${b}`];
    expect(parseRemotePluginListing(listing(both, [a, b]))).not.toBeNull();
    // A file that vanished before tar ran, and a member that was never listed.
    expect(parseRemotePluginListing(listing(both, [a]))).toBeNull();
    expect(parseRemotePluginListing(listing([`F\t\t${a}`], [a, b]))).toBeNull();
    // One path archived twice (two walks of one tree): the same bytes are fine, changed ones are
    // refused. Each member of a small file is one header block plus one data block.
    const once = tarOf([a]);
    expect(parseTarFiles(Buffer.concat([once.subarray(0, 1024), once]))?.size).toBe(1);
    await fs.writeFile(a, "changed");
    expect(parseTarFiles(Buffer.concat([once.subarray(0, 1024), tarOf([a])]))).toBeNull();
    // A directory member (a listed file replaced by a directory) is not a regular file.
    expect(parseRemotePluginListing(listing([`F\t\t${a}`], [path.join(root, "p")]))).toBeNull();
  });

  test("pax headers name the next member; a malformed, oversized or escaping one refuses", async () => {
    const [a] = await writeFiles({ "p/a.md": "a" });
    // pax extended headers (bsdtar's default format) carry a long name and other records.
    const long = path.join(root, "p", "y".repeat(150) + ".md");
    await fs.writeFile(long, "pax");
    expect(
      parseTarFiles(tarOf([long], "pax"))
        ?.get(long)
        ?.toString()
    ).toBe("pax");
    // A hand-made pax header before a real member: a malformed or oversized header, or a pax
    // path that is not canonical, refuses the archive.
    const member = tarOf([a]).subarray(0, 1024);
    const withPax = (records: string) => {
      const data = Buffer.from(records);
      const header = Buffer.alloc(512);
      header.write("PaxHeader");
      header.write(data.length.toString(8).padStart(11, "0"), 124);
      header.write("x", 156);
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      return parseTarFiles(Buffer.concat([header, padded, member, Buffer.alloc(1024)]));
    };
    // `<len> <key>=<value>\n`, where len counts its own digits too.
    const record = (value: string) => {
      const rest = value.length + 2;
      const total = rest + String(rest + String(rest).length).length;
      return `${total} ${value}\n`;
    };
    expect(withPax(record(`path=${a}`))?.has(a)).toBe(true);
    expect(withPax(record(`path=${root}/p/../../etc/x`))).toBeNull();
    expect(withPax("99 comment=x\n")).toBeNull();
    expect(withPax(record(`comment=${"c".repeat(70_000)}`))).toBeNull();
  });

  test("malformed, outside-the-root, oversized or cut-off listings are refused", () => {
    const ok = [`D\t\t${root}/p`, `L\t${root}/a\t${root}/l`, `L\t${root}/a\t${root}/l`];
    expect(parseRemotePluginListing(listing(ok, []))).not.toBeNull();
    // Paths count toward the cache's byte cap even without any file.
    const dirs = Array.from({ length: 100 }, (_, i) => `D\t\t${root}/${"x".repeat(1000)}${i}`);
    expect(parseRemotePluginListing(listing(dirs, []))?.bytes).toBeGreaterThan(200_000);
    // One deep path implies ~2000 ancestors whose keys add up to millions of chars.
    const deep = `D\t\t${root}/${"a/".repeat(2000)}b`;
    expect(parseRemotePluginListing(listing([deep], []))?.bytes).toBeGreaterThan(4_000_000);
    for (const bad of [
      [`D\t\t${root}/p/../../etc`],
      [`D\t\t/etc`],
      [`K\t/etc\t${root}/p`],
      [`D\t\t${root}/p`, `L\t\t${root}/p`],
      [`X\t\t${root}/p`],
      // One link listed twice with two targets (retargeted between two walks).
      [`L\t${root}/a\t${root}/p`, `L\t${root}/b\t${root}/p`],
      Array.from({ length: MAX_REMOTE_PLUGIN_ENTRIES + 1 }, (_, i) => `D\t\t${root}/d${i}`),
      // A path over PATH_MAX, and deep paths that imply more nodes than any real listing.
      [`D\t\t${root}/${"a/".repeat(2100)}b`],
      Array.from({ length: 3 }, (_, i) => `D\t\t${root}/${i}${"/a".repeat(1600)}`),
    ]) {
      expect(parseRemotePluginListing(listing(bad, []))).toBeNull();
    }
    expect(parseRemotePluginListing(listing(ok, []).replace("END\n", ""))).toBeNull();
    // An input over the exec's output cap is refused before it is split or decoded.
    const huge = listing(ok, []).replace("T\n", `T\n${"A".repeat(MAX_LISTING_OUTPUT_BYTES)}\n`);
    expect(parseRemotePluginListing(huge)).toBeNull();
  });
});
