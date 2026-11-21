#!/usr/bin/env python3
"""Read-only: how a ZIP/CBZ file ends (2026-11-21, store_dates.py fix-endings errors).

  python3 zip_inspect.py "/comics/.../Detective Comics 204.cbz"
  python3 zip_inspect.py "Detective Comics 204.cbz" "Detective Comics 271.cbz"   (names: looked up)

Prints the file size, every end record in the last 192 KB (where its index says it starts, how big it
is and whether that index really is there), what Python's zip reader and 7-Zip say, and this book's
rows in the store-date working data. Changes nothing.
"""
import os
import sqlite3
import struct
import subprocess
import sys
import zipfile

EOCD = struct.Struct("<4sHHHHIIH")
paths = []
for arg in sys.argv[1:]:
    if os.path.exists(arg):
        paths.append(arg)
        continue
    # A file name ("Detective Comics 271.cbz"): look it up in the store-date working data.
    found = sqlite3.connect("/appdata/store-date-backfill.db").execute(
        "SELECT DISTINCT path FROM written WHERE path LIKE ?", ("%/" + arg,)).fetchall()
    if not found:
        print(f"{arg}: not found")
    paths += [r[0] for r in found]
if len(paths) > 1:
    for p in paths:
        subprocess.run([sys.executable, __file__, p])
        print("-" * 60)
    sys.exit(0)
if not paths:
    sys.exit(1)
path = paths[0]
size = os.path.getsize(path)
print(f"file: {path}\nsize: {size:,} bytes")
with open(path, "rb") as f:
    span = min(size, 192 * 1024)
    f.seek(size - span)
    tail = f.read(span)
    base = size - span
    i = tail.find(b"PK\x05\x06")
    n = 0
    while i >= 0:
        if i + EOCD.size <= len(tail):
            sig, disk, cdd, nd, entries, cd_size, cd_off, clen = EOCD.unpack_from(tail, i)
            at = base + i
            f.seek(cd_off)
            head = f.read(4)
            head_s = "PK 01 02 (ok)" if head == b"PK" + bytes([1, 2]) else repr(head)
            print(f"end record at {at:,}: entries {entries}, index at {cd_off:,} size {cd_size:,} "
                  f"(index ends {cd_off + cd_size:,}; record {'right after it' if cd_off + cd_size == at else 'NOT right after it'}), "
                  f"comment {clen}, record ends {at + EOCD.size + clen:,}{' = end of file' if at + EOCD.size + clen == size else ''}; "
                  f"bytes at index start {head_s}")
            n += 1
        i = tail.find(b"PK\x05\x06", i + 1)
    if not n:
        print("no end record in the last 192 KB")
    f.seek(max(0, size - 64))
    print("last 64 bytes:", f.read().hex())
try:
    with zipfile.ZipFile(path) as z:
        names = [x.filename for x in z.infolist()]
        print(f"python zipfile: ok, {len(names)} members; ComicInfo-like: {[x for x in names if 'comicinfo' in x.lower()]}")
except Exception as e:
    print(f"python zipfile: {type(e).__name__}: {e}")
try:
    r = subprocess.run(["7z", "l", path], capture_output=True, text=True, timeout=120)
    keep = [l for l in (r.stdout + r.stderr).splitlines() if any(k in l for k in ("ERROR", "Error", "WARN", "after the end", "Type =", "Physical Size", "Tail Size", "Offset", "files"))]
    print("7z l: rc", r.returncode, "|", " | ".join(keep[:12]))
except Exception as e:
    print("7z:", e)
db = "/appdata/store-date-backfill.db"
if os.path.exists(db):
    st = sqlite3.connect(db)
    for t in ("written", "dates", "redo", "endings_backup"):
        try:
            cols = [c[1] for c in st.execute(f"PRAGMA table_info({t})")]
            rows = st.execute(f"SELECT * FROM {t} WHERE path = ?", (path,)).fetchall()
            for row in rows:
                print(f"{t}:", {k: (v if not isinstance(v, bytes) else f'<{len(v)} bytes>') for k, v in zip(cols, row)})
        except sqlite3.Error:
            pass
app = "/appdata/omnibus.db"
if os.path.exists(app):
    a = sqlite3.connect(f"file:{app}?mode=ro", uri=True)
    r = a.execute("SELECT id, file_size, file_mtime, last_scanned, cv_issue_id FROM scanned_books WHERE path = ?", (path,)).fetchone()
    print("omnibus:", r)
