#!/usr/bin/env python3
"""
omnibus_rename.py — Normalize a comic library to Omnibus naming conventions.

────────────────────────────────────────────────────────────────────────────────
NAMING STANDARDS (from Omnibus app source)
  Series folder : Series Name (StartYear)
                  e.g. "Ultimate Spider-Man (2000)"
  Regular file  : Series Name NNN (YYYY).cbr/cbz
                  e.g. "Ultimate Spider-Man 011 (2001).cbr"
  Annual file   : Series Name YYYY Annual NNN.cbr/cbz
                  e.g. "Ultimate Spider-Man 2005 Annual 001.cbz"

────────────────────────────────────────────────────────────────────────────────
WHAT THIS SCRIPT DOES (in order, per series folder)

  1. FLATTEN — CBZ/CBR files nested inside any subdirectory (e.g.
               "Annuals\", "Extras\", "Death of Spider-Man\...") are
               moved up to the series root.  Empty subdirs are removed.

  2. RENAME FILES — Trailing noise groups — (Digital), (Zone-Empire),
               (Minutemen-PhD), (Cover ONLY), (2nd Print Variant), etc. —
               are stripped from every comic filename.
               Annual filenames are reordered:
                 "Series Annual 01 (2005) ..." → "Series 2005 Annual 001"
               Regular issue numbers are zero-padded to 3 digits:
                 "Series 01 (of 06) (2009) ..." → "Series 001 (2009)"

  3. MERGE SPLIT VOLUMES — When several source folders map to the same
               target name (e.g. six "Ultimate Spider-Man v1 (NNN-NNN)
               (2000-2008)" folders → "Ultimate Spider-Man (2000)"), their
               comics are consolidated into one target directory.

  4. RENAME FOLDERS — Each series folder is normalised to "Series (Year)".
               Version markers (v1, v2, v3) and issue-range / noise groups
               are stripped.

────────────────────────────────────────────────────────────────────────────────
USAGE
  # Show everything that would happen — no changes made (default)
  python omnibus_rename.py [BASE_DIR]

  # Apply all changes
  python omnibus_rename.py [BASE_DIR] --execute

  # Override the series name / year for specific folders
  python omnibus_rename.py [BASE_DIR] --map-file overrides.json [--execute]

  Default BASE_DIR: Z:\\Comics\\Marvel Comics\\Ultimate Comics

  overrides.json format:
    {
      "Ultimate Avengers 1 (001-006) (2009-2010) (digital) (Zone-Empire)":
          {"name": "Ultimate Avengers", "year": "2009"},
      ...
    }
────────────────────────────────────────────────────────────────────────────────
"""

import argparse
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

# ── Constants ─────────────────────────────────────────────────────────────────

COMIC_EXTS = {".cbz", ".cbr"}

BASE_DEFAULT = r"Z:\Comics\Marvel Comics\Ultimate Comics"

# Top-level folders that are NOT series directories (skip entirely)
SKIP_FOLDERS: set[str] = {
    "Ultimate Marvel Universe (Collection) (2000-2015)",
}

# ── Folder-name parsing ───────────────────────────────────────────────────────

# Regex that matches the *start* of the noisy suffix we want to strip from
# a series folder name.  Anchored after the real series title.
_FOLDER_NOISE_START = re.compile(
    r"""
    (?:
        \s+v\d+\b           # version marker: " v1", " v2", " v3"
      | \s*\(               # any opening paren — issue ranges, years, tags follow
    )
    """,
    re.VERBOSE,
)

# Patterns that begin the "noisy" portion of a folder name.
# We split the name at the FIRST such match.
_ISSUE_RANGE_PAREN = re.compile(
    r"""
    \s*\(
    (?:
        \d{1,4}             # starts with a digit — issue range or year
      | [Dd]igital
      | [Ss]can
    )
    """,
    re.VERBOSE,
)

_YEAR_RANGE = re.compile(r"\((\d{4})-\d{4}\)")
_SINGLE_YEAR = re.compile(r"\((\d{4})\)")


