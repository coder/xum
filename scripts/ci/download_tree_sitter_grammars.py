"""Download the tree-sitter grammars that the CRAP, DRY and mutation scripts use.

`make tree-sitter-grammars` runs this under scripts/retry.sh. tree-sitter-language-pack
fetches its grammars from a GitHub release on first use, and that release answered 504
for minutes on 2026-11-08.

The pack loads its grammars as native libraries, so bytes in its cache directory run as
code. CI cannot trust a restored cache (a crafted entry can put any file in the pack's
directory), so every run, on a cache hit or miss, does this:

1. Wipe the pack's version directory ("pack root"), which holds whatever any cache or
   earlier run left there.
2. Copy the pinned manifest and bundle from the stage directory (the directory CI caches)
   into the pack root, and keep them only if both match the sha256 pins below.
3. Run the pack's download. With a verified manifest and bundle in place it extracts the
   grammars from them with no network. Without them it downloads both.
4. Check the manifest and bundle in the pack root against the pins again. A mismatch is
   fatal: the release changed, or the pins are wrong, and no retry fixes that.
5. If the stage held no verified files, rebuild it from the pack root, so the cache save
   stores exactly the two verified files and nothing else.

To bump tree-sitter-language-pack: change the version in pyproject.toml, then set RELEASE
and PINS below from the release's parsers.json (the pack's manifest) and its bundles.
Never copy the digests from the release page alone: download each file, run `sha256sum`,
and check the result equals the digest GitHub computed at upload (`gh api
repos/xberg-io/tree-sitter-language-pack/releases/tags/<tag> --jq '.assets[] | .name +
" " + .digest'`). downloadTreeSitterGrammars.test.ts fails while RELEASE and
pyproject.toml disagree.

Exit 0: the grammars are in the pack's cache. Exit 64: no retry changes the result: the
release answered an HTTP 4xx other than 408 and 429 (a pinned version that has no
release, say), or the downloaded files do not match the pins. retry.sh runs this with
--fatal-status 64. Exit 2: this platform has no pin (add one). Exit 1: anything else (a
5xx, a timeout, a network error).
"""

import hashlib
import os
import platform
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from tree_sitter_language_pack import DownloadError, cache_dir, download

FATAL_EXIT = 64
UNSUPPORTED_EXIT = 2
LANGUAGES = ["typescript", "tsx", "javascript"]


@dataclass(frozen=True)
class Pins:
    release: str
    manifest_sha256: str  # sha256 of the release's parsers.json
    bundle_sha256: dict[str, str]  # sha256 of parsers-<platform>.tar.zst by platform key


RELEASE = "v1.21.3"
PINS = Pins(
    release=RELEASE,
    manifest_sha256="4f5f796a7098c4681d22c38158a6a91837d0fb35262a6d87aaea7a37e0a7eced",
    bundle_sha256={
        "linux-aarch64": "bfe605a02356618e28a7ad3f13f23bb1535b4ab249ecf70f58039ca61a6980be",
        "linux-x86_64": "da13a1303fe73f242aadeb87f591201b44770abf2bc725c0ae37d50b687033c7",
        "macos-arm64": "459df28c20c7cfcb6fd99dcba6f10ff6b2fe9109aa95e5ff44cd8c68812f8b22",
        "macos-x86_64": "de6e9a94c9aa899a18a29513969a3913c98c293b22fdbf677a692d606541ff92",
        "windows-aarch64": "feab205084b2de022e91b07eaecadd576b0756357aafc09406f4eee9929a0c5a",
        "windows-x86_64": "9c9657c0d5f8b9eb62a3c7bc58a944782f824967a206ff5390ed1ad4e528b3df",
    },
)

# The directory that CI caches (.github/workflows/pr.yml, "Restore tree-sitter grammars").
# It holds manifest.json and bundles/<bundle name> and nothing else.
DEFAULT_STAGE_DIR = "~/.cache/xum-tree-sitter-grammars"
MANIFEST_NAME = "manifest.json"
BUNDLES_DIR = "bundles"


