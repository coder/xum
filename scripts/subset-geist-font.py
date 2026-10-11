"""Regenerates src/browser/styles/fonts/Geist-Latin-Variable.woff2, the Latin subset of Geist
Variable that the first page loads instead of the full font (#5971). Prints the unicode-range
lines for both @font-face rules in src/browser/styles/globals.css.

Run from the repo root with pinned tools (no build dependency):
  uvx --from 'fonttools[woff]==4.60.1' --with brotli==1.1.0 python scripts/subset-geist-font.py

The output is deterministic for the same geist package and tool versions; compare its sha256 with
the one this script prints and the one recorded in globals.css.
"""

import hashlib
import json
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2"
OUTPUT = ROOT / "src/browser/styles/fonts/Geist-Latin-Variable.woff2"
EXPECTED_GEIST_VERSION = "1.5.1"

# The Latin script: Basic Latin through Latin Extended-B, IPA and spacing modifiers, combining
# marks, Latin Extended Additional, general punctuation, super/subscripts and currency, letterlike
# symbols, the arrows U+2190-2199 that tool output uses, two math signs and the Latin ligatures.
# Whole words in Latin-script languages (Polish, Czech, Turkish) stay in one font, so kerning
# between their letters is unchanged.
LATIN_RANGES = [
    (0x0000, 0x036F),
    (0x1E00, 0x1EFF),
    (0x2000, 0x214F),
    (0x2190, 0x2199),
    (0x2212, 0x2212),
    (0x2215, 0x2215),
    (0x2C60, 0x2C7F),
    (0xA720, 0xA7FF),
    (0xFB00, 0xFB06),
    (0xFEFF, 0xFEFF),
    (0xFFFD, 0xFFFD),
]


def css_ranges(codepoints):
    """Compresses sorted code points into a CSS unicode-range value."""
    parts, points = [], sorted(codepoints)
    start = prev = points[0]
    for cp in points[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        parts.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
        if cp is not None:
            start = prev = cp
    return ", ".join(parts)


def main():
    version = json.loads((ROOT / "node_modules/geist/package.json").read_text())[
        "version"
    ]
    assert version == EXPECTED_GEIST_VERSION, (
        f"geist {version}, expected {EXPECTED_GEIST_VERSION}"
    )
    full_cmap = set(TTFont(SOURCE).getBestCmap())
    in_latin = lambda cp: any(lo <= cp <= hi for lo, hi in LATIN_RANGES)
    latin = sorted(cp for cp in full_cmap if in_latin(cp))

    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = [
        "*"
    ]  # keeps tnum, kern, liga and every other feature unchanged
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    font = subset.load_font(str(SOURCE), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=latin)
    subsetter.subset(font)
    subset.save_font(font, str(OUTPUT), options)

    # The subset must keep every Latin glyph of the full font, so no character falls back.
    kept = set(TTFont(OUTPUT).getBestCmap())
    assert kept == set(latin), f"missing {sorted(set(latin) - kept)[:10]}"
    rest = sorted(full_cmap - set(latin))
    print(f"subset: {OUTPUT.relative_to(ROOT)} {OUTPUT.stat().st_size} bytes")
    print(f"sha256: {hashlib.sha256(OUTPUT.read_bytes()).hexdigest()}")
    print(
        f"subset unicode-range: {css_ranges([cp for lo, hi in LATIN_RANGES for cp in range(lo, hi + 1)])}"
    )
    print(f"full-font unicode-range: {css_ranges(rest)}")


if __name__ == "__main__":
    sys.exit(main())
