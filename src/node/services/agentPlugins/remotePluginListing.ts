/**
 * #6426: the host side of a remote plugin listing: its parser, which turns the listing into the
 * nodes of a memory PluginFs. Every rule fails closed: a malformed, cut-off or oversized listing
 * gives null, never a partial tree.
 *
 * Format (tab-separated lines, POSIX paths): `K real lexical` per plugin container, `D  path` per
 * directory, `L target path` per symlink (target: its remote `readlink -f`, empty when that
 * failed), `F  path` per regular file, then `ROOT  <real checkout root>`, `T`, the base64 lines of
 * one tar that holds exactly the F files, `.` and `END`. Each tar header carries the size of its
 * own bytes, so a file that changed during the listing cannot shift another file's content.
 */
import * as path from "node:path";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { isCanonicalRemotePath, isInsideRoot, type MemoryNode } from "./memoryPluginFs";

/** Entries (directories, symlinks, files) per listing; more loads no remote plugins. */
export const MAX_REMOTE_PLUGIN_ENTRIES = 4000;

function tarString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** A tar member name as an absolute path (tar drops the leading `/`). */
function tarPath(name: string): string {
  return "/" + name.replace(/^\/+/, "");
}

interface TarMember {
  type: string;
  name: string;
  link: string;
  data: Buffer;
  /** Offset of the next header. */
  next: number;
}

/** The member at `offset`; "end" at the end-of-archive block, null when malformed or cut. */
function tarMemberAt(tar: Buffer, offset: number): TarMember | "end" | null {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) return "end";
  const sizeField = tarString(header.subarray(124, 136)).trim();
  if (!/^[0-7]+$/.test(sizeField)) return null;
  const size = parseInt(sizeField, 8);
  const start = offset + 512;
  if (start + size > tar.length) return null;
  const prefix =
    tarString(header.subarray(257, 263)) === "ustar" ? tarString(header.subarray(345, 500)) : "";
  const shortName = tarString(header.subarray(0, 100));
  return {
    type: header[156] === 0 ? "0" : String.fromCharCode(header[156]),
    name: prefix === "" ? shortName : `${prefix}/${shortName}`,
    link: tarString(header.subarray(157, 257)),
    data: tar.subarray(start, start + size),
    next: start + Math.ceil(size / 512) * 512,
  };
}

/** GNU long names (`L`) and long link names (`K`) for the next member. */
interface LongNames {
  L?: string;
  K?: string;
}

/** A regular file's bytes, or a hard link's (its target's); undefined for any other type. */
function memberBytes(
  member: TarMember,
  files: Map<string, Buffer>,
  long: LongNames
): Buffer | undefined {
  if (member.type === "0") return member.data;
  return member.type === "1" ? files.get(tarPath(long.K ?? member.link)) : undefined;
}

/**
 * The regular files of a tar (ustar or GNU, as GNU tar and BusyBox write them): absolute path ->
 * a view of the bytes. A hard link reuses its target's bytes, and GNU long names (`L`, `K`) are
 * read. Any other member type, a bad header or a cut-off member gives null (fail closed).
 */
export function parseTarFiles(tar: Buffer): Map<string, Buffer> | null {
  const files = new Map<string, Buffer>();
  let long: LongNames = {};
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const member = tarMemberAt(tar, offset);
    if (member === "end") return files;
    if (member === null) return null;
    offset = member.next;
    if (member.type === "L" || member.type === "K") {
      long[member.type] = tarString(member.data);
      continue;
    }
    const bytes = memberBytes(member, files, long);
    if (bytes === undefined) return null;
    files.set(tarPath(long.L ?? member.name), bytes);
    long = {};
  }
  // No end-of-archive block: the output was cut.
  return null;
}

/** A parsed listing: the real checkout root, its nodes, and the decoded tar size. */
export interface RemotePluginListing {
  root: string;
  nodes: Map<string, MemoryNode>;
  bytes: number;
}

/** Ensures `dir` is a directory node, adding it (and its ancestors) when missing. */
function ensureDir(nodes: Map<string, MemoryNode>, dir: string): boolean {
  if (dir === "/") return true;
  const existing = nodes.get(dir);
  return existing === undefined ? addNode(nodes, dir, { kind: "dir" }) : existing.kind === "dir";
}

/** Same kind and same content: a symlink's target, a file's bytes (both from one tar member). */
function isSameNode(a: MemoryNode, b: MemoryNode): boolean {
  if (a.kind === "symlink" && b.kind === "symlink") return a.target === b.target;
  if (a.kind === "file" && b.kind === "file") return a.bytes === b.bytes;
  return a.kind === b.kind;
}

