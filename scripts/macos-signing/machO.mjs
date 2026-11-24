// Finds the Mach-O files of a macOS app bundle and tells executables from libraries.
//
// The signing job runs on Linux, where Apple's tools do not exist, and it must give every
// Mach-O its own signing settings (see sign-app.mjs), so the scan reads the file headers itself.
// It has no dependency: the signing job must not install the repository's packages.
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

const MH_EXECUTE = 2;
// The four magic numbers of a single-architecture Mach-O, read as a big-endian integer, and
// whether the rest of the header is little-endian.
const THIN_LITTLE_ENDIAN = new Map([
  [0xfeedface, false],
  [0xfeedfacf, false],
  [0xcefaedfe, true],
  [0xcffaedfe, true],
]);
// A universal file: the magic number and the byte size of one architecture entry.
const FAT_ARCH_SIZE = new Map([
  [0xcafebabe, 20],
  [0xcafebabf, 32],
]);
// A Java class file starts with the universal magic number too. Its next field is a version
// (45 or more), where a universal file has its architecture count.
const MAX_FAT_ARCHES = 20;

function fileTypeAt(fd, offset) {
  const header = Buffer.alloc(16);
  if (readSync(fd, header, 0, 16, offset) < 16) return null;
  const littleEndian = THIN_LITTLE_ENDIAN.get(header.readUInt32BE(0));
  if (littleEndian === undefined) return null;
  return littleEndian ? header.readUInt32LE(12) : header.readUInt32BE(12);
}

// The Mach-O file type of the file (of its first architecture when it is universal), or null
// when the file is not a Mach-O.
function machOFileType(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(8);
    if (readSync(fd, head, 0, 8, 0) < 8) return null;
    const archSize = FAT_ARCH_SIZE.get(head.readUInt32BE(0));
    if (archSize === undefined) return fileTypeAt(fd, 0);
    const arches = head.readUInt32BE(4);
    if (arches === 0 || arches > MAX_FAT_ARCHES) return null;
    const arch = Buffer.alloc(archSize);
    if (readSync(fd, arch, 0, archSize, 8) < archSize) return null;
    const offset = archSize === 32 ? Number(arch.readBigUInt64BE(8)) : arch.readUInt32BE(8);
    return fileTypeAt(fd, offset);
  } finally {
    closeSync(fd);
  }
}

// Every Mach-O under `root`, as `{ path, executable }` with `path` relative to `root`, in a
// stable order. Symbolic links are skipped: a framework reaches each of its files a second time
// through `Versions/Current`, and a signature belongs to the file, not to a link.
export function listMachO(root) {
  const found = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const fileType = machOFileType(full);
        if (fileType !== null) {
          found.push({
            path: path.relative(root, full).split(path.sep).join("/"),
            executable: fileType === MH_EXECUTE,
          });
        }
      }
    }
  };
  walk(root);
  return found;
}