def parse_series_folder(raw_name: str) -> tuple[str, str | None]:
    """
    Return (clean_series_name, start_year) from a raw folder name.

    Examples
    --------
    "Ultimate Spider-Man v1 (001 - 025) (2000-2008)"
        → ("Ultimate Spider-Man", "2000")
    "Ultimate Fantastic Four (001-060+Annuals)(2004-2009)(digital)(Minutemen-PhD)"
        → ("Ultimate Fantastic Four", "2004")
    "Ultimate Hawkeye (001-004)(2011-2012)(digital)(Minutemen-PhD)"
        → ("Ultimate Hawkeye", "2011")
    "Ultimate Avengers 1 (001-006) (2009-2010) (digital) (Zone-Empire)"
        → ("Ultimate Avengers 1", "2009")   # keeps trailing digit
    "The Ultimates 2 (001-013)(2005-2007)(digital)(Minutemen-PhD)"
        → ("The Ultimates 2", "2005")        # keeps trailing digit (series name)
    "Ultimatum Spider-Man Requiem (001-002)(2009)(digital)(Zone-Empire)"
        → ("Ultimatum Spider-Man Requiem", "2009")
    """
    name = raw_name

    # 1. Extract the start year BEFORE we strip anything.
    yr = _YEAR_RANGE.search(name)
    if yr:
        start_year: str | None = yr.group(1)
    else:
        sy = _SINGLE_YEAR.search(name)
        start_year = sy.group(1) if sy else None

    # 2. Strip " v1 / v2 / v3" version markers (must come before the paren search
    #    so "v1 (001-025)" doesn't get confused with a bare digit).
    name = re.sub(r"\s+v\d+\b", "", name)

    # 3. Find where the noise begins: first paren that opens an issue range or
    #    year group, OR a bare digit immediately before such a paren.
    m = _ISSUE_RANGE_PAREN.search(name)
    if m:
        # Also check if there's a bare digit immediately before this paren
        # that is NOT part of the series title (e.g. " 1 (" → volume marker).
        # We identify this by: the character before the paren-group is a digit
        # that was preceded by a space.
        prefix = name[: m.start()].rstrip()
        # Check whether a trailing bare digit is a volume number vs part of name.
        # Heuristic: if the digit is preceded by a lowercase letter word (like
        # "Avengers 1") it's likely a volume number; if it's a named number
        # like "Ultimates 2" the "2" is part of the title.
        # We KEEP the digit (conservative) — the user can override via --map-file.
        clean = prefix
    else:
        # No issue-range paren found — strip all parens
        clean = re.sub(r"\s*\([^)]*\)", "", name).strip()

    return clean.strip(), start_year


# ── File-name parsing ─────────────────────────────────────────────────────────

# Parenthetical groups that are definitely noise (never part of canonical name).
# We strip these iteratively from the END of the stem, stopping before a year.
_NOISE_GROUP = re.compile(
    r"""
    \s*\(
    (?:
        digital | scan | hd | fixed | novus | empire | minutemen | zone
      | son\s+of\s+ultron | competent | wizard | sdcc | c2e2 | c2c
      | cover\s+only | 2nd\s+print | printing\s+variant | variant
      | after\s+\d+               # e.g. "(after 39)"
      | [a-z0-9 &._-]+-[a-z0-9 &._-]+   # "Zone-Empire", "Minutemen-PhD" etc.
    )
    [^)]*\)
    """,
    re.IGNORECASE | re.VERBOSE,
)

_YEAR_PAREN = re.compile(r"\((\d{4})\)")

# Already-canonical annual: "Series YYYY Annual NNN"  (no trailing year in parens)
_CANONICAL_ANNUAL = re.compile(
    r"^.+\s\d{4}\s+Annual\s+\d{3,}$",
    re.IGNORECASE,
)

