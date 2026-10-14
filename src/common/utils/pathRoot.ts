/**
 * One classification of filesystem-root spellings, shared by the project hierarchy
 * (isPathDescendant) and the new-root guards (isFilesystemRoot), #5924.
 *
 * "posix" treats only "/" as a separator. "win32" treats "/" and "\\" as separators and knows
 * drive, UNC and namespaced (\\\\?\\, \\\\.\\) roots. POSIX paths keep their meaning under the
 * win32 rules except for hand-edited spellings such as "//a/b" (a share root) and backslash
 * names.
 *
 * isPathDescendant calls this O(n^2) times per hierarchy pass, so it reads only the root prefix
 * plus one character and allocates nothing.
 */
export type PathRootFlavor = "posix" | "win32";

const SLASH = 47;
const BACKSLASH = 92;
const COLON = 58;
const QUESTION_MARK = 63;
const DOT = 46;

function isSeparator(code: number, flavor: PathRootFlavor): boolean {
  return code === SLASH || (code === BACKSLASH && flavor === "win32");
}

/** Index of the separator that ends the segment starting at `start`, or the length. */
function segmentEnd(p: string, start: number): number {
  let i = start;
  while (i < p.length && !isSeparator(p.charCodeAt(i), "win32")) i++;
  return i;
}

/** End of a UNC root whose server name starts at `start`: server plus share. */
function uncRootEnd(p: string, start: number): number {
  const serverEnd = segmentEnd(p, start);
  return serverEnd >= p.length ? serverEnd : segmentEnd(p, serverEnd + 1);
}

/** True when the segment [start, end) is "UNC", in any case. */
function isUncSegment(p: string, start: number, end: number): boolean {
  return (
    end - start === 3 &&
    (p.charCodeAt(start) | 0x20) === 117 /* u */ &&
    (p.charCodeAt(start + 1) | 0x20) === 110 /* n */ &&
    (p.charCodeAt(start + 2) | 0x20) === 99 /* c */
  );
}

/** Index where the root prefix of `p` ends under the win32 rules, or 0 for a relative path. */
function win32RootEnd(p: string): number {
  if (p.length === 0) return 0;
  const first = p.charCodeAt(0);
  if (isSeparator(first, "win32")) {
    // One leading separator: "/" on POSIX, the root of the current drive on Windows.
    if (p.length === 1 || !isSeparator(p.charCodeAt(1), "win32")) return 1;
    const third = p.charCodeAt(2);
    const isNamespaced =
      (third === QUESTION_MARK || third === DOT) &&
      (p.length === 3 || isSeparator(p.charCodeAt(3), "win32"));
    if (!isNamespaced) return uncRootEnd(p, 2);
    // "\\\\?\\" or "\\\\.\\" plus one device segment ("C:", "Volume{...}", ...), or plus
    // "UNC\\server\\share". path.win32.parse stops at "\\\\?\\UNC\\", which is the bug in #5924.
    if (p.length <= 4) return p.length;
    const deviceEnd = segmentEnd(p, 4);
    if (!isUncSegment(p, 4, deviceEnd) || deviceEnd >= p.length) return deviceEnd;
    return uncRootEnd(p, deviceEnd + 1);
  }
  // A drive letter and a colon. "C:a" is drive-relative, so only "C:" plus separators is a root.
  const isLetter = (first | 0x20) >= 97 /* a */ && (first | 0x20) <= 122; /* z */
  return isLetter && p.length >= 2 && p.charCodeAt(1) === COLON ? 2 : 0;
}

/** True when `p` is only a filesystem root plus optional trailing separators. */
export function isRootPathString(p: string, flavor: PathRootFlavor): boolean {
  const rootEnd = flavor === "win32" ? win32RootEnd(p) : p.charCodeAt(0) === SLASH ? 1 : 0;
  if (rootEnd === 0) return false;
  for (let i = rootEnd; i < p.length; i++) {
    if (!isSeparator(p.charCodeAt(i), flavor)) return false;
  }
  return true;
}