def exit_code_for(err: DownloadError) -> int:
    match = re.search(r"http status: (\d{3})", str(err))
    if match is None:
        return 1
    status = int(match.group(1))
    return FATAL_EXIT if 400 <= status < 500 and status not in (408, 429) else 1


def platform_key() -> str | None:
    """The pack's platform key for this host (the keys of parsers.json), or None."""
    system = {"Linux": "linux", "Darwin": "macos", "Windows": "windows"}.get(platform.system())
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        arch = "x86_64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64" if system == "macos" else "aarch64"
    else:
        arch = None
    return f"{system}-{arch}" if system and arch else None


def sha256_of(path: Path) -> str | None:
    """The sha256 of a file, or None when `path` is not a file."""
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_name(pins: Pins, platform_name: str) -> str:
    # The file name the pack gives its cached bundle: <platform>-<sha256>.tar.zst.
    return f"{platform_name}-{pins.bundle_sha256[platform_name]}.tar.zst"


def pinned_files(pins: Pins, platform_name: str, root: Path) -> list[tuple[Path, str]]:
    return [
        (root / MANIFEST_NAME, pins.manifest_sha256),
        (root / BUNDLES_DIR / bundle_name(pins, platform_name), pins.bundle_sha256[platform_name]),
    ]


def is_verified(pins: Pins, platform_name: str, root: Path) -> bool:
    return all(sha256_of(path) == sha for path, sha in pinned_files(pins, platform_name, root))


def copy_pinned_files(pins: Pins, platform_name: str, source: Path, target: Path) -> None:
    """Copy whichever pinned files of `source` exist into `target`. The caller checks them."""
    for src, _ in pinned_files(pins, platform_name, source):
        if not src.is_file():
            continue
        dst = target / src.relative_to(source)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)


def reset_dir(path: Path) -> None:
    """Leave `path` an empty directory. A cache entry can plant a symlink or a plain file there."""
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True)


def pack_root() -> Path:
    """The pack's version directory: the parent of its `libs` directory. It is wiped on every
    run, so refuse any layout that is not the one this script was written for."""
    root = Path(cache_dir()).parent
    if root.parent.name != "tree-sitter-language-pack" or not root.name.startswith("v"):
        raise RuntimeError(f"unexpected tree-sitter-language-pack cache directory: {root}")
    return root


def run(pins: Pins, platform_name: str, stage: Path) -> int:
    root = pack_root()
    reset_dir(root)
    copy_pinned_files(pins, platform_name, stage, root)
    staged = is_verified(pins, platform_name, root)
    if not staged:
        if stage.exists():
            print(
                f"::warning::{stage} does not hold the pinned tree-sitter grammars; downloading them",
                file=sys.stderr,
            )
        reset_dir(root)
    try:
        download(LANGUAGES)
    except DownloadError as err:
        print(err, file=sys.stderr)
        return exit_code_for(err)
    if not is_verified(pins, platform_name, root):
        print(
            f"::error::the tree-sitter-language-pack {pins.release} manifest or bundle for {platform_name} "
            "does not match the pinned sha256 (see scripts/ci/download_tree_sitter_grammars.py)",
            file=sys.stderr,
        )
        return FATAL_EXIT
    if not staged:
        reset_dir(stage)
        copy_pinned_files(pins, platform_name, root, stage)
    return 0


def main() -> int:
    platform_name = platform_key()
    if platform_name is None or platform_name not in PINS.bundle_sha256:
        print(
            f"::error::no pinned tree-sitter grammars for {platform.system()} {platform.machine()}; "
            "add its bundle sha256 to scripts/ci/download_tree_sitter_grammars.py",
            file=sys.stderr,
        )
        return UNSUPPORTED_EXIT
    stage = Path(os.environ.get("GRAMMAR_STAGE_DIR") or DEFAULT_STAGE_DIR).expanduser()
    return run(PINS, platform_name, stage)


if __name__ == "__main__":
    sys.exit(main())