# Annual in a filename: "Series Annual NNN (YYYY) ..."
# Covers:  "Annual 01 (2005)", "Annual 002 (2006)", "Annual 1 (of 2) (2008)"
_ANNUAL_IN_FILE = re.compile(
    r"""
    ^(?P<series>.+?)\s+
    Annual\s+
    (?P<num>\d+)\s*(?:\(of\s*\d+\)\s*)?
    \((?P<year>\d{4})\)
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Regular issue: "Series NNN (YYYY) ..." or "Series N.frac (YYYY) ..."
# Optionally preceded by "(of N)" mini-group.
_REGULAR_ISSUE = re.compile(
    r"""
    ^(?P<series>.+?)\s+
    (?P<num>\d+(?:\.\d+)?)\s*(?:\(of\s*\d+\)\s*)?
    \((?P<year>\d{4})\)
    """,
    re.IGNORECASE | re.VERBOSE,
)


def zero_pad(raw_num: str, width: int = 3) -> str:
    """Zero-pad the integer part of an issue number to *width* digits."""
    if "." in raw_num:
        int_part, frac = raw_num.split(".", 1)
        return str(int(int_part)).zfill(width) + "." + frac
    return str(int(raw_num)).zfill(width)


def strip_trailing_noise(stem: str) -> str:
    """
    Remove trailing noise groups, stopping once the stem ends with (YYYY).

    Runs iteratively because a single pass might leave orphaned noise if
    two noise groups are stacked at the end.
    """
    changed = True
    while changed:
        changed = False
        # If stem already ends with (YYYY), stop — nothing more to strip.
        if _YEAR_PAREN.search(stem) and re.search(r"\(\d{4}\)\s*$", stem):
            break
        new = _NOISE_GROUP.sub("", stem).rstrip()
        if new != stem:
            stem = new
            changed = True
    return stem.strip()


def canonical_filename(original_stem: str, ext: str) -> tuple[str | None, str]:
    """
    Return (canonical_filename_with_ext, note).

    *note* is an empty string on success, or a human-readable reason why the
    file could not be parsed automatically (caller should flag for review).

    Annual format  : "Series YYYY Annual NNN.ext"
    Regular format : "Series NNN (YYYY).ext"
    """
    ext = ext.lower()

    # Normalize underscore-delimited filenames (e.g. "Series_097_(2006)_...cbr")
    # to space-delimited before any parsing.
    original_stem = original_stem.replace("_", " ")

    # ── Annual ────────────────────────────────────────────────────────
    if re.search(r"\bannual\b", original_stem, re.IGNORECASE):
        # Already canonical: "Series YYYY Annual NNN" — nothing to do
        if _CANONICAL_ANNUAL.match(original_stem):
            return f"{original_stem}{ext}", ""
        m = _ANNUAL_IN_FILE.match(original_stem)
        if m:
            series = m.group("series").strip()
            num    = zero_pad(m.group("num"))
            year   = m.group("year")
            return f"{series} {year} Annual {num}{ext}", ""
        return None, "annual filename did not match expected pattern"

    # ── Regular issue ─────────────────────────────────────────────────
    m = _REGULAR_ISSUE.match(original_stem)
    if m:
        series = m.group("series").strip()
        num    = zero_pad(m.group("num"))
        year   = m.group("year")
        return f"{series} {num} ({year}){ext}", ""

    # ── Special / extra (has year but no issue number) ────────────────
    # e.g. "Ultimate Spider-Man - Character Guide (2014) (digital) ..."
    if _YEAR_PAREN.search(original_stem):
        cleaned = strip_trailing_noise(original_stem)
        if re.search(r"\(\d{4}\)\s*$", cleaned):
            return f"{cleaned}{ext}", "special/extra — no issue number; kept as-is after noise strip"

    return None, "could not parse filename — no year found"


# ── Operation log ─────────────────────────────────────────────────────────────

class Op:
    """A single planned filesystem operation."""
    __slots__ = ("kind", "src", "dst", "note")

    def __init__(self, kind: str, src: Path, dst: Path, note: str = ""):
        self.kind = kind
        self.src  = src
        self.dst  = dst
        self.note = note

    def describe(self, base: Path) -> str:
        def shorten(p: Path) -> str:
            try:
                rel = p.relative_to(base)
                return str(rel)
            except ValueError:
                return str(p)

        if self.kind == "flatten":
            return f"  [FLATTEN ] {shorten(self.src)}\n           → {shorten(self.dst)}"
        elif self.kind == "rename_file":
            return f"  [RENAME  ] {self.src.name}\n           → {self.dst.name}" + (
                f"\n             ⚠  {self.note}" if self.note else ""
            )
        elif self.kind == "rmdir":
            return f"  [RMDIR   ] {shorten(self.src)}"
        elif self.kind == "rename_dir":
            return f"  [FOLDER  ] {shorten(self.src)}\n           → {shorten(self.dst)}"
        elif self.kind == "merge_file":
            return f"  [MERGE   ] {shorten(self.src)}\n           → {shorten(self.dst)}"
        elif self.kind == "skip":
            return f"  [SKIP    ] {shorten(self.src)}  ({self.note})"
        elif self.kind == "manual":
            return f"  [MANUAL! ] {shorten(self.src)}  ({self.note})"
        else:
            return f"  [{self.kind}] {self.src} → {self.dst}"


# ── Per-series planning ───────────────────────────────────────────────────────

def plan_flatten(series_dir: Path) -> list[Op]:
    """
    Return ops to move every CBZ/CBR in subdirectories up to *series_dir*.
    Also schedules deletion of the (now-empty) subdirs.
    """
    ops: list[Op] = []
    subdirs_seen: list[Path] = []

    for root, dirs, files in os.walk(series_dir, topdown=True):
        root_p = Path(root)
        if root_p == series_dir:
            continue  # skip top level
        subdirs_seen.append(root_p)
        for fname in files:
            src = root_p / fname
            if src.suffix.lower() in COMIC_EXTS:
                dst = series_dir / fname
                ops.append(Op("flatten", src, dst))

    # Schedule rmdir for all subdirs (deepest first so parents can be removed)
    for sd in sorted(subdirs_seen, key=lambda p: len(p.parts), reverse=True):
        ops.append(Op("rmdir", sd, sd))

    return ops


def plan_rename_files(series_dir: Path, extra_names: set[str] | None = None) -> list[Op]:
    """
    Return ops to rename comic files in *series_dir* to canonical form.
    *extra_names* are filenames that will land in *series_dir* after a
    flatten step (they don't exist yet on disk but need renaming).
    """
    ops: list[Op] = []
    extra_names = extra_names or set()

    # Collect existing files + incoming files from flatten
    targets: list[tuple[Path, bool]] = [  # (path, exists_on_disk)
        (series_dir / n, False) for n in extra_names
    ]
    for f in series_dir.iterdir():
        if f.is_file() and f.suffix.lower() in COMIC_EXTS:
            targets.append((f, True))

    for fpath, on_disk in targets:
        ext  = fpath.suffix.lower()
        stem = fpath.stem
        canon, note = canonical_filename(stem, ext)

        if canon is None:
            ops.append(Op("manual", fpath, fpath, note))
        elif canon != fpath.name:
            dst = fpath.parent / canon
            ops.append(Op("rename_file", fpath, dst, note))
        # else: already canonical — no op needed

    return ops


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "base_dir", nargs="?", default=BASE_DEFAULT,
        help="Path to the Ultimate Comics (or similar) folder",
    )
    parser.add_argument(
        "--execute", action="store_true",
        help="Apply all changes. Without this flag the script is a dry run.",
    )
    parser.add_argument(
        "--map-file", metavar="JSON",
        help=(
            "JSON file mapping raw folder names to {name, year} overrides. "
            'E.g. {"Ultimate Avengers 1 (001-006) (2009-2010) ...": '
            '{"name": "Ultimate Avengers", "year": "2009"}}'
        ),
    )
    args = parser.parse_args()

    base = Path(args.base_dir)
    if not base.is_dir():
        print(f"ERROR: not a directory: {base}", file=sys.stderr)
        sys.exit(1)

    dry_run = not args.execute

    # Load optional name overrides
    overrides: dict[str, dict] = {}
    if args.map_file:
        with open(args.map_file, encoding="utf-8") as fh:
            overrides = json.load(fh)

    banner = "DRY RUN — no changes will be made. Re-run with --execute to apply." if dry_run else "EXECUTE MODE — applying changes now."
    print("=" * 72)
    print(banner)
    print("=" * 72)
    print(f"Base directory: {base}\n")

    # ── 1. Collect top-level series directories ───────────────────────
    series_dirs: list[Path] = []
    skipped: list[Path] = []
    already_ok: list[Path] = []

    for item in sorted(base.iterdir()):
        if not item.is_dir():
            continue
        if item.name in SKIP_FOLDERS:
            skipped.append(item)
            continue
        series_dirs.append(item)

    print(f"Found {len(series_dirs)} series folder(s)  (skipped {len(skipped)} collection/meta folder(s))\n")
    for s in skipped:
        print(f"  [SKIPPED] '{s.name}'")
    if skipped:
        print()

    # ── 2. Parse folder names → group by target ───────────────────────
    target_to_sources: dict[str, list[Path]] = defaultdict(list)
    parse_errors: list[Path] = []

    for d in series_dirs:
        if d.name in overrides:
            ov = overrides[d.name]
            clean  = ov.get("name", d.name)
            yr     = ov.get("year")
        else:
            clean, yr = parse_series_folder(d.name)

        if not clean:
            parse_errors.append(d)
            continue

        target_name = f"{clean} ({yr})" if yr else clean
        target_to_sources[target_name].append(d)

    if parse_errors:
        print("[WARNING] Could not parse these folder names (skipping):")
        for d in parse_errors:
            print(f"  '{d.name}'")
        print()

    # ── 3. Plan all operations ────────────────────────────────────────
    all_ops: list[Op] = []
    manual_review: list[Op] = []

    for target_name in sorted(target_to_sources):
        sources = target_to_sources[target_name]
        target_dir = base / target_name

        is_merge   = len(sources) > 1
        needs_rename = len(sources) == 1 and sources[0].name != target_name

        print("-" * 72)
        if is_merge:
            print(f"[MERGE → '{target_name}']  ({len(sources)} source folders)")
            for s in sources:
                print(f"    ← '{s.name}'")
        elif needs_rename:
            print(f"[RENAME FOLDER]")
            print(f"    '{sources[0].name}'")
            print(f"    → '{target_name}'")
        else:
            print(f"[OK — no folder rename needed]  '{target_name}'")

        # Flatten + rename for each source folder
        for src_dir in sources:
            flat_ops   = plan_flatten(src_dir)
            extra_names = {op.dst.name for op in flat_ops if op.kind == "flatten"}
            rename_ops  = plan_rename_files(src_dir, extra_names)

            if flat_ops or rename_ops:
                print(f"\n  Source: '{src_dir.name}'")
                for op in flat_ops:
                    print(op.describe(base))
                for op in rename_ops:
                    print(op.describe(base))
                    if op.kind == "manual":
                        manual_review.append(op)

            all_ops.extend(flat_ops)
            all_ops.extend(rename_ops)

        # Folder-level ops (rename / merge)
        if is_merge:
            # Merge: files will be moved dynamically in Phase D (execute),
            # after renames, so we only schedule the dir-level bookkeeping.
            comic_count = 0
            for src_dir in sources:
                # Count current comics (+ incoming from flatten) to show user
                flat_names = {op.dst.name for op in all_ops if op.kind == "flatten" and op.dst.parent == src_dir}
                comics_in_src = sum(
                    1 for f in src_dir.iterdir()
                    if f.is_file() and f.suffix.lower() in COMIC_EXTS
                ) + len(flat_names)
                comic_count += comics_in_src
                # Schedule the dir rename/removal for after Phase D
                all_ops.append(Op("rename_dir", src_dir, target_dir, "merge into target"))
            print(f"\n  ↳ {comic_count} comic file(s) will be merged into '{target_name}'")
        elif needs_rename:
            all_ops.append(Op("rename_dir", sources[0], target_dir))

        print()

    # ── 4. Summary ────────────────────────────────────────────────────
    counts = defaultdict(int)
    for op in all_ops:
        counts[op.kind] += 1

    print("=" * 72)
    print("OPERATION SUMMARY")
    print(f"  Flatten (subdir → series root) : {counts['flatten']:>4}")
    print(f"  File renames                   : {counts['rename_file']:>4}")
    print(f"  Merge files across folders     : {counts['merge_file']:>4}")
    print(f"  Folder renames                 : {counts['rename_dir']:>4}")
    print(f"  Subdir removals                : {counts['rmdir']:>4}")
    print(f"  Manual review needed           : {counts['manual']:>4}")

    if manual_review:
        print("\nFiles requiring manual review:")
        for op in manual_review:
            print(f"  {op.src.name}  ({op.note})")

    if dry_run:
        print("\nDry run complete — no changes were made.")
        print("Re-run with --execute to apply all operations above.")
        return

    # ── 5. Execute ────────────────────────────────────────────────────
    # Execution order matters:
    #   Phase A: flatten subdirectory files to series root
    #   Phase B: rename files in each series root
    #   Phase C: remove now-empty subdirectories
    #   Phase D: for merges, move all comics from each source into target dir
    #   Phase E: rename single-source folders / remove emptied merge sources
    print("\nApplying changes...")
    errors: list[str] = []

    def safe_run(op: Op) -> None:
        try:
            _execute_op(op, errors)
        except Exception as exc:  # noqa: BLE001
            msg = f"ERROR [{op.kind}] {op.src}: {exc}"
            print(f"  !! {msg}")
            errors.append(msg)

    # Phase A — flatten
    for op in all_ops:
        if op.kind == "flatten":
            safe_run(op)

    # Phase B — rename files
    for op in all_ops:
        if op.kind == "rename_file":
            safe_run(op)

    # Phase C — remove empty subdirs
    for op in all_ops:
        if op.kind == "rmdir":
            safe_run(op)

    # Phase D — merge: for each merge group, scan source dirs for any
    # remaining comics (they now have their post-rename names) and move them.
    for target_name, sources in sorted(target_to_sources.items()):
        if len(sources) <= 1:
            continue
        target_dir = base / target_name
        target_dir.mkdir(parents=True, exist_ok=True)
        for src_dir in sources:
            if not src_dir.exists():
                continue
            for fpath in sorted(src_dir.iterdir()):
                if fpath.is_file() and fpath.suffix.lower() in COMIC_EXTS:
                    dst = target_dir / fpath.name
                    if dst.exists():
                        print(f"  SKIP merge collision: {fpath.name}")
                    else:
                        fpath.rename(dst)
                        print(f"  MRGF: {src_dir.name}/{fpath.name}")

    # Phase E — rename / remove empty dirs
    for op in all_ops:
        if op.kind == "rename_dir":
            safe_run(op)

    print("\nDone.")
    if errors:
        print(f"\n{len(errors)} error(s) occurred:")
        for e in errors:
            print(f"  {e}")
    else:
        print("All operations completed successfully.")


def _execute_op(op: Op, errors: list[str]) -> None:
    if op.kind == "flatten":
        dst = op.dst
        if dst.exists():
            print(f"  SKIP (exists): {op.dst.name}")
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            op.src.rename(dst)
            print(f"  FLAT: {op.src.name}")

    elif op.kind == "rename_file":
        if not op.src.exists():
            print(f"  SKIP (gone): {op.src.name}")
            return
        if op.dst.exists() and op.src != op.dst:
            print(f"  SKIP collision: {op.dst.name}")
        else:
            op.src.rename(op.dst)
            print(f"  RNFL: {op.src.name} → {op.dst.name}")

    elif op.kind == "rmdir":
        try:
            op.src.rmdir()
            print(f"  RMDR: {op.src.name}")
        except OSError:
            print(f"  SKIP rmdir (not empty): {op.src.name}")

    elif op.kind == "rename_dir":
        if not op.src.exists():
            print(f"  SKIP (gone dir): {op.src.name}")
            return
        if op.dst.exists():
            # Target already exists (merge already created it); remove empty source.
            try:
                op.src.rmdir()
                print(f"  RMDR (emptied): {op.src.name}")
            except OSError:
                print(f"  WARN not empty after merge — check: {op.src.name}")
        else:
            op.src.rename(op.dst)
            print(f"  RNDR: {op.src.name} → {op.dst.name}")

    elif op.kind == "manual":
        print(f"  MANU (skipped): {op.src.name}  [{op.note}]")


if __name__ == "__main__":
    main()
