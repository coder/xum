"""Download the tree-sitter grammars that the CRAP, DRY and mutation scripts use.

`make tree-sitter-grammars` runs this under scripts/retry.sh. tree-sitter-language-pack
fetches its grammars from a GitHub release on first use, and that release answered 504
for minutes on 2026-11-08.

Exit 0: the grammars are in the pack's cache. Exit 64: the release answered an HTTP 4xx
other than 408 and 429 (a pinned version that has no release, say), which no retry
changes: retry.sh runs this with --fatal-status 64. Exit 1: anything else (a 5xx, a
timeout, a network error).
"""

import re
import sys

from tree_sitter_language_pack import DownloadError, download

FATAL_EXIT = 64


def exit_code_for(err: DownloadError) -> int:
    match = re.search(r"http status: (\d{3})", str(err))
    if match is None:
        return 1
    status = int(match.group(1))
    return FATAL_EXIT if 400 <= status < 500 and status not in (408, 429) else 1


def main() -> int:
    try:
        download(["typescript", "tsx", "javascript"])
    except DownloadError as err:
        print(err, file=sys.stderr)
        return exit_code_for(err)
    return 0


if __name__ == "__main__":
    sys.exit(main())