/** Adds `remote` and its missing ancestor directories; false when a path is listed two ways. */
function addNode(nodes: Map<string, MemoryNode>, remote: string, node: MemoryNode): boolean {
  if (!ensureDir(nodes, path.posix.dirname(remote))) return false;
  const existing = nodes.get(remote);
  // A tree listed twice (two containers that resolve to one directory) repeats its lines. A
  // repeat that differs (a link retargeted between the two walks) refuses the listing.
  if (existing !== undefined && !isSameNode(existing, node)) return false;
  nodes.set(remote, node);
  return true;
}

interface ListingContext {
  nodes: Map<string, MemoryNode>;
  root: string;
  tarFiles: Map<string, Buffer>;
}

type EntryAdder = (context: ListingContext, target: string, remote: string) => boolean;

/** Per line kind: adds the entry; false when its target field is wrong. */
const ENTRY_ADDERS = new Map<string, EntryAdder>([
  [
    "D",
    (context, target, remote) => target === "" && addNode(context.nodes, remote, { kind: "dir" }),
  ],
  [
    "L",
    (context, target, remote) => {
      if (target !== "" && !isCanonicalRemotePath(target)) return false;
      // A link outside the root (or unresolvable) stays in the listing but never resolves.
      const inside = target !== "" && isInsideRoot(context.root, target);
      return addNode(context.nodes, remote, { kind: "symlink", target: inside ? target : null });
    },
  ],
  [
    "F",
    (context, target, remote) => {
      const bytes = context.tarFiles.get(remote);
      if (target !== "" || bytes === undefined || bytes.length > MAX_FILE_SIZE) return false;
      return addNode(context.nodes, remote, { kind: "file", bytes });
    },
  ],
  [
    "K",
    (context, target, remote) => {
      // The container's real directory, and a link at its lexical path when they differ.
      const real = isCanonicalRemotePath(target) && isInsideRoot(context.root, target);
      if (!real || !addNode(context.nodes, target, { kind: "dir" })) return false;
      return remote === target || addNode(context.nodes, remote, { kind: "symlink", target });
    },
  ],
]);

/** One entry line into the context's nodes; false when it is malformed or outside the root. */
function addEntryLine(context: ListingContext, line: string): boolean {
  const fields = line.split("\t");
  const [kind, target, remote] = fields;
  const add = ENTRY_ADDERS.get(kind);
  if (add === undefined || fields.length !== 3 || !isCanonicalRemotePath(remote)) return false;
  return isInsideRoot(context.root, remote) && add(context, target, remote);
}

const FRAME_END = "\n.\nEND\n";
const ROOT_PREFIX = "ROOT\t\t";

/** The listing's entry lines, root and base64 lines; null when its frame is wrong or cut. */
function splitListing(
  stdout: string
): { entryLines: string[]; root: string; base64Lines: string[] } | null {
  if (!stdout.endsWith(FRAME_END)) return null;
  const lines = stdout.slice(0, -FRAME_END.length).split("\n");
  const tarLine = lines.indexOf("T");
  const rootLine = tarLine < 1 ? "" : lines[tarLine - 1];
  const root = rootLine.slice(ROOT_PREFIX.length);
  if (!rootLine.startsWith(ROOT_PREFIX) || !isCanonicalRemotePath(root)) return null;
  return { entryLines: lines.slice(0, tarLine - 1), root, base64Lines: lines.slice(tarLine + 1) };
}

/** The tar and its files, decoded once; null when the base64 or the tar is malformed. */
function decodeTar(base64Lines: string[]): { tar: Buffer; files: Map<string, Buffer> } | null {
  if (!base64Lines.every((line) => /^[A-Za-z0-9+/=]*$/.test(line))) return null;
  const tar = Buffer.from(base64Lines.join(""), "base64");
  const files = tar.length === 0 ? new Map<string, Buffer>() : parseTarFiles(tar);
  return files === null ? null : { tar, files };
}

/**
 * Parses the listing; null when it is cut off, too big, malformed, or its tar does not hold
 * exactly the listed files (fail closed). The base64 is decoded once and then dropped.
 */
export function parseRemotePluginListing(stdout: string): RemotePluginListing | null {
  const parts = splitListing(stdout);
  if (parts === null) return null;
  const decoded = decodeTar(parts.base64Lines);
  // The script counts every D, L and F line against the same cap (K lines name the containers).
  const counted = parts.entryLines.filter((line) => !line.startsWith("K\t")).length;
  if (decoded === null || counted > MAX_REMOTE_PLUGIN_ENTRIES) return null;
  const context: ListingContext = { nodes: new Map(), root: parts.root, tarFiles: decoded.files };
  if (!parts.entryLines.every((line) => addEntryLine(context, line))) return null;
  // Each F line found its member; an extra member means the tar read something not listed.
  const listedFiles = [...context.nodes.values()].filter((node) => node.kind === "file").length;
  return listedFiles === decoded.files.size
    ? { root: parts.root, nodes: context.nodes, bytes: decoded.tar.length }
    : null;
}
