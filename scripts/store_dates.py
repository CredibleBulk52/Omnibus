#!/usr/bin/env python3
"""Store dates for the existing library: a one-time backfill of ComicInfo <StoreDate> (2026-11-19).

Omnibus writes <StoreDate>YYYY-MM-DD</StoreDate> (the on-sale day) into ComicInfo from Comic Vine or
Metron when it tags a book (backend/storeDate.js). This script gives the books already in the library
the same element, without sending them back through the metadata routine.
See claude/SERIES_READING_ORDER.md, "Store-date plan", part 2.

Run inside the Omnibus container (docker exec omnibus python3 /app/scripts/store_dates.py ...):

  collect  Find a store date for every tagged CBZ that has none. No files change; the routine keeps
           running. Free sources first (the book's monitored issue, the metadata routine's saved date,
           cached Comic Vine issue lists, MetronInfo.xml in the archive), then Metron's issue list for
           the series, then Comic Vine: the series' issue list when it holds many of the books, else
           25 issue IDs per request, batched across series. Metron and Comic Vine count as equal sources; Metron is asked first only
           because its allowance is larger. Calls share Omnibus's limits (cv_api_log / cv_windows in
           the background lane, metron_pace). Progress is kept: run it again to continue.
  report   What collect found: dates per source, disagreements, books without a date. --csv FILE.
  write    Add <StoreDate> to each book collect dated. Pauses the metadata routine and restores it
           afterwards. Only the ComicInfo.xml member changes; every other member keeps its bytes and
           order (checked before the file is swapped in). A file that changed since it was read is
           left alone. --dry-run builds and checks each new archive in /tmp and keeps the original.
           Run a library scan afterwards so Omnibus reads the new tags.

Options for collect and write: --series ID|CV volume ID|"Name"|"Name (Year)" (repeatable),
--max-series N. Collect: --no-metron, --no-cv, --retry-missing (ask again for books found without a
date). Working data: /appdata/store-date-backfill.db (STORE_DATE_STATE overrides).
"""
import argparse
import csv
import importlib.util
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", "/appdata/omnibus.db")
STATE_PATH = os.environ.get("STORE_DATE_STATE", os.path.join(os.path.dirname(DB_PATH), "store-date-backfill.db"))
CV_BATCH = 25          # ids per Comic Vine request (proven in eventGenerator.js)
CV_PAGE = 100          # issues per Comic Vine list page
STORE_RE = re.compile(r"<StoreDate>(\d{4}-\d{2}-\d{2})</StoreDate>")


def log(msg):
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)


def valid_date(text):
    if not isinstance(text, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text[:10] if len(text) >= 10 else text):
        return None
    text = text[:10]
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return None


def comicinfo_store_date(xml):
    """The same rule as backend/storeDate.js: first <StoreDate> holding exactly YYYY-MM-DD."""
    if not xml:
        return None
    i = xml.find("<StoreDate>")
    if i < 0 or xml[i + 21:i + 33] != "</StoreDate>":
        return None
    return valid_date(xml[i + 11:i + 21])


def norm_number(n):
    t = str(n or "").strip().lstrip("#").lower()
    m = re.fullmatch(r"(-?)0*(\d+)(\.\d+)?([a-z]*)", t)
    if not m:
        return t
    frac = m.group(3) if m.group(3) and not re.fullmatch(r"\.0+", m.group(3)) else ""
    return f"{m.group(1)}{m.group(2)}{frac}{m.group(4)}"


def norm_name(s):
    return re.sub(r"[^a-z0-9]+", "", str(s or "").lower().replace("&", "and"))


# ─── Connections and keys ────────────────────────────────────────────

def app_db():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def state_db():
    conn = sqlite3.connect(STATE_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS dates (book_id TEXT PRIMARY KEY, series_id TEXT, cv_issue_id TEXT, path TEXT,
        store_date TEXT, source TEXT, checked_at TEXT);
      CREATE TABLE IF NOT EXISTS conflicts (book_id TEXT, source_a TEXT, date_a TEXT, source_b TEXT, date_b TEXT,
        PRIMARY KEY (book_id, source_a, source_b));
      CREATE TABLE IF NOT EXISTS metron_series (cv_volume_id TEXT PRIMARY KEY, metron_id INTEGER, checked_at TEXT);
      CREATE TABLE IF NOT EXISTS written (book_id TEXT PRIMARY KEY, path TEXT, store_date TEXT, result TEXT, at TEXT);
    """)
    return conn


def load_keys():
    """Comic Vine key and Metron token: env first, else Omnibus's settings (decrypted by its own code)."""
    cv, metron = os.environ.get("CV_API_KEY", ""), os.environ.get("METRON_API_TOKEN", "")
    if cv and metron:
        return cv, metron
    backend = os.path.join(HERE, "..", "backend")
    js = ("const b=process.argv[1];const D=require(b+'/node_modules/better-sqlite3');"
          "const s=require(b+'/secrets').create();const db=new D(process.env.DB_PATH,{readonly:true});"
          "const g=k=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(k);return r?(s.open(r.value,k)||''):''};"
          "process.stdout.write(JSON.stringify({cv:g('cv_api_key'),metron:g('metron_api_token')}))")
    try:
        out = subprocess.run(["node", "-e", js, backend], capture_output=True, text=True, timeout=30,
                             env={**os.environ, "DB_PATH": DB_PATH})
        keys = json.loads(out.stdout or "{}")
    except Exception as e:
        log(f"Could not read keys from settings ({e}); set CV_API_KEY / METRON_API_TOKEN")
        keys = {}
    return cv or keys.get("cv", ""), metron or keys.get("metron", "")


def load_enricher():
    os.environ.setdefault("CV_LANE", "background")
    os.environ.setdefault("CV_CALLER", "store_dates.py")
    spec = importlib.util.spec_from_file_location("enricher", os.path.join(HERE, "enricher.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.CvPool.SPACING_MS = 2000   # background spacing, as in the server (CV_BG_SPACING_MS)
    return mod


# ─── Books ───────────────────────────────────────────────────────────

def select_series(db, wanted, max_series):
    rows = db.execute("SELECT id, name, year, series_json, monitored_series_id FROM scanned_series ORDER BY year DESC, name").fetchall()
    out = []
    for r in rows:
        try:
            vol = str((json.loads(r["series_json"] or "{}").get("metadata") or {}).get("comicid") or "")
            total = int((json.loads(r["series_json"] or "{}").get("metadata") or {}).get("total_issues") or 0)
        except Exception:
            vol, total = "", 0
        item = {"id": r["id"], "name": r["name"], "year": r["year"], "volume": vol if vol.isdigit() else "",
                "total": total, "monitored": r["monitored_series_id"]}
        if wanted and not any(series_matches(item, w) for w in wanted):
            continue
        out.append(item)
    return out[:max_series] if max_series else out


def series_matches(s, w):
    w = w.strip()
    if w == s["id"] or (w.isdigit() and w == s["volume"]):
        return True
    m = re.fullmatch(r"(.+?)\s*\((\d{4})\)", w)
    if m:
        return norm_name(m.group(1)) == norm_name(s["name"]) and str(s["year"]) == m.group(2)
    return norm_name(w) == norm_name(s["name"])


def books_of(db, series_id):
    return db.execute("""SELECT b.id, b.series_id, b.path, b.filename, b.issue_number, b.cv_issue_id, b.comicinfo,
        b.is_special, b.monitored_issue_id, mi.store_date AS monitored_store, j.publication_date AS job_date,
        j.date_basis AS job_basis
      FROM scanned_books b LEFT JOIN monitored_issues mi ON mi.id = b.monitored_issue_id
      LEFT JOIN metadata_jobs j ON j.book_id = b.id WHERE b.series_id = ?""", (series_id,)).fetchall()


def writable(book):
    ci = book["comicinfo"] or ""
    return book["path"].lower().endswith(".cbz") and "<ComicInfo" in ci and str(book["cv_issue_id"] or "").isdigit()


def metroninfo_date(path):
    try:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if re.search(r"(^|/)metroninfo\.xml$", n, re.I)]
            if not names:
                return None
            text = z.read(sorted(names, key=lambda n: n.count("/"))[0]).decode("utf-8", "replace")
    except Exception:
        return None
    m = re.search(r"<StoreDate>\s*(\d{4}-\d{2}-\d{2})\s*</StoreDate>", text)
    return valid_date(m.group(1)) if m else None


def cv_cache(db):
    out = {}
    try:
        for r in db.execute("SELECT issues FROM cv_volume_issues_cache"):
            for i in json.loads(r["issues"] or "[]"):
                d = valid_date(i.get("store_date") or "")
                if d and i.get("id"):
                    out[str(i["id"])] = d
    except Exception:
        pass
    return out


# ─── collect ─────────────────────────────────────────────────────────

class CvUnavailable(Exception):
    pass


class Collector:
    def __init__(self, args):
        self.db, self.st = app_db(), state_db()
        self.cache = cv_cache(self.db)
        self.metron = self.cv = None
        self.calls = {"metron": 0, "cv": 0}
        if not (args.no_metron and args.no_cv):
            mod = load_enricher()
            cv_key, metron_token = load_keys()
            if metron_token and not args.no_metron:
                self.metron = mod.MetronClient(metron_token)
            if cv_key and not args.no_cv:
                self.cv = mod.ComicVineClient(cv_key)
                if self.metron is not None:
                    self.metron.conn = self.cv.pool.conn
            if self.metron is not None and self.metron.conn is None:
                self.metron.conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
            log(f"Sources: Metron {'on' if self.metron else 'off'}, Comic Vine {'on' if self.cv else 'off'}")
        self.retry_missing = args.retry_missing
        self.queue, self.found_by_id = [], 0

    def save(self, book, d, source):
        self.st.execute("INSERT OR REPLACE INTO dates VALUES (?,?,?,?,?,?,?)",
                        (book["id"], book["series_id"], str(book["cv_issue_id"]), book["path"], d, source,
                         datetime.now().isoformat(timespec="seconds")))

    def conflict(self, book, a, b):
        self.st.execute("INSERT OR REPLACE INTO conflicts VALUES (?,?,?,?,?)", (book["id"], a[0], a[1], b[0], b[1]))

    def run_series(self, s):
        """Free sources, then Metron, then Comic Vine for this series. Books Comic Vine should answer by
        issue ID wait in a queue shared across series (25 per request). A book is finished once it has a
        row in `dates` (a date, or source 'none'); a stopped run continues with the others."""
        books = [b for b in books_of(self.db, s["id"]) if writable(b)]
        known = {r["book_id"]: r for r in self.st.execute("SELECT book_id, store_date FROM dates WHERE series_id = ?", (s["id"],))}
        need = []
        for b in books:
            if comicinfo_store_date(b["comicinfo"]):
                continue                                  # already carries one
            k = known.get(b["id"])
            if k and (k["store_date"] or not self.retry_missing):
                continue
            local = [(src, d) for src, d in (
                ("monitored", valid_date(b["monitored_store"] or "")),
                ("metadata_routine", valid_date(b["job_date"] or "") if b["job_basis"] == "store_date" else None),
                ("cv_cache", self.cache.get(str(b["cv_issue_id"]))),
            ) if d]
            if not local:
                mi = metroninfo_date(b["path"])
                if mi:
                    local.append(("metroninfo", mi))
            for other in local[1:]:
                if other[1] != local[0][1]:
                    self.conflict(b, local[0], other)
            if local:
                self.save(b, local[0][1], local[0][0])
            else:
                need.append(b)
        self.st.commit()
        if not need or (self.cv is None and self.metron is None):
            return len(need), 0
        found = {}
        if self.metron is not None and not self.metron.off and s["volume"]:
            found.update(self.from_metron(s, need))
        rest = [b for b in need if b["id"] not in found]
        if rest and self.cv is not None:
            outside = [b for b in rest if b["is_special"] or "annual" in b["filename"].lower()]
            inside = len(rest) - len(outside)
            if s["volume"] and s["total"] and math.ceil(s["total"] / CV_PAGE) < inside / CV_BATCH:
                dates = self.cv_volume(s["volume"])
                if dates is None:
                    raise CvUnavailable()
                for b in rest:
                    d = valid_date(dates.get(str(b["cv_issue_id"])) or "")
                    if d:
                        found[b["id"]] = (d, "comic_vine")
                    elif str(b["cv_issue_id"]) not in dates:
                        self.queue.append(b)              # not in this volume: ask by ID
                    else:
                        self.save(b, None, "none")
            else:
                self.queue.extend(rest)
        elif rest:
            for b in rest:
                self.save(b, None, "none")                # Metron only: nothing else to ask
        for b in need:
            if b["id"] in found:
                self.save(b, *found[b["id"]])
        self.st.commit()
        while len(self.queue) >= CV_BATCH:
            self.flush(CV_BATCH)
        return len(need), len(found)

    def flush(self, n=None):
        """Ask Comic Vine for the first n queued books (all when n is None), by issue ID."""
        while self.queue:
            chunk, self.queue = self.queue[:n or CV_BATCH], self.queue[n or CV_BATCH:]
            page = self.cv_get({"filter": "id:" + "|".join(str(b["cv_issue_id"]) for b in chunk), "limit": CV_BATCH})
            if page is None:
                self.queue = chunk + self.queue
                raise CvUnavailable()
            dates = {str(i.get("id")): valid_date(i.get("store_date") or "") for i in page}
            for b in chunk:
                d = dates.get(str(b["cv_issue_id"]))
                self.save(b, d, "comic_vine" if d else "none")
                self.found_by_id += 1 if d else 0
            self.st.commit()
            if n:
                return

    def cv_volume(self, volume):
        dates, offset = {}, 0
        while True:
            page = self.cv_get({"filter": f"volume:{volume}", "limit": CV_PAGE, "offset": offset})
            if page is None:
                return None
            for i in page:
                dates[str(i.get("id"))] = i.get("store_date")
            if len(page) < CV_PAGE:
                return dates
            offset += CV_PAGE

    def metron_series_id(self, s):
        row = self.st.execute("SELECT metron_id FROM metron_series WHERE cv_volume_id = ?", (s["volume"],)).fetchone()
        if row:
            return row["metron_id"]
        mid = None
        if s["monitored"]:
            r = self.db.execute("SELECT metron_series_id FROM monitored_series WHERE id = ?", (s["monitored"],)).fetchone()
            mid = r["metron_series_id"] if r and r["metron_series_id"] else None
        if not mid:
            self.calls["metron"] += 1
            found = self.metron._get("series/", {"cv_id": s["volume"]})
            if found is None:
                return None                                # failed: ask again next run, do not record
            hit = (found.get("results") or [None])[0]
            if hit and hit.get("id"):
                self.calls["metron"] += 1
                d = self.metron._get(f"series/{hit['id']}/")
                if d is None:
                    return None
                mid = hit["id"] if str(d.get("cv_id")) == s["volume"] else None
        self.st.execute("INSERT OR REPLACE INTO metron_series VALUES (?,?,?)", (s["volume"], mid, datetime.now().isoformat(timespec="seconds")))
        return mid

    def from_metron(self, s, need):
        mid = self.metron_series_id(s)
        if not mid:
            return {}
        items, url, params = [], "issue/", {"series_id": mid}
        while url:
            self.calls["metron"] += 1
            page = self.metron._get(url, params)
            if page is None:
                return {}                                  # failed: Comic Vine covers this series
            items += page.get("results") or []
            url, params = page.get("next"), None
        by_cv = {str(i["cv_id"]): i for i in items if i.get("cv_id")}
        by_num = {}
        for i in items:
            by_num.setdefault(norm_number(i.get("number")), []).append(i)
        out = {}
        for b in need:
            item = by_cv.get(str(b["cv_issue_id"]))
            if item is None and not by_cv and not b["is_special"] and "annual" not in b["filename"].lower():
                # No Comic Vine ids in Metron's list: match the regular issues of this run by number only
                # when the book's ComicInfo names this series.
                ci_series = re.search(r"<Series>([^<]*)</Series>", b["comicinfo"] or "")
                hits = by_num.get(norm_number(b["issue_number"])) or []
                if ci_series and norm_name(ci_series.group(1)) == norm_name(s["name"]) and len(hits) == 1:
                    item = hits[0]
            d = valid_date((item or {}).get("store_date") or "")
            if d:
                out[b["id"]] = (d, "metron")
        return out

    def cv_get(self, params):
        self.calls["cv"] += 1
        return self.cv._request("issues/", {**params, "field_list": "id,store_date,cover_date"})


def cmd_collect(args):
    c = Collector(args)
    series = select_series(c.db, args.series, args.max_series)
    log(f"{len(series)} series to check")
    asked = found = 0
    stopped = None
    try:
        for n, s in enumerate(series, 1):
            a, f = c.run_series(s)
            asked, found = asked + a, found + f
            if a:
                log(f"[{n}/{len(series)}] {s['name']} ({s['year']}): {a} without a date, {f} found now"
                    f"{f', {len(c.queue)} waiting for Comic Vine' if c.queue else ''} | calls Metron {c.calls['metron']}, Comic Vine {c.calls['cv']}")
        c.flush()
    except CvUnavailable:
        stopped = "Comic Vine is unavailable (hourly limit or a refusal). Run collect again later; progress is kept."
    except KeyboardInterrupt:
        stopped = "Stopped; progress is kept. Run collect again to continue."
    log(f"{'Stopped' if stopped else 'Done'}: {asked} books asked, {found + c.found_by_id} dated by Metron or Comic Vine."
        f" Calls: Metron {c.calls['metron']}, Comic Vine {c.calls['cv']}")
    if stopped:
        log(stopped)
    cmd_report(argparse.Namespace(csv=None))


# ─── report ──────────────────────────────────────────────────────────

def cmd_report(args):
    st = state_db()
    log(f"Working data: {STATE_PATH}")
    total = st.execute("SELECT COUNT(*) FROM dates").fetchone()[0]
    print(f"Books checked: {total}")
    for r in st.execute("SELECT source, COUNT(*) n FROM dates GROUP BY source ORDER BY n DESC"):
        print(f"  {r['source']:<18} {r['n']}")
    print("By decade of store date:")
    for r in st.execute("SELECT substr(store_date,1,3)||'0s' dec, COUNT(*) n FROM dates WHERE store_date IS NOT NULL GROUP BY dec ORDER BY dec"):
        print(f"  {r['dec']}  {r['n']}")
    n = st.execute("SELECT COUNT(*) FROM conflicts").fetchone()[0]
    print(f"Disagreements between sources: {n}")
    for r in st.execute("SELECT c.*, d.path FROM conflicts c LEFT JOIN dates d USING (book_id) LIMIT 20"):
        print(f"  {os.path.basename(r['path'] or r['book_id'])}: {r['source_a']} {r['date_a']} vs {r['source_b']} {r['date_b']}")
    w = st.execute("SELECT result, COUNT(*) n FROM written GROUP BY result").fetchall()
    if w:
        print("Written: " + ", ".join(f"{r['result']} {r['n']}" for r in w))
    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            out = csv.writer(f)
            out.writerow(["book_id", "series_id", "cv_issue_id", "path", "store_date", "source", "checked_at"])
            for r in st.execute("SELECT * FROM dates ORDER BY path"):
                out.writerow([r[k] for k in r.keys()])
        print(f"CSV: {args.csv}")


# ─── write ───────────────────────────────────────────────────────────

def root_comicinfo(z):
    roots = [i for i in z.infolist() if "/" not in i.filename and i.filename.lower() == "comicinfo.xml"]
    return roots[0] if len(roots) == 1 else None


def add_store_date(xml, d):
    """Insert <StoreDate> before </ComicInfo>, matching the file's indentation. None if unsafe."""
    m = re.match(r"﻿?<\?xml[^>]*encoding\s*=\s*['\"]([^'\"]+)['\"]", xml)
    if m and m.group(1).lower() != "utf-8":
        return None
    if "<StoreDate" in xml:
        return None
    end = list(re.finditer(r"</ComicInfo\s*>", xml))
    if len(end) != 1:
        return None
    at = end[0].start()
    indent = re.search(r"\n([ \t]+)<[A-Za-z]", xml)
    before = xml[:at]
    if indent and before.endswith("\n"):
        new = f"{before}{indent.group(1)}<StoreDate>{d}</StoreDate>\n{xml[at:]}"
    elif indent:
        trimmed = before.rstrip(" \t")
        new = f"{trimmed}\n{indent.group(1)}<StoreDate>{d}</StoreDate>\n{xml[at:]}"
    else:
        new = f"{before}<StoreDate>{d}</StoreDate>{xml[at:]}"
    try:
        root = ET.fromstring(new.lstrip("﻿").encode("utf-8"))
    except ET.ParseError:
        return None
    hits = root.findall("StoreDate")
    return new if len(hits) == 1 and hits[0].text == d else None


def rebuild(src, dst, d):
    """Copy src to dst with <StoreDate> added. Returns None on success, else the reason."""
    with zipfile.ZipFile(src) as zin:
        ci = root_comicinfo(zin)
        if ci is None:
            return "no single top-level ComicInfo.xml"
        raw = zin.read(ci)
        try:
            xml = raw.decode("utf-8")
        except UnicodeDecodeError:
            return "ComicInfo.xml is not UTF-8"
        new = add_store_date(xml, d)
        if new is None:
            return "ComicInfo.xml not safe to edit (encoding, existing StoreDate or structure)"
        with zipfile.ZipFile(dst, "w", allowZip64=True) as zout:
            zout.comment = zin.comment
            for info in zin.infolist():
                out = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                out.compress_type, out.external_attr, out.comment = info.compress_type, info.external_attr, info.comment
                out.create_system = info.create_system
                if info.filename == ci.filename:
                    zout.writestr(out, new.encode("utf-8"))
                elif info.is_dir():
                    zout.writestr(out, b"")
                else:
                    out.file_size = info.file_size
                    with zin.open(info) as fi, zout.open(out, "w", force_zip64=info.file_size > 0x7FFFFFFF) as fo:
                        shutil.copyfileobj(fi, fo, 1 << 20)
    # Every member except ComicInfo.xml: same names, order, sizes and CRCs; ComicInfo has the date.
    with zipfile.ZipFile(src) as a, zipfile.ZipFile(dst) as b:
        la, lb = a.infolist(), b.infolist()
        if [i.filename for i in la] != [i.filename for i in lb]:
            return "check failed: member list changed"
        for x, y in zip(la, lb):
            if x.filename == ci.filename:
                if comicinfo_store_date(b.read(y).decode("utf-8")) != d:
                    return "check failed: StoreDate not read back"
            elif (x.CRC, x.file_size) != (y.CRC, y.file_size):
                return f"check failed: {x.filename} changed"
    return None


def routine_running(conn):
    try:
        r = conn.execute("SELECT record FROM metadata_last_batch WHERE id = 1").fetchone()
        return bool(r) and json.loads(r[0] or "null").get("state") == "running"
    except Exception:
        return False


def cmd_write(args):
    db, st = app_db(), state_db()
    series_ids = {s["id"] for s in select_series(db, args.series, args.max_series)} if (args.series or args.max_series) else None
    done = ("written", "dry-run ok") if args.dry_run else ("written",)
    rows = st.execute(f"""SELECT d.* FROM dates d LEFT JOIN written w USING (book_id)
                         WHERE d.store_date IS NOT NULL AND (w.result IS NULL OR w.result NOT IN ({','.join('?' * len(done))}))
                         ORDER BY d.path""", done).fetchall()
    rows = [r for r in rows if series_ids is None or r["series_id"] in series_ids]
    if args.limit:
        rows = rows[:args.limit]
    log(f"{len(rows)} books to {'check (dry run)' if args.dry_run else 'write'}")
    if not rows:
        return
    rw = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    paused_before = None
    if not args.dry_run:
        paused_before = rw.execute("SELECT paused FROM metadata_maintenance_control WHERE id = 1").fetchone()[0]
        rw.execute("UPDATE metadata_maintenance_control SET paused = 1 WHERE id = 1")
        log("Metadata routine paused")
        for _ in range(120):
            if not routine_running(rw):
                break
            log("Waiting for the routine's current batch to finish…")
            time.sleep(10)
        else:
            rw.execute("UPDATE metadata_maintenance_control SET paused = ? WHERE id = 1", (paused_before,))
            log("The routine is still running after 20 minutes; nothing written")
            return
    counts = {}
    try:
        for n, r in enumerate(rows, 1):
            result = write_one(db, r, args.dry_run)
            counts[result] = counts.get(result, 0) + 1
            st.execute("INSERT OR REPLACE INTO written VALUES (?,?,?,?,?)",
                       (r["book_id"], r["path"], r["store_date"], result, datetime.now().isoformat(timespec="seconds")))
            st.commit()
            if result not in ("written", "dry-run ok") or n % 200 == 0:
                log(f"[{n}/{len(rows)}] {os.path.basename(r['path'])}: {result}")
    except KeyboardInterrupt:
        log("Stopped; progress kept")
    finally:
        if paused_before is not None:
            rw.execute("UPDATE metadata_maintenance_control SET paused = ? WHERE id = 1", (paused_before,))
            log(f"Metadata routine {'left paused (it was paused before)' if paused_before else 'resumed'}")
    log("Result: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    if not args.dry_run and counts.get("written"):
        log("Run a library scan in Omnibus so it reads the new tags.")


def write_one(db, r, dry_run):
    book = db.execute("SELECT path, comicinfo FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
    if not book:
        return "skipped: book no longer in the library"
    path = book["path"]
    if path != r["path"]:
        return "skipped: book moved since collect (run collect again)"
    if comicinfo_store_date(book["comicinfo"]):
        return "skipped: already has StoreDate"
    try:
        before = os.stat(path)
    except OSError:
        return "skipped: file missing"
    folder = tempfile.gettempdir() if dry_run else os.path.dirname(path)
    tmp = os.path.join(folder, f".{os.path.basename(path)}.storedate-{os.getpid()}.tmp")
    try:
        reason = rebuild(path, tmp, r["store_date"])
        if reason:
            return "skipped: " + reason
        if dry_run:
            return "dry-run ok"
        after = os.stat(path)
        if (after.st_mtime_ns, after.st_size) != (before.st_mtime_ns, before.st_size):
            return "skipped: file changed while writing"
        shutil.copymode(path, tmp)
        try:
            os.chown(tmp, before.st_uid, before.st_gid)
        except OSError:
            pass
        os.replace(tmp, path)
        return "written"
    except Exception as e:
        return f"error: {e}"
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--series", action="append")
    c.add_argument("--max-series", type=int)
    c.add_argument("--no-metron", action="store_true")
    c.add_argument("--no-cv", action="store_true")
    c.add_argument("--retry-missing", action="store_true")
    r = sub.add_parser("report")
    r.add_argument("--csv")
    w = sub.add_parser("write")
    w.add_argument("--series", action="append")
    w.add_argument("--max-series", type=int)
    w.add_argument("--limit", type=int)
    w.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    {"collect": cmd_collect, "report": cmd_report, "write": cmd_write}[args.cmd](args)


if __name__ == "__main__":
    main()
