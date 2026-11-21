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
  probe    Show what Metron's issue list holds for --series and how it matches the books.
  collect-wiki / collect-gcd  Third and fourth sources for books still without a date (Marvel and DC
           wikis; the Grand Comics Database's on-sale dates from a local index of its SQLite dump).
  write    Add <StoreDate> to each book collect dated. Pauses the metadata routine and restores it
           afterwards. Edits each archive in place: a new ComicInfo.xml and index are added at the end
           of the file and nothing before is changed; if the check afterwards fails, the file is cut
           back to its old length (restoring it exactly). A file that changed since it was read is left
           alone. --dry-run makes the same edit on a copy in /tmp and keeps the original.
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
import struct
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
import zlib
from datetime import date, datetime, timezone

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
      CREATE TABLE IF NOT EXISTS metron_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL);
      -- Books whose written StoreDate came from a wrong source (fix-monitored): bad_date is the value
      -- in the file; collect dates them again and write replaces it, or removes it when none is found.
      CREATE TABLE IF NOT EXISTS redo (book_id TEXT PRIMARY KEY, bad_date TEXT, reason TEXT, at TEXT);
      -- The bytes each clean-ending rewrite replaced (rewrite_ending): size before, where it cut, the old
      -- tail and an old ComicInfo.xml's local name; enough to put a file back exactly.
      CREATE TABLE IF NOT EXISTS endings_backup (book_id TEXT, path TEXT, size INTEGER, cut INTEGER, tail BLOB,
        orphan INTEGER, orphan_name BLOB, at TEXT);
      -- 2026-11-21: the old ComicInfo.xml record a clean-ending rewrite cut out of the file (compact_out):
      -- 7-Zip found it by its local header and extracted it as an extra file, so retags still failed.
      CREATE TABLE IF NOT EXISTS orphan_backup (book_id TEXT, path TEXT, start INTEGER, removed BLOB, at TEXT);
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
        b.is_special, b.monitored_issue_id,
        -- 2026-11-21: an old scanner linked specials and annuals to the parent's issue with the same
        -- number (Knight Terrors: Wonder Woman #1 -> Wonder Woman #1); only a link that agrees with the
        -- book's own Comic Vine ID gives its date.
        CASE WHEN b.monitored_issue_id = b.cv_issue_id THEN mi.store_date END AS monitored_store,
        j.publication_date AS job_date,
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
        self.redo = {r[0]: r[1] for r in self.st.execute("SELECT book_id, bad_date FROM redo")}
        # Metron allows 20 requests a minute and 5,000 a day (more for its donors). The script stops using
        # Metron for the run when Metron's limit is in force, when its daily count left falls to
        # --metron-reserve (default 1,500, kept for Omnibus), after its own --metron-budget (3,500 a
        # day), or after two failed requests in a row. 2026-11-20: the first full run used Metron's
        # 5,000 overnight and the old client kept retrying refused requests; Metron warned the account.
        self.metron_budget = getattr(args, "metron_budget", None) or 3500
        self.metron_reserve = getattr(args, "metron_reserve", None) or 1500
        self.metron_fails = 0
        self.queue, self.found_by_id = [], 0

    def save(self, book, d, source):
        if d and not plausible_date(book["comicinfo"], d):
            d, source = None, "none"                      # another series' issue; see plausible_date
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
            if comicinfo_store_date(b["comicinfo"]) and b["id"] not in self.redo:
                continue                                  # already carries one
            k = known.get(b["id"])
            if k and (k["store_date"] or not self.retry_missing):
                continue
            local = [(src, d) for src, d in (
                ("monitored", valid_date(b["monitored_store"] or "")),
                ("metadata_routine", valid_date(b["job_date"] or "") if b["job_basis"] == "store_date" else None),
                ("cv_cache", self.cache.get(str(b["cv_issue_id"]))),
            ) if d and plausible_date(b["comicinfo"], d)]
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
        if self.metron_ok() and s["volume"]:
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

    def metron_ok(self):
        return self.metron is not None and not self.metron.off

    def metron_used_today(self):
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        row = self.st.execute("SELECT calls FROM metron_usage WHERE day = ?", (day,)).fetchone()
        return day, (row["calls"] if row else 0)

    def mget(self, url, params=None):
        """One Metron request within the daily budget; None (and Metron off for the run) when refused."""
        if not self.metron_ok():
            return None
        # Metron's own counts (shared metron_limits, kept by enricher.py's MetronClient and the server):
        # stop while Metron is blocked, and leave the last --metron-reserve daily requests to Omnibus.
        lim = self.metron.limits()
        if self.metron.blocked_until():
            log("Metron: its limit is in force (shared with Omnibus); Comic Vine only for the rest of this run")
            self.metron.off = True
            return None
        if lim.get("sustained_remaining") is not None and lim["sustained_remaining"] <= self.metron_reserve \
                and (lim.get("sustained_reset") or 0) > time.time() * 1000:
            log(f"Metron: {lim['sustained_remaining']} requests left today, kept for Omnibus; Comic Vine only for the rest of this run")
            self.metron.off = True
            return None
        day, used = self.metron_used_today()
        if used >= self.metron_budget:
            log(f"Metron: today's budget of {self.metron_budget} requests is used; Comic Vine only for the rest of this run")
            self.metron.off = True
            return None
        self.st.execute("INSERT INTO metron_usage VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1", (day,))
        self.st.commit()
        self.calls["metron"] += 1
        data = self.metron._get(url, params)
        if data is None:
            self.metron_fails += 1
            if self.metron_fails >= 2:
                log("Metron: refused twice in a row (likely its daily limit); Comic Vine only for the rest of this run")
                self.metron.off = True
        else:
            self.metron_fails = 0
        return data

    def metron_series_id(self, s):
        row = self.st.execute("SELECT metron_id FROM metron_series WHERE cv_volume_id = ?", (s["volume"],)).fetchone()
        if row:
            return row["metron_id"]
        mid = None
        if s["monitored"]:
            r = self.db.execute("SELECT metron_series_id FROM monitored_series WHERE id = ?", (s["monitored"],)).fetchone()
            mid = r["metron_series_id"] if r and r["metron_series_id"] else None
        if not mid:
            found = self.mget("series/", {"cv_id": s["volume"]})
            if found is None:
                return None                                # failed: ask again next run, do not record
            hit = (found.get("results") or [None])[0]
            if hit and hit.get("id"):
                d = self.mget(f"series/{hit['id']}/")
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
            page = self.mget(url, params)
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
            if d and plausible_date(b["comicinfo"], d):
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
    try:
        wt = st.execute("SELECT wiki, result, COUNT(*) n FROM wiki_tried GROUP BY wiki, result ORDER BY wiki, n DESC").fetchall()
    except sqlite3.OperationalError:
        wt = []
    if wt:
        print("Wiki lookups (collect-wiki):")
        for r in wt:
            print(f"  {r['wiki']:<7} {r['result']:<22} {r['n']}")
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

COMICINFO_NAME = re.compile(r"(^|[/\\])comicinfo\.xml$", re.I)


def root_comicinfo(z):
    """The ComicInfo.xml member Omnibus's reader uses (comicInfoFiles.js), when that choice is clear:
    a single non-empty top-level copy, else the one non-empty copy anywhere (many archives keep the
    pages and ComicInfo.xml in a folder). None when there is none or the choice is ambiguous.
    The edit keeps the member's own path, so a nested ComicInfo.xml is updated where it is."""
    found = [i for i in z.infolist() if not i.is_dir() and COMICINFO_NAME.search(i.filename)]
    roots = [i for i in found if not re.search(r"[/\\]", i.filename)]
    filled = [i for i in found if i.file_size > 0 and z.read(i).strip()]
    if len(roots) == 1 and roots[0] in filled:
        return roots[0]
    if len(filled) == 1 and len(roots) <= 1:
        return filled[0]
    return None


def replace_store_date(xml, bad, d):
    """Change the one <StoreDate>bad</StoreDate> to d, or remove it (and its line) when d is None."""
    hits = list(re.finditer(r"[ \t]*<StoreDate>" + re.escape(bad) + r"</StoreDate>[ \t]*\r?\n?", xml))
    if len(hits) != 1 or xml.count("<StoreDate") != 1:
        return None
    h = hits[0]
    new = xml[:h.start()] + (h.group(0).replace(bad, d) if d else "") + xml[h.end():]
    try:
        root = ET.fromstring(new.lstrip("\ufeff").encode("utf-8"))
    except ET.ParseError:
        return None
    found = [e.text for e in root.findall("StoreDate")]
    return new if found == ([d] if d else []) else None


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


# In-place edit (user's choice, 2026-11-19): the pages are never moved. 2026-11-21: the first version
# appended a new ComicInfo.xml, index and end record after the archive's own; 7-Zip reads the first end
# record, so it (and Omnibus's retag, which extracts with 7-Zip) saw the old ComicInfo.xml. Now the
# ending is rewritten in place (rewrite_ending, below): one ComicInfo.xml, one index, one end record.
# Skipped: ZIP64 archives (over 4 GB or 65,535 members), multi-disk archives, anything unexpected.
LOC_SIG, CEN_SIG, EOCD_SIG = b"PK\x03\x04", b"PK\x01\x02", b"PK\x05\x06"
CEN = struct.Struct("<4sHHHHHHIIIHHHHHII")
EOCD = struct.Struct("<4sHHHHIIH")
LOC = struct.Struct("<4sHHHHHIIIHH")


class Skip(Exception):
    pass


def read_layout(f, size):
    """End record and central directory records of a plain (non-ZIP64, single-disk) ZIP."""
    span = min(size, 65535 + EOCD.size)
    f.seek(size - span)
    tail = f.read(span)
    i = tail.rfind(EOCD_SIG)
    while i >= 0:
        if i + EOCD.size <= len(tail):
            sig, disk, cd_disk, n_disk, n, cd_size, cd_off, clen = EOCD.unpack_from(tail, i)
            if i + EOCD.size + clen == len(tail):
                eocd_at = size - span + i
                break
        i = tail.rfind(EOCD_SIG, 0, i)
    else:
        raise Skip("no ZIP end record")
    comment = tail[i + EOCD.size:]
    if disk or cd_disk or n_disk != n or n == 0xFFFF or 0xFFFFFFFF in (cd_size, cd_off):
        raise Skip("ZIP64 or multi-disk archive")
    if cd_off + cd_size != eocd_at or (eocd_at >= 20 and tail[i - 20:i - 16] == b"PK\x06\x07"):
        raise Skip("unexpected bytes around the central directory")
    f.seek(cd_off)
    cd = f.read(cd_size)
    records, p = [], 0
    for _ in range(n):
        if cd[p:p + 4] != CEN_SIG:
            raise Skip("damaged central directory")
        h = CEN.unpack_from(cd, p)
        end = p + CEN.size + h[10] + h[11] + h[12]
        raw_name = cd[p + CEN.size:p + CEN.size + h[10]]
        name = raw_name.decode("utf-8" if h[3] & 0x800 else "cp437", "replace")
        records.append({"raw": cd[p:end], "h": h, "name": name, "raw_name": raw_name,
                        "comment": cd[p + CEN.size + h[10] + h[11]:end]})
        p = end
    if p != len(cd):
        raise Skip("damaged central directory")
    return records, comment


def end_record_ending_at(f, end):
    """The ZIP end record that ends exactly at offset `end` (its comment included): (cd_offset, cd_size,
    entries) or None. An appended StoreDate edit left the archive's earlier end record right where its
    new ComicInfo.xml begins."""
    lo = max(0, end - EOCD.size - 65535)
    f.seek(lo)
    buf = f.read(end - lo)
    i = buf.rfind(EOCD_SIG)
    while i >= 0:
        if i + EOCD.size <= len(buf):
            sig, disk, cd_disk, n_disk, n, cd_size, cd_off, clen = EOCD.unpack_from(buf, i)
            if i + EOCD.size + clen == len(buf) and cd_off + cd_size == lo + i:
                return cd_off, cd_size, n
        i = buf.rfind(EOCD_SIG, 0, i)
    return None


def cd_entry(f, cd_off, cd_size, raw_name):
    """The central directory record (CEN tuple) of member `raw_name` in the index at cd_off, or None."""
    f.seek(cd_off)
    cd = f.read(cd_size)
    p = 0
    while p + CEN.size <= len(cd) and cd[p:p + 4] == CEN_SIG:
        h = CEN.unpack_from(cd, p)
        if cd[p + CEN.size:p + CEN.size + h[10]] == raw_name:
            return h
        p += CEN.size + h[10] + h[11] + h[12]
    return None


def local_entry_end(f, off, csize, flags):
    """Where the member whose local header is at `off` ends (data descriptor included)."""
    f.seek(off)
    head = f.read(LOC.size)
    if len(head) < LOC.size or head[:4] != LOC_SIG:
        raise Skip("damaged local header")
    h = LOC.unpack(head)
    end = off + LOC.size + h[9] + h[10] + csize
    if flags & 0x8:                                   # data descriptor after the data
        f.seek(end)
        end += 16 if f.read(4) == b"PK\x07\x08" else 12
    return end


# Clean ending (2026-11-21). The first `write` appended a new ComicInfo.xml, index and end record after the
# archive's own index and end record. Readers that use the last index (Omnibus, Python, Komga) saw the new
# ComicInfo.xml; 7-Zip 23 stopped at the earlier end record, warned "data after the end of archive",
# reported success and extracted the old ComicInfo.xml, so Omnibus's retag refused to replace such files
# ("Extraction/build changed source paths or payloads"). A ZIP has to end with exactly one index and end
# record. So the ending is rewritten in place instead: from where the archive's own index began (or from
# its old ComicInfo.xml, when that was the last member) the file gets the new ComicInfo.xml, one index and
# one end record. The pages are not moved. An old ComicInfo.xml that sits before other members stays as
# unused bytes; its local name is changed to ComicInfo.old, so readers that scan from the front skip it.
# The bytes replaced are kept (endings_backup) and restored if the result does not check out.
def rewrite_ending(path, ci, data, check):
    """Write `data` as ComicInfo.xml member `ci` (a ZipInfo of the current archive) with a clean ending.
    check(path) -> None or a reason; on a reason the file is put back. Returns (None, backup) or (reason, None)."""
    size = os.path.getsize(path)
    with zipfile.ZipFile(path) as z:
        before = [(i.filename, i.CRC, i.file_size, i.header_offset) for i in z.infolist()]
    with open(path, "r+b") as f:
        try:
            records, comment = read_layout(f, size)
        except Skip as e:
            return str(e), None
        hits = [r for r in records if r["name"] == ci.filename]
        if len(hits) != 1:
            return "central directory does not match the archive listing", None
        cur = hits[0]
        raw_name, h = cur["raw_name"], cur["h"]
        f.seek(size - EOCD.size - len(comment))
        cd_now = EOCD.unpack(f.read(EOCD.size))[6]
        # Follow earlier appended edits back to the archive's own index and its own ComicInfo.xml.
        base, ci_off, ci_size, ci_flags = cd_now, h[16], h[8], h[3]
        while True:
            prior = end_record_ending_at(f, ci_off)
            if not prior:
                break
            ph = cd_entry(f, prior[0], prior[1], raw_name)
            if ph is None:
                return "earlier index has no ComicInfo.xml", None
            base, ci_off, ci_size, ci_flags = prior[0], ph[16], ph[8], ph[3]
        try:
            ci_end = local_entry_end(f, ci_off, ci_size, ci_flags)
        except Skip as e:
            return str(e), None
        cut = ci_off if ci_end == base else base
        orphan = None if cut == ci_off else ci_off
        flags = h[3] & 0x800
        crc = zlib.crc32(data) & 0xFFFFFFFF
        local = LOC.pack(LOC_SIG, 20, flags, 0, h[5], h[6], crc, len(data), len(data), len(raw_name), 0) + raw_name
        entry = CEN.pack(CEN_SIG, h[1], 20, flags, 0, h[5], h[6], crc, len(data), len(data), len(raw_name), 0,
                         len(cur["comment"]), 0, h[14], h[15], cut) + raw_name + cur["comment"]
        cd = b"".join(entry if r is cur else r["raw"] for r in records)
        cd_off = cut + len(local) + len(data)
        if cd_off + len(cd) + EOCD.size + len(comment) >= 0xFFFFFFFF:
            return "archive would need ZIP64", None
        tail = local + data + cd + EOCD.pack(EOCD_SIG, 0, 0, len(records), len(records), len(cd), cd_off, len(comment)) + comment
        f.seek(cut)
        backup = {"size": size, "cut": cut, "tail": f.read(size - cut), "orphan": orphan, "orphan_name": None}
        if orphan is not None:
            f.seek(orphan + LOC.size)
            backup["orphan_name"] = f.read(len(raw_name))
        try:
            f.seek(cut)
            f.write(tail)
            f.truncate(cut + len(tail))
            if orphan is not None and raw_name.lower().endswith(b".xml"):
                f.seek(orphan + LOC.size + len(raw_name) - 3)
                f.write(b"old")                        # ComicInfo.xml -> ComicInfo.old, unused bytes
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            restore_ending(f, backup)
            raise
    if orphan is not None:
        # 2026-11-21: an old ComicInfo.xml left before the pages is still found by 7-Zip through its local
        # header (it extracted "ComicInfo.old" as an extra file and retags failed), so cut it out of the file.
        # The result is written beside the file, checked, and only then put in its place.
        reason, removed = compact_out(path, orphan, lambda tmp, shift: verify_compacted(
            tmp, before, ci.filename, orphan, shift, data) or seven_zip_check(tmp, ci.filename, data)
            or omnibus_retag_check(tmp))
        if reason:
            with open(path, "r+b") as f:
                restore_ending(f, backup)
            return reason + " (restored)", None
        backup["removed"] = removed
        return None, backup
    reason = check(path) or omnibus_retag_check(path)
    if reason:
        with open(path, "r+b") as f:
            restore_ending(f, backup)
        return reason + " (restored)", None
    return None, backup


def restore_ending(f, b):
    """Put back the bytes rewrite_ending replaced (and an old ComicInfo.xml's local name). Not for a file
    whose old ComicInfo.xml was cut out afterwards (orphan_backup holds those bytes)."""
    f.seek(b["cut"])
    f.write(b["tail"])
    f.truncate(b["size"])
    if b.get("orphan") is not None and b.get("orphan_name"):
        f.seek(b["orphan"] + LOC.size)
        f.write(b["orphan_name"])
    f.flush()
    os.fsync(f.fileno())


def compact_out(path, start, check):
    """Cut the unused local record at `start` (an old ComicInfo.xml no index lists) out of the archive:
    everything after it moves down, the index's offsets with it. The new file is written beside the old
    one, check(tmp, shift) must pass, then it replaces the old file. (None, removed bytes) or (reason, None)."""
    size = os.path.getsize(path)
    tmp = path + ".sd-tmp"
    with open(path, "rb") as f:
        try:
            records, comment = read_layout(f, size)
        except Skip as e:
            return str(e), None
        f.seek(size - EOCD.size - len(comment))
        e = EOCD.unpack(f.read(EOCD.size))
        n, cd_off = e[4], e[6]
        offs = sorted(r["h"][16] for r in records)
        if start in offs:
            return "the old ComicInfo.xml is still listed", None
        later = [o for o in offs if o > start]
        if not later or start >= cd_off:
            return "no member after the old ComicInfo.xml", None
        end = later[0]
        f.seek(start)
        head = f.read(LOC.size)
        if len(head) < LOC.size or head[:4] != LOC_SIG:
            return "no local header where the old ComicInfo.xml was", None
        name = f.read(LOC.unpack(head)[9]).lower()
        if not (name.endswith(b"comicinfo.old") or name.endswith(b"comicinfo.xml")):
            return "unexpected record where the old ComicInfo.xml was", None
        shift = end - start
        cd = b"".join(r["raw"][:42] + struct.pack("<I", r["h"][16] - shift if r["h"][16] > start else r["h"][16])
                      + r["raw"][46:] for r in records)
        f.seek(start)
        removed = f.read(shift)
        try:
            with open(tmp, "wb") as o:
                for a, b in ((0, start), (end, cd_off)):
                    f.seek(a)
                    left = b - a
                    while left:
                        chunk = f.read(min(left, 1 << 20))
                        if not chunk:
                            raise OSError("short read")
                        o.write(chunk)
                        left -= len(chunk)
                o.write(cd)
                o.write(EOCD.pack(EOCD_SIG, 0, 0, n, n, len(cd), cd_off - shift, len(comment)) + comment)
                o.flush()
                os.fsync(o.fileno())
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    try:
        shutil.copymode(path, tmp)
    except OSError:
        pass
    reason = check(tmp, shift)
    if reason:
        os.unlink(tmp)
        return reason, None
    os.replace(tmp, path)
    return None, removed


def verify_compacted(path, before, ci_name, start, shift, data):
    """After compact_out: the same members in the same order, every other member's CRC and size the same and
    its position moved down by `shift` when it was after `start`, and ComicInfo.xml exactly `data`."""
    try:
        with zipfile.ZipFile(path) as z:
            after = z.infolist()
            if [i.filename for i in after] != [b[0] for b in before]:
                return "check failed: member list changed"
            for (name, crc, fsize, off), i in zip(before, after):
                if name == ci_name:
                    if z.read(i) != data:
                        return "check failed: ComicInfo.xml not read back"
                elif (crc, fsize, off - shift if off > start else off) != (i.CRC, i.file_size, i.header_offset):
                    return f"check failed: {name} changed"
    except Exception as e:
        return f"check failed: {e}"
    return None


SEVEN_ZIP = shutil.which("7z") or shutil.which("7za") or shutil.which("7zz")


def seven_zip_check(path, ci_name, expect_xml):
    """7-Zip (what Omnibus's retag extracts CBZ files with) must read the archive without warnings and
    give the expected ComicInfo.xml. None when fine or when 7-Zip is not installed."""
    if not SEVEN_ZIP:
        return None
    try:
        # A listing reads the index and end record only (7z t would decompress every page): it is where
        # 7-Zip reports "There are data after the end of archive".
        t = subprocess.run([SEVEN_ZIP, "l", "-slt", path], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        out = t.stdout + t.stderr
        if t.returncode != 0 or "WARNING" in out.upper() or "after the end" in out.lower():
            return "check failed: 7-Zip warns: " + " ".join(l.strip() for l in out.splitlines() if l.strip() and ("WARN" in l.upper() or "rror" in l or "after the end" in l))[:160]
        # 2026-11-21: 7-Zip also lists a record no index mentions (an old ComicInfo.xml left before the
        # pages); Omnibus's retag then finds an extra file. 7-Zip must list exactly the archive's members.
        listed = sum(1 for l in out.split("\n----------\n", 1)[-1].splitlines() if l.startswith("Path = "))
        with zipfile.ZipFile(path) as z:
            members = len(z.infolist())
        if listed != members:
            return f"check failed: 7-Zip lists {listed} files, the archive has {members}"
        x = subprocess.run([SEVEN_ZIP, "x", "-so", path, ci_name], capture_output=True, timeout=120)
        if x.returncode != 0 or x.stdout != expect_xml:
            return "check failed: 7-Zip extracts a different ComicInfo.xml"
    except Exception as e:
        return f"check failed: 7-Zip: {e}"
    return None


def appended_layout(path):
    """True when the archive still carries an earlier end record before its ComicInfo.xml (first `write`)."""
    with zipfile.ZipFile(path) as z:
        ci = root_comicinfo(z)
        if ci is None:
            return False
        off = ci.header_offset
    with open(path, "rb") as f:
        return end_record_ending_at(f, off) is not None


LAST_ENDING = {}   # path -> the bytes rewrite_ending replaced (kept in endings_backup by write)


def append_store_date(path, d, replace=None):
    """Add <StoreDate> to the archive at path, in place (or, with replace, change that wrong StoreDate
    to d, or remove it when d is None). None on success, else the reason (file unchanged)."""
    with zipfile.ZipFile(path) as z:
        ci = root_comicinfo(z)
        if ci is None:
            return "no single ComicInfo.xml Omnibus would read"
        try:
            xml = z.read(ci).decode("utf-8")
        except UnicodeDecodeError:
            return "ComicInfo.xml is not UTF-8"
        before = [(i.filename, i.CRC, i.file_size, i.header_offset) for i in z.infolist()]
    new_xml = replace_store_date(xml, replace, d) if replace else add_store_date(xml, d)
    if new_xml is None:
        return "ComicInfo.xml not safe to edit (encoding, existing StoreDate or structure)"
    data = new_xml.encode("utf-8")
    reason, backup = rewrite_ending(path, ci, data,
        lambda p: verify_append(p, before, ci.filename, d, data) or seven_zip_check(p, ci.filename, data))
    if reason:
        return reason
    LAST_ENDING[path] = backup
    return None


def verify_append(path, before, ci_name, d, data=None):
    """Same members in the same order; every other member's CRC, size and position unchanged; the date reads
    back (and, with data, ComicInfo.xml is exactly that)."""
    try:
        with zipfile.ZipFile(path) as z:
            after = z.infolist()
            if [i.filename for i in after] != [b[0] for b in before]:
                return "check failed: member list changed"
            for (name, crc, fsize, off), i in zip(before, after):
                if name == ci_name:
                    got = z.read(i)
                    if comicinfo_store_date(got.decode("utf-8")) != d or (data is not None and got != data):
                        return "check failed: StoreDate not read back"
                elif (crc, fsize, off) != (i.CRC, i.file_size, i.header_offset):
                    return f"check failed: {name} changed"
    except Exception as e:
        return f"check failed: {e}"
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
    redo = {r[0]: r[1] for r in st.execute("SELECT book_id, bad_date FROM redo")}
    rows = st.execute(f"""SELECT d.* FROM dates d LEFT JOIN written w USING (book_id)
                         WHERE (d.store_date IS NOT NULL OR d.book_id IN (SELECT book_id FROM redo))
                           AND (w.result IS NULL OR w.result NOT IN ({','.join('?' * len(done))}))
                         ORDER BY d.path""", done).fetchall()
    rows = [r for r in rows if series_ids is None or r["series_id"] in series_ids]
    if args.limit:
        rows = rows[:args.limit]
    log(f"{len(rows)} books to {'check (dry run)' if args.dry_run else 'write'}")
    rw = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    if not rows:
        if not args.dry_run:
            sync_db(rw, st)
            mark_for_rescan(rw, st)
        return
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
            result = write_one(db, r, args.dry_run, redo.get(r["book_id"]))
            counts[result] = counts.get(result, 0) + 1
            st.execute("INSERT OR REPLACE INTO written VALUES (?,?,?,?,?)",
                       (r["book_id"], r["path"], r["store_date"], result, datetime.now().isoformat(timespec="seconds")))
            if result == "written" and r["book_id"] in redo:
                st.execute("DELETE FROM redo WHERE book_id = ?", (r["book_id"],))
            save_ending(st, r["book_id"], r["path"])
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
    if not args.dry_run:
        sync_db(rw, st)
        mark_for_rescan(rw, st)


def sync_db(rw, st):
    """Save in Omnibus's database what a library scan would save for each written book, so the scan
    finds it unchanged and keeps its cover thumbnail (2026-11-20: the scan treated the 31k edited files
    as replaced and rebuilt every thumbnail). Same fields the scanner's upsert replaces for a changed
    file (scannerState.js BOOK_UPSERT): comicinfo, file_mtime (floor of mtimeMs), file_size,
    last_scanned; issue number, title, Comic Vine ID and sort order stay as they are. Only for a book
    whose file still holds the date we wrote and whose path is unchanged; the root ComicInfo.xml is read
    from the file itself, the same member Omnibus's reader picks."""
    rows = st.execute("SELECT book_id, path, store_date FROM written WHERE result = 'written'").fetchall()
    synced = already = skipped = 0
    for r in rows:
        cur = rw.execute("SELECT path, comicinfo FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
        if not cur or cur[0] != r["path"]:
            skipped += 1
            continue
        if comicinfo_store_date(cur[1]) == r["store_date"]:
            already += 1
            continue
        try:
            st_before = os.stat(r["path"])
            with zipfile.ZipFile(r["path"]) as z:
                ci = root_comicinfo(z)
                xml = z.read(ci).decode("utf-8") if ci else None
            st_after = os.stat(r["path"])
        except Exception:
            skipped += 1
            continue
        if not xml or comicinfo_store_date(xml) != r["store_date"] \
                or (st_before.st_mtime_ns, st_before.st_size) != (st_after.st_mtime_ns, st_after.st_size):
            skipped += 1
            continue
        rw.execute("UPDATE scanned_books SET comicinfo = ?, file_mtime = ?, file_size = ?, last_scanned = CURRENT_TIMESTAMP "
                   "WHERE id = ? AND path = ?", (xml, st_after.st_mtime_ns // 1_000_000, st_after.st_size, r["book_id"], r["path"]))
        synced += 1
        if synced % 2000 == 0:
            log(f"  saved {synced} books in Omnibus's database…")
    log(f"Omnibus's database: {synced} books saved now, {already} already had the date, {skipped} left for a library scan")
    return synced


def cmd_sync_db(args):
    rw = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    sync_db(rw, state_db())
    mark_for_rescan(rw, state_db())


def mark_for_rescan(rw, st):
    """Make the next library scan re-read every folder holding a written book Omnibus has not re-read yet.
    The scanner skips a series folder whose modified time and file count are unchanged
    (libraryScanner.js), and an in-place edit changes neither; dir_mtime = -1 is the scanner's own
    "scan this folder again" mark (it uses it for deferred folders). 2026-11-20."""
    ids = [r[0] for r in st.execute("SELECT book_id FROM written WHERE result = 'written'")]
    series = set()
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        series.update(r[0] for r in rw.execute(
            f"SELECT DISTINCT series_id FROM scanned_books WHERE id IN ({','.join('?' * len(part))}) "
            "AND (comicinfo IS NULL OR instr(comicinfo, '<StoreDate>') = 0)", part))
    series.discard(None)
    if not series:
        log("Omnibus has every written book's new tags; no library scan needed for them.")
        return
    for sid in series:
        rw.execute("UPDATE scanned_series SET dir_mtime = -1 WHERE id = ?", (sid,))
    log(f"{len(series)} series folders marked for the next library scan. Run a library scan in Omnibus so it reads the new tags.")


def write_one(db, r, dry_run, bad=None):
    """bad: the wrong StoreDate this book's file carries (redo); it is replaced by r's date, or removed."""
    book = db.execute("SELECT path, comicinfo FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
    if not book:
        return "skipped: book no longer in the library"
    path = book["path"]
    if path != r["path"]:
        return "skipped: book moved since collect (run collect again)"
    has = comicinfo_store_date(book["comicinfo"])
    if bad and has != bad:
        bad = None if not has else bad
        if has:
            return "skipped: StoreDate is neither the wrong one nor ours"
    if has and not bad:
        return "skipped: already has StoreDate"
    if bad and r["store_date"] == bad:
        return "written"                                  # the date was right after all (confirmed)
    if not r["store_date"] and not bad:
        return "skipped: no date"
    try:
        before = os.stat(path)
    except OSError:
        return "skipped: file missing"
    if dry_run:
        # Same edit on a copy in /tmp; the library file is not touched.
        copy = os.path.join(tempfile.gettempdir(), f"storedate-{os.getpid()}.cbz")
        try:
            shutil.copyfile(path, copy)
            reason = append_store_date(copy, r["store_date"], bad)
            return "skipped: " + reason if reason else "dry-run ok"
        except Exception as e:
            return f"error: {e}"
        finally:
            if os.path.exists(copy):
                os.remove(copy)
    try:
        now = os.stat(path)
        if (now.st_mtime_ns, now.st_size) != (before.st_mtime_ns, before.st_size):
            return "skipped: file changed while writing"
        reason = append_store_date(path, r["store_date"], bad)
        return "skipped: " + reason if reason else "written"
    except Exception as e:
        return f"error: {e}"


# ─── probe ───────────────────────────────────────────────────────────

def cmd_probe(args):
    """What Metron's issue list holds for each series and how it matches the books (a few Metron calls)."""
    c = Collector(argparse.Namespace(no_metron=False, no_cv=True, retry_missing=False, metron_budget=None, metron_reserve=None))
    if c.metron is None:
        log("No Metron token")
        return
    for s in select_series(c.db, args.series, None):
        mid = c.metron_series_id(s)
        c.st.commit()
        print(f"\n{s['name']} ({s['year']}) - Comic Vine volume {s['volume'] or '?'}, Metron series {mid or 'not found'}")
        if not mid:
            continue
        items, url, params = [], "issue/", {"series_id": mid}
        while url:
            page = c.mget(url, params)
            if page is None:
                print("  Metron request failed")
                break
            items += page.get("results") or []
            url, params = page.get("next"), None
        print(f"  Metron issues {len(items)}; with cv_id {sum(1 for i in items if i.get('cv_id'))}; "
              f"with store_date {sum(1 for i in items if valid_date(i.get('store_date') or ''))}")
        if items:
            first = items[0]
            print(f"  fields: {', '.join(sorted(first.keys()))}")
            print(f"  first: number {first.get('number')!r}, store_date {first.get('store_date')!r}, "
                  f"cover_date {first.get('cover_date')!r}, cv_id {first.get('cv_id')!r}")
        books = [b for b in books_of(c.db, s["id"]) if writable(b)]
        found = c.from_metron(s, books) if items else {}
        print(f"  books {len(books)}; dated by Metron's list {len(found)}")
        for b in books[:3]:
            print(f"    {b['filename']}: number {b['issue_number']!r}, cv {b['cv_issue_id']} -> {found.get(b['id'], ('-',))[0]}")
    print(f"\nMetron calls: {c.calls['metron']}")


# ─── wiki-probe (2026-11-20) ─────────────────────────────────────────
# Trial of the DC Database / Marvel Database wikis (Fandom, MediaWiki API) as a third date source for
# older books: print the start of each page's wikitext so the date fields can be read.
WIKIS = {"dc": "https://dc.fandom.com/api.php", "marvel": "https://marvel.fandom.com/api.php"}
WIKI_UA = "Omnibus/1.0 (personal comic library app; one-time store-date trial)"


def wiki_pages(wiki, titles):
    """Wikitext of up to 50 pages in one request: {title: text or None}. Redirects followed."""
    import requests
    r = requests.get(WIKIS[wiki], timeout=30, headers={"User-Agent": WIKI_UA}, params={
        "action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main", "redirects": 1,
        "titles": "|".join(titles[:50]), "format": "json", "formatversion": 2, "maxlag": 5})
    r.raise_for_status()
    q = r.json().get("query", {})
    out = {}
    for p in q.get("pages", []):
        revs = p.get("revisions") or []
        out[p.get("title")] = revs[0]["slots"]["main"]["content"] if revs else None
    return out, q.get("redirects", []), q.get("normalized", [])


MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                         "september", "october", "november", "december"], 1)}


def wiki_field(text, name):
    """A template field's value, without editors' notes (<!-- GCD -->) or references (2026-11-20: a note
    after "Day = 5" hid every such DC date)."""
    m = re.search(r"^\|\s*" + re.escape(name) + r"\s*=\s*(.*?)\s*$", text or "", re.M)
    if not m:
        return ""
    v = re.sub(r"<!--.*?-->", "", m.group(1))
    v = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", v)
    return v.strip()


def dc_published(text):
    """DC Database: Pubyear-Pubmonth-Day when all three are given (the Grand Comics Database's published
    date, recorded on the page), else None."""
    y, mo, d = wiki_field(text, "Pubyear"), month_num(wiki_field(text, "Pubmonth")), wiki_field(text, "Day")
    if y.isdigit() and mo and d.isdigit():
        return valid_date(f"{int(y):04d}-{mo:02d}-{int(d):02d}")
    return None


def cover_close(a, b, months=2):
    """Two (year, month) cover dates at most `months` apart (databases differ, e.g. Comic Vine Dec 1990
    vs the Grand Comics Database Oct 1990 for Hawk and Dove Annual #1)."""
    return bool(a and b) and abs((a[0] * 12 + a[1]) - (b[0] * 12 + b[1])) <= months


def month_num(v):
    v = str(v or "").strip().lower()
    return int(v) if v.isdigit() and 1 <= int(v) <= 12 else MONTHS.get(v)


def parse_long_date(v):
    """'February 4, 1964' / '4 February 1964' / '1964-02-04' -> '1964-02-04' or None."""
    v = re.sub(r"<[^>]*>|\[\[|\]\]|\{\{[^}]*\}\}", "", str(v or "")).strip()
    m = re.fullmatch(r"([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})", v) or None
    if m and month_num(m.group(1)):
        return valid_date(f"{m.group(3)}-{month_num(m.group(1)):02d}-{int(m.group(2)):02d}")
    m = re.fullmatch(r"(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})", v)
    if m and month_num(m.group(2)):
        return valid_date(f"{m.group(3)}-{month_num(m.group(2)):02d}-{int(m.group(1)):02d}")
    return valid_date(v)


def wiki_cover(text):
    y, mo = wiki_field(text, "Year"), month_num(wiki_field(text, "Month"))
    return (int(y), mo) if y.isdigit() and mo else None


def plausible_date(xml, d):
    """A store date sits from about a month after to a year before the cover month (2026-11-21: 0.3% of
    the backfill fell outside, nearly all another series' issue: Buffy (1998) dated 2011, Black Panther
    (2023) #4 dated 2026-12). No cover month: accepted."""
    cov = book_cover(xml)
    if not d or not cov:
        return True
    lead = (cov[0] * 12 + cov[1]) - (int(d[:4]) * 12 + int(d[5:7]))
    return -3 <= lead <= 12


def book_cover(xml):
    y = re.search(r"<Year>\s*(\d{4})\s*</Year>", xml or "")
    mo = re.search(r"<Month>\s*(\d{1,2})\s*</Month>", xml or "")
    return (int(y.group(1)), int(mo.group(1))) if y and mo else None


def wiki_rendered_date(wiki, title):
    """The page's own 'published on <date>' sentence (one request)."""
    import requests
    r = requests.get(WIKIS[wiki], timeout=30, headers={"User-Agent": WIKI_UA}, params={
        "action": "parse", "page": title, "prop": "text", "format": "json", "formatversion": 2, "maxlag": 5})
    if not r.ok:
        return None
    html = (r.json().get("parse") or {}).get("text") or ""
    text = re.sub(r"<[^>]+>", "", html)
    m = re.search(r"(?:published|released) on ([A-Z][a-z]+ \d{1,2}, \d{4})", text)
    return parse_long_date(m.group(1)) if m else None


def cmd_wiki_trial(args):
    """Report only: how the wiki's dates compare with what collect found. Nothing is stored."""
    db, st = app_db(), state_db()
    found = {r["book_id"]: (r["store_date"], r["source"]) for r in st.execute("SELECT book_id, store_date, source FROM dates")}
    pace = lambda: time.sleep(1.0)
    requests_made = 0
    for s in select_series(db, args.series, None):
        books = [b for b in books_of(db, s["id"]) if b["comicinfo"] and not b["is_special"]
                 and "annual" not in b["filename"].lower() and book_cover(b["comicinfo"])]
        number = lambda b: norm_number(re.search(r"<Number>\s*([^<]*)</Number>", b["comicinfo"]).group(1)
                                       if re.search(r"<Number>", b["comicinfo"]) else b["issue_number"])
        print(f"\n### {s['name']} ({s['year']}): {len(books)} regular issues with a cover date")
        if not books:
            continue
        # Find the volume with plain-numbered issues (not 87.1, 1/2 or lettered ones): up to 3 books, Vol 1-10 each.
        plain = sorted((b for b in books if re.fullmatch(r"\d+", number(b))), key=lambda b: int(number(b)))
        name = args.wiki_name or s["name"]
        vol = None
        for probe in (plain[len(plain) // 2:len(plain) // 2 + 1] + plain[:1] + plain[-1:])[:3] or books[:1]:
            cands = [f"{name} Vol {n} {number(probe)}" for n in range(1, 11)]
            pages, _, _ = wiki_pages(args.wiki, cands); requests_made += 1; pace()
            for n in range(1, 11):
                text = next((t for title, t in pages.items() if title and title.lower() == cands[n - 1].lower()), None)
                if text and wiki_cover(text) == book_cover(probe["comicinfo"]):
                    vol = n
                    break
            if vol:
                break
        if not vol:
            print(f"  no wiki volume of '{name}' matched by issue number and cover month; tried Vol 1-10")
            continue
        print(f"  wiki volume: {name} Vol {vol}")
        rows = []
        for i in range(0, len(books), 50):
            part = books[i:i + 50]
            titles = {f"{name} Vol {vol} {number(b)}": b for b in part}
            pages, redirects, normalized = wiki_pages(args.wiki, list(titles)); requests_made += 1; pace()
            alias = {x["to"].lower(): x["from"] for x in normalized + redirects}
            for title, text in pages.items():
                key = next((t for t in titles if t.lower() == (title or "").lower()), None) or alias.get((title or "").lower())
                key = alias.get(key.lower(), key) if key else None
                b = titles.get(key) if key else None
                if not b or not text:
                    continue
                cover_ok = wiki_cover(text) == book_cover(b["comicinfo"])
                release = parse_long_date(wiki_field(text, "ReleaseDate"))
                day = wiki_field(text, "Day")
                rows.append({"b": b, "title": title, "cover_ok": cover_ok, "release": release,
                             "day": int(day) if day.isdigit() else None, "cover": wiki_cover(text)})
        matched = [r for r in rows if r["cover_ok"]]
        print(f"  pages found {len(rows)}; cover month matches the book {len(matched)}; with ReleaseDate {sum(1 for r in matched if r['release'])}; with Day {sum(1 for r in matched if r['day'])}")
        if args.wiki == "dc":
            sample = [r for r in matched if r["day"]][:args.rendered]
            for r in sample:
                r["release"] = wiki_rendered_date(args.wiki, r["title"]); requests_made += 1; pace()
            offs = [(r["cover"][0] * 12 + r["cover"][1]) - (int(r["release"][:4]) * 12 + int(r["release"][5:7]))
                    for r in sample if r["release"]]
            print(f"  DC 'published on' read for {len(sample)} pages; months before the cover month: "
                  + ", ".join(f"{k}: {offs.count(k)}" for k in sorted(set(offs))))
        diffs, fill = [], 0
        for r in matched:
            if not r["release"]:
                continue
            have = found.get(r["b"]["id"])
            if have and have[0]:
                d = (date.fromisoformat(r["release"]) - date.fromisoformat(have[0])).days
                diffs.append((d, r, have))
            else:
                fill += 1
        if diffs:
            ds = sorted(d for d, _, _ in diffs)
            same_week = sum(1 for d in ds if abs(d) <= 3)
            print(f"  compared with collect's dates: {len(ds)} books; wiki minus ours in days: min {ds[0]}, median {ds[len(ds)//2]}, max {ds[-1]}; within 3 days {same_week}")
            for d, r, have in sorted(diffs, key=lambda x: -abs(x[0]))[:5]:
                print(f"    {os.path.basename(r['b']['path'])}: wiki {r['release']} vs {have[1]} {have[0]} ({d:+d} days)")
        print(f"  books without a date that the wiki would date: {fill}")
        for r in [r for r in matched if r["release"] and not (found.get(r["b"]["id"]) or (None,))[0]][:3]:
            print(f"    e.g. {os.path.basename(r['b']['path'])}: {r['release']} ({r['title']})")
    print(f"\nWiki requests: {requests_made}")


# ─── collect-wiki (2026-11-20) ───────────────────────────────────────
# Third source for books neither Comic Vine nor Metron could date: the Marvel Database and DC Database
# wikis (Fandom). Trial 2026-11-20: Marvel's ReleaseDate matched Comic Vine's store date exactly for
# 13 of 16 books; DC's "published on" date was 0-2 days after Comic Vine's for 5 of 5 (a shipping
# date, same week). User: wiki dates go into StoreDate like the others; their source stays recorded
# here. Only books without a date; a book's wiki page is found from its own ComicInfo series name,
# number and cover month (the page's cover month and year must equal the book's).
WIKI_PUBLISHERS = [("marvel", re.compile(r"\bmarvel\b|\bepic\b|\bicon\b|\bmax comics\b|\bmalibu\b", re.I)),
                   ("dc", re.compile(r"\bdc\b|\bvertigo\b|\bwildstorm\b|\bdc comics\b|\bmilestone\b|\bzuda\b", re.I))]


def ci_value(xml, tag):
    m = re.search(rf"<{tag}>\s*([^<]*?)\s*</{tag}>", xml or "")
    return m.group(1).replace("&amp;", "&").strip() if m else ""


def book_wiki(b):
    pub = ci_value(b["comicinfo"], "Publisher") + " " + ci_value(b["comicinfo"], "Imprint")
    for wiki, rx in WIKI_PUBLISHERS:
        if rx.search(pub):
            return wiki
    path = b["path"].replace("\\", "/")
    if "/Marvel Comics/" in path:
        return "marvel"
    if "/DC Comics/" in path or "/Vertigo/" in path:
        return "dc"
    return None


class WikiClient:
    """One request a second; a refusal or server error waits (Retry-After or a minute) and stops the run
    after three in a row."""
    def __init__(self):
        self.last, self.fails, self.requests = 0.0, 0, 0

    def _wait(self):
        gap = self.last + 1.0 - time.time()
        if gap > 0:
            time.sleep(gap)
        self.last = time.time()

    def get(self, wiki, params):
        """MediaWiki's "maxlag" answer (HTTP 200 with error code maxlag and Retry-After: the wiki's
        servers are behind) is a request to pause, not a refusal: waited out, up to 30 in a row
        (2026-11-20: three of them stopped the first full run). Other errors count toward stopping."""
        import requests
        lagged = 0
        while True:
            self._wait()
            self.requests += 1
            r, err, code = None, "", ""
            try:
                r = requests.get(WIKIS[wiki], timeout=30, headers={"User-Agent": WIKI_UA},
                                 params={**params, "format": "json", "formatversion": 2, "maxlag": 5})
                data = r.json() if "json" in r.headers.get("content-type", "") else {}
            except Exception as e:
                data, err = {}, str(e)
            if isinstance(data.get("error"), dict):
                code = str(data["error"].get("code") or "")
            if r is not None and r.ok and not code:
                self.fails = 0
                return data
            try:
                wait = max(5, min(int(r.headers.get("Retry-After", 60)), 600)) if r is not None else 60
            except ValueError:
                wait = 60
            if code == "maxlag" and lagged < 30:
                lagged += 1
                if lagged in (1, 10, 20):
                    log(f"  wiki: its servers are lagging (maxlag); pausing {wait} s at a time")
                time.sleep(wait)
                continue
            self.fails += 1
            what = f"error {code}: {data['error'].get('info', '')[:120]}" if code else (f"HTTP {r.status_code}" if r is not None else err)
            log(f"  wiki: {what}; waiting {wait} s")
            if self.fails >= 3:
                raise RuntimeError("the wiki refused or failed three times in a row; run collect-wiki again later (progress is kept)")
            time.sleep(wait)

    def pages(self, wiki, titles):
        d = self.get(wiki, {"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
                            "redirects": 1, "titles": "|".join(titles)})
        q = d.get("query", {})
        back = {}
        for x in q.get("normalized", []) + q.get("redirects", []):
            back[x["to"]] = back.get(x["from"], x["from"])
        out = {}
        for p in q.get("pages", []):
            revs = p.get("revisions") or []
            asked = back.get(p.get("title"), p.get("title"))
            out[asked] = revs[0]["slots"]["main"]["content"] if revs else None
        return out

    def published_on(self, wiki, title):
        d = self.get(wiki, {"action": "parse", "page": title, "prop": "text"})
        text = re.sub(r"<[^>]+>", "", (d.get("parse") or {}).get("text") or "")
        m = re.search(r"(?:published|released) on ([A-Z][a-z]+ \d{1,2}, \d{4})", text)
        return parse_long_date(m.group(1)) if m else None


def cmd_collect_wiki(args):
    db, st = app_db(), state_db()
    st.executescript("""CREATE TABLE IF NOT EXISTS wiki_tried (book_id TEXT PRIMARY KEY, wiki TEXT, result TEXT, at TEXT);
                        CREATE TABLE IF NOT EXISTS wiki_volumes (wiki TEXT, name TEXT, cover_year INTEGER, vol INTEGER, PRIMARY KEY (wiki, name, cover_year)); -- cover_year: the ComicInfo Volume (start year)""")
    if "page" not in [r[1] for r in st.execute("PRAGMA table_info(wiki_volumes)")]:
        st.execute("ALTER TABLE wiki_volumes ADD COLUMN page TEXT")  # the wiki's title for the series
    retry = ("no Day", "no published-on date", "cover month differs", "no ReleaseDate", "no volume") if args.retry else ()
    tried = {r[0] for r in st.execute("SELECT book_id, result FROM wiki_tried") if r[1] not in retry}
    rows = st.execute("SELECT book_id FROM dates WHERE store_date IS NULL").fetchall()
    ids = [r[0] for r in rows if r[0] not in tried]
    books = []
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        books += db.execute(f"""SELECT b.id, b.series_id, b.path, b.filename, b.issue_number, b.comicinfo, b.is_special
            FROM scanned_books b WHERE b.id IN ({','.join('?' * len(part))})""", part).fetchall()
    groups = {}
    for b in books:
        wiki = book_wiki(b)
        if not wiki or (args.wiki and wiki != args.wiki) or not book_cover(b["comicinfo"]):
            continue
        name = ci_value(b["comicinfo"], "Series")
        number = norm_number(ci_value(b["comicinfo"], "Number") or b["issue_number"])
        if not name or not number:
            continue
        vy = ci_value(b["comicinfo"], "Volume")
        # Without a Volume year, keep runs of the same name apart by their Omnibus series folder.
        groups.setdefault((wiki, name, vy if vy.isdigit() else "", "" if vy.isdigit() else b["series_id"]), []).append((number, b))
    keys = sorted(groups, key=lambda k: (k[0], k[1].lower(), k[2]))
    if args.max_series:
        keys = keys[:args.max_series]
    log(f"{sum(len(groups[k]) for k in keys)} undated books in {len(keys)} series on the wikis "
        f"({sum(1 for k in keys if k[0] == 'marvel')} Marvel, {sum(1 for k in keys if k[0] == 'dc')} DC)")
    w = WikiClient()
    dated = {"marvel": 0, "dc": 0}
    now = lambda: datetime.now().isoformat(timespec="seconds")
    try:
        for n, key in enumerate(keys, 1):
            wiki, name, volume_year, folder = key
            items = groups[key]
            vol, page = wiki_volume(w, st, wiki, name, volume_year or f"folder:{folder}", items, retry=args.retry)
            found = 0
            if vol:
                for i in range(0, len(items), 50):
                    part = items[i:i + 50]
                    titles = {f"{page} Vol {vol} {num}": b for num, b in part}
                    pages = w.pages(wiki, list(titles))
                    for title, b in titles.items():
                        text = next((t for k, t in pages.items() if k and k.lower() == title.lower()), None)
                        d, why = None, "no page"
                        if text:
                            # The volume is confirmed by an exact cover match (wiki_volume), so a page of
                            # that volume with this number is this issue; covers may differ by up to two
                            # months between databases.
                            if not cover_close(wiki_cover(text), book_cover(b["comicinfo"])):
                                why = "cover month differs"
                            elif wiki == "marvel":
                                d = parse_long_date(wiki_field(text, "ReleaseDate"))
                                why = "dated" if d else "no ReleaseDate"
                            elif dc_published(text):
                                d, why = dc_published(text), "dated"
                            elif wiki_field(text, "Day").isdigit():
                                d = w.published_on(wiki, title)
                                why = "dated (page sentence)" if d else "no published-on date"
                            else:
                                why = "no Day"
                        if d:
                            st.execute("UPDATE dates SET store_date = ?, source = ?, checked_at = ? WHERE book_id = ?",
                                       (d, f"{wiki}_wiki", now(), b["id"]))
                            found += 1
                        st.execute("INSERT OR REPLACE INTO wiki_tried VALUES (?,?,?,?)", (b["id"], wiki, why, now()))
                    st.commit()
            else:
                for _, b in items:
                    st.execute("INSERT OR REPLACE INTO wiki_tried VALUES (?,?,?,?)", (b["id"], wiki, "no volume", now()))
                st.commit()
            dated[wiki] += found
            log(f"[{n}/{len(keys)}] {wiki}: {name} ({volume_year or '?'}): {len(items)} undated, "
                f"{found} dated{'' if vol else ' (no wiki volume matched)'} | wiki requests {w.requests}")
    except (RuntimeError, KeyboardInterrupt) as e:
        log(f"Stopped: {e or 'interrupted'}; progress kept")
    log(f"Dated from the wikis: Marvel {dated['marvel']}, DC {dated['dc']}. Wiki requests: {w.requests}")
    log("Next: write (adds StoreDate to these books and saves them in Omnibus's database).")


# Titles the wikis use for series ComicInfo names differently (spot check 2026-11-21).
WIKI_ALIASES = {"mighty thor": ["Thor"], "mighty thor annual": ["Thor Annual"],
                "peter parker, the spectacular spider-man": ["Spectacular Spider-Man"],
                "peter parker, the spectacular spider-man annual": ["Spectacular Spider-Man Annual"]}


def wiki_names(name):
    """Page-title spellings to try: as written, without a leading "The" (the Marvel Database titles
    "The Incredible Hulk" as "Incredible Hulk"), with an inner "the" capitalised, and known aliases."""
    base = re.sub(r"(?i)^the\s+", "", name).strip()
    out = [name, base, re.sub(r"\bthe\b", "The", base)] + WIKI_ALIASES.get(base.lower(), [])
    return list(dict.fromkeys(n for n in out if n))


def wiki_volume(w, st, wiki, name, volume_year, items, retry=False):
    """The wiki volume number holding these books (one ComicInfo Series + Volume): tries Vol 1-10 for up to
    three plain-numbered books; remembered per series name and start year."""
    # Remembered per name and start year, or per name and Omnibus series folder when the year is unknown.
    key_year = int(volume_year) if str(volume_year).isdigit() else 0
    key_name = name if key_year else f"{name}|{volume_year}"
    row = st.execute("SELECT vol, page FROM wiki_volumes WHERE wiki = ? AND name = ? AND cover_year = ?", (wiki, key_name, key_year)).fetchone()
    if row and (row[0] or not retry):
        return row[0], row[1] or name
    plain = sorted((x for x in items if re.fullmatch(r"\d+", x[0])), key=lambda x: int(x[0]))
    probes = (plain[len(plain) // 2:len(plain) // 2 + 1] + plain[:1] + plain[-1:])[:3] or items[:1]
    vol, page = None, name
    for num, b in probes:
        cands = [(n, v, f"{n} Vol {v} {num}") for n in wiki_names(name) for v in range(1, 11)]
        pages = {}
        for i in range(0, len(cands), 50):
            pages.update(w.pages(wiki, [c[2] for c in cands[i:i + 50]]))
        for n, v, title in cands:
            text = next((t for k, t in pages.items() if k and k.lower() == title.lower()), None)
            if text and wiki_cover(text) == book_cover(b["comicinfo"]):
                vol, page = v, n
                break
        if vol:
            break
    st.execute("INSERT OR REPLACE INTO wiki_volumes (wiki, name, cover_year, vol, page) VALUES (?,?,?,?,?)",
               (wiki, key_name, key_year, vol, page))
    st.commit()
    return vol, page


def cmd_scan_check(args):
    """Why a library scan is slow on written books: for a sample, whether the scanner (Node) would see the
    file as unchanged, and whether its cover thumbnail exists (the scanner rebuilds a missing one)."""
    st = state_db()
    rows = st.execute("SELECT book_id FROM written WHERE result = 'written' ORDER BY random() LIMIT ?", (args.sample,)).fetchall()
    ids = [r[0] for r in rows]
    js = r"""
const b = process.argv[1], ids = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const D = require(b + '/node_modules/better-sqlite3'), fs = require('fs'), path = require('path');
const db = new D(process.env.DB_PATH, { readonly: true });
const thumbs = path.join(path.dirname(process.env.DB_PATH), 'thumbcache');
const has = id => ['.jpg', '.jpeg', '.png', '.webp', '.gif'].some(e => { try { return fs.statSync(path.join(thumbs, id + e)).size > 0; } catch { return false; } });
const out = { unchanged: 0, changed: 0, missing_file: 0, thumb_present: 0, thumb_missing: 0, examples: [] };
for (const id of ids) {
  const r = db.prepare('SELECT path, file_mtime, file_size FROM scanned_books WHERE id = ?').get(id);
  if (!r) continue;
  let s; try { s = fs.statSync(r.path); } catch { out.missing_file++; continue; }
  const same = Math.floor(s.mtimeMs) === r.file_mtime && s.size === r.file_size;
  same ? out.unchanged++ : out.changed++;
  if (!same && out.examples.length < 3) out.examples.push({ path: r.path, db: [r.file_mtime, r.file_size], file: [Math.floor(s.mtimeMs), s.size, s.mtimeMs] });
  has(id) ? out.thumb_present++ : out.thumb_missing++;
}
console.log(JSON.stringify(out, null, 1));
"""
    backend = os.path.join(HERE, "..", "backend")
    res = subprocess.run(["node", "-e", js, backend], input=json.dumps(ids), capture_output=True, text=True, timeout=300,
                         env={**os.environ, "DB_PATH": DB_PATH})
    print(res.stdout or res.stderr)


def cmd_unmark_scan(args):
    """Undo mark_for_rescan where it is no longer needed: for series folders holding written books that
    Omnibus's database already has (sync-db), set scanned_series.dir_mtime back to the folder's real
    modified time (Node's Math.floor(mtimeMs), as libraryScanner.js compares it) so a scan skips the
    folder again, as before the write. Only while the folder's comic-file count still matches the
    stored one; only folders marked -1 that hold written books, and only when none of their written
    books still lacks the date in the database. 2026-11-20: the marks made the scan enter 2,293
    folders and build every missing cover thumbnail (about half were missing)."""
    st = state_db()
    rw = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    ids = [r[0] for r in st.execute("SELECT book_id FROM written WHERE result = 'written'")]
    series, pending = set(), set()
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        for sid, has in rw.execute(f"SELECT series_id, instr(comicinfo, '<StoreDate>') > 0 FROM scanned_books "
                                   f"WHERE id IN ({','.join('?' * len(part))})", part):
            (series if has else pending).add(sid)
    marked = {r[0]: r[1] for r in rw.execute("SELECT id, path FROM scanned_series WHERE dir_mtime = -1")}
    todo = [(sid, marked[sid]) for sid in series - pending if sid in marked]
    js = r"""
const b = process.argv[1], items = JSON.parse(require('fs').readFileSync(0, 'utf8'));   // list on stdin (too long for arguments)
const D = require(b + '/node_modules/better-sqlite3'), fs = require('fs');
const db = new D(process.env.DB_PATH);
const EXT = /\.(cbz|cbr|zip|rar|pdf)$/i;   // libraryScanner.js COMIC_EXTS (server.js)
let reset = 0, skipped = 0;
const upd = db.prepare('UPDATE scanned_series SET dir_mtime = ? WHERE id = ? AND dir_mtime = -1 AND dir_file_count = ?');
for (const [id, dir] of items) {
  try {
    const st = fs.statSync(dir);
    const count = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && EXT.test(e.name)).length;
    if (upd.run(Math.floor(st.mtimeMs), id, count).changes) reset++; else skipped++;
  } catch { skipped++; }
}
console.log(JSON.stringify({ reset, skipped }));
"""
    backend = os.path.join(HERE, "..", "backend")
    res = subprocess.run(["node", "-e", js, backend], input=json.dumps(todo), capture_output=True, text=True, timeout=600,
                         env={**os.environ, "DB_PATH": DB_PATH})
    out = (res.stdout or "").strip() or res.stderr.strip()
    log(f"Series folders marked -1: {len(marked)}; holding written books, all saved: {len(todo)}; "
        f"still waiting for a save: {len(pending & set(marked))}. Reset: {out}")


# ─── collect-gcd (2026-11-20) ────────────────────────────────────────
# Fourth source for books still without a date: the Grand Comics Database's on-sale dates, from a
# local index built from GCD's SQLite dump (gcd-index: series and non-variant, non-deleted issues with
# a complete on_sale_date; no web requests). The DC wiki's Day/Pubmonth come from GCD. Data from the
# Grand Comics Database (comics.org), Creative Commons Attribution; credited in THIRD_PARTY_NOTICES.md.
def gcd_name(s):
    s = str(s or "").lower().replace("&", " and ")
    s = re.sub(r"^the\s+", "", s.strip())
    return re.sub(r"[^a-z0-9]+", "", s)


# Series GCD files under another name (spot check 2026-11-21), keyed by gcd_name().
GCD_ALIASES = {"mightythor": "thor", "mightythorannual": "thorannual",
               "peterparkerthespectacularspiderman": "spectacularspiderman",
               "peterparkerthespectacularspidermanannual": "spectacularspidermanannual"}


def gcd_publisher_ok(book_pub, gcd_pub):
    a, b = gcd_name(book_pub), gcd_name(gcd_pub)
    if not a or not b:
        return True
    a, b = re.sub(r"(comics|comic|publishing|publications|entertainment|inc|group)", "", a), \
        re.sub(r"(comics|comic|publishing|publications|entertainment|inc|group)", "", b)
    return bool(a and b) and (a in b or b in a)


def build_gcd_index(dump, out):
    """The compact index from GCD's SQLite dump (comics.org/download)."""
    if os.path.exists(out):
        os.remove(out)
    c = sqlite3.connect(out)
    c.execute("ATTACH DATABASE ? AS g", (f"file:{os.path.abspath(dump)}?mode=ro",))
    c.executescript("""
      CREATE TABLE series AS SELECT s.id, s.name, s.year_began, p.name AS publisher, s.country_id
        FROM g.gcd_series s JOIN g.gcd_publisher p ON p.id = s.publisher_id
        WHERE s.deleted = 0 AND s.id IN (SELECT DISTINCT series_id FROM g.gcd_issue
          WHERE deleted = 0 AND variant_of_id IS NULL AND length(on_sale_date) = 10);
      CREATE TABLE issue AS SELECT series_id, number, key_date, on_sale_date
        FROM g.gcd_issue WHERE deleted = 0 AND variant_of_id IS NULL AND length(on_sale_date) = 10;
      CREATE INDEX issue_series ON issue(series_id);""")
    c.commit()
    c.execute("DETACH DATABASE g")
    c.execute("VACUUM")
    c.close()


class GcdIndex:
    def __init__(self, path):
        self.c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.series = {}
        for sid, name, year, pub in self.c.execute("SELECT id, name, year_began, publisher FROM series"):
            self.series.setdefault(gcd_name(name), []).append((sid, year, pub))
        self.issues = {}

    def issues_of(self, sid):
        if sid not in self.issues:
            out = {}
            for number, key, onsale in self.c.execute("SELECT number, key_date, on_sale_date FROM issue WHERE series_id = ?", (sid,)):
                out.setdefault(norm_number(number), []).append((key, onsale))
            self.issues[sid] = out
        return self.issues[sid]

    def date_for(self, xml):
        """(date, why) for one book from its ComicInfo: Series, Volume (start year), Number, Publisher, cover."""
        name, number = ci_value(xml, "Series"), norm_number(ci_value(xml, "Number"))
        cover, vol = book_cover(xml), ci_value(xml, "Volume")
        if not name or not number or not cover:
            return None, "incomplete ComicInfo"
        key, pub = gcd_name(name), ci_value(xml, "Publisher")
        named = [c for c in self.series.get(GCD_ALIASES.get(key, key), []) if gcd_publisher_ok(pub, c[2])]
        cands = named
        if vol.isdigit():
            # The ComicInfo start year can be a year off GCD's (Swamp Thing 1986 vs 1985).
            cands = [c for c in named if c[1] == int(vol)] or [c for c in named if abs(c[1] - int(vol)) == 1]
        if not cands:
            # GCD splits some runs into a series per year: L.E.G.I.O.N. '93.
            cands = [c for c in self.series.get(f"{key}{cover[0] % 100:02d}", []) if gcd_publisher_ok(pub, c[2])]
        if not cands:
            return None, "no series"
        found = set()
        for sid, _, _ in cands:
            for key, onsale in self.issues_of(sid).get(number, []):
                k = re.match(r"(\d{4})-(\d{2})", key or "")
                if k and cover_close((int(k.group(1)), int(k.group(2))), cover) and valid_date(onsale):
                    found.add(onsale)
        if len(found) == 1:
            return found.pop(), "dated"
        return None, "several matches" if found else "no issue with on-sale date"


def cmd_collect_gcd(args):
    db, st = app_db(), state_db()
    if args.build:
        log(f"Building the GCD index from {args.build} …")
        build_gcd_index(args.build, args.index)
    if not os.path.exists(args.index):
        log(f"No GCD index at {args.index}; build it with --build <GCD SQLite dump>")
        return
    st.execute("CREATE TABLE IF NOT EXISTS gcd_tried (book_id TEXT PRIMARY KEY, result TEXT, at TEXT)")
    tried = {r[0] for r in st.execute("SELECT book_id FROM gcd_tried")} if not args.retry else set()
    ids = [r[0] for r in st.execute("SELECT book_id FROM dates WHERE store_date IS NULL") if r[0] not in tried]
    g = GcdIndex(args.index)
    counts, now = {}, datetime.now().isoformat(timespec="seconds")
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        for b in db.execute(f"SELECT id, comicinfo FROM scanned_books WHERE id IN ({','.join('?' * len(part))})", part):
            d, why = g.date_for(b["comicinfo"] or "")
            if d:
                st.execute("UPDATE dates SET store_date = ?, source = 'gcd', checked_at = ? WHERE book_id = ?", (d, now, b["id"]))
            st.execute("INSERT OR REPLACE INTO gcd_tried VALUES (?,?,?)", (b["id"], why, now))
            counts[why] = counts.get(why, 0) + 1
        st.commit()
    log(f"GCD: {len(ids)} undated books checked: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))
    log("Next: write (adds StoreDate to these books and saves them in Omnibus's database).")


def save_ending(st, book_id, path):
    """Keep the bytes the last rewrite of `path` replaced (endings_backup), for an exact rollback."""
    b = LAST_ENDING.pop(path, None)
    if b:
        st.execute("INSERT INTO endings_backup VALUES (?,?,?,?,?,?,?,?)", (book_id, path, b["size"], b["cut"], b["tail"],
                   b["orphan"], b["orphan_name"], datetime.now().isoformat(timespec="seconds")))
        if b.get("removed") is not None:
            st.execute("INSERT INTO orphan_backup VALUES (?,?,?,?,?)", (book_id, path, b["orphan"], b["removed"],
                       datetime.now().isoformat(timespec="seconds")))


def pause_routine(rw):
    """Pause Omnibus's metadata routine and wait for its current batch: (previous paused value) or None."""
    before = rw.execute("SELECT paused FROM metadata_maintenance_control WHERE id = 1").fetchone()[0]
    rw.execute("UPDATE metadata_maintenance_control SET paused = 1 WHERE id = 1")
    log("Metadata routine paused")
    for _ in range(120):
        if not routine_running(rw):
            return before
        log("Waiting for the routine's current batch to finish…")
        time.sleep(10)
    rw.execute("UPDATE metadata_maintenance_control SET paused = ? WHERE id = 1", (before,))
    log("The routine is still running after 20 minutes; nothing changed")
    return None


def cmd_fix_endings(args):
    """2026-11-21: give every file the first `write` edited one clean ending (rewrite_ending). Until then
    7-Zip, and Omnibus's retag through it, read the archive's earlier index and its old ComicInfo.xml. The
    ComicInfo.xml with the store date is kept exactly; the pages are not moved; the replaced bytes are kept
    in endings_backup; each file is checked with Python's zip reader and 7-Zip and put back if either
    disagrees. Omnibus's database gets the new file size and time when it was in step with the file."""
    db, st = app_db(), state_db()
    rows = st.execute("SELECT book_id, path, store_date FROM written WHERE result = 'written' ORDER BY path").fetchall()
    # --shard K/N: this worker takes every Nth book from the K-th (K = 1..N), so N workers never touch
    # the same file. Workers leave the metadata routine alone: pause it before and resume it after.
    shard = None
    if args.shard:
        k, n_ = (int(x) for x in args.shard.split("/"))
        if not 1 <= k <= n_:
            raise SystemExit("--shard K/N needs 1 <= K <= N")
        rows = rows[k - 1::n_]
        shard = (k, n_)
    if args.match:
        # --match TEXT: only books whose path (as written) contains TEXT, to retry a few failures.
        want = [m.lower() for m in args.match]
        rows = [r for r in rows if any(m in (r["path"] or "").lower() for m in want)]
    if args.limit:
        rows = rows[:args.limit]
    log(f"{len(rows)} written books to check{f' (worker {shard[0]} of {shard[1]})' if shard else ''}; "
        f"7-Zip {'found: ' + SEVEN_ZIP if SEVEN_ZIP else 'NOT FOUND (only Python checks)'}")
    rw = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    paused_before = None
    if not args.dry_run and not shard:
        paused_before = pause_routine(rw)
        if paused_before is None:
            return
    counts = {}
    try:
        for n, r in enumerate(rows, 1):
            # The book's current path: a file moved or renamed since write still has the old ending.
            # (A retag rebuilds the file cleanly, usually under a new name: "already clean".)
            cur = db.execute("SELECT path FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
            path = cur["path"] if cur and cur["path"] and os.path.exists(cur["path"]) else r["path"]
            try:
                if not os.path.exists(path):
                    result = "file missing"
                elif not appended_layout(path):
                    result = "already clean"
                elif args.dry_run:
                    result = "would repair"
                else:
                    with zipfile.ZipFile(path) as z:
                        ci = root_comicinfo(z)
                        data = z.read(ci)
                        before = [(i.filename, i.CRC, i.file_size, i.header_offset) for i in z.infolist()]
                    st0 = os.stat(path)
                    d = comicinfo_store_date(data.decode("utf-8", "replace"))
                    reason, backup = rewrite_ending(path, ci, data,
                        lambda p: verify_append(p, before, ci.filename, d, data) or seven_zip_check(p, ci.filename, data))
                    if reason:
                        result = "failed: " + reason
                    else:
                        LAST_ENDING[path] = backup
                        save_ending(st, r["book_id"], path)
                        st1 = os.stat(path)
                        rw.execute("UPDATE scanned_books SET file_mtime = ?, file_size = ? WHERE id = ? AND path = ? AND file_mtime = ? AND file_size = ?",
                                   (st1.st_mtime_ns // 1_000_000, st1.st_size, r["book_id"], path, st0.st_mtime_ns // 1_000_000, st0.st_size))
                        result = "repaired"
            except Exception as e:
                result = f"error: {e}"
            counts[result] = counts.get(result, 0) + 1
            st.commit()
            if result not in ("repaired", "already clean", "would repair") or n % 500 == 0:
                log(f"[{n}/{len(rows)}] {os.path.basename(path)}: {result}")
    except KeyboardInterrupt:
        log("Stopped; progress kept (run again to continue)")
    finally:
        if paused_before is not None:
            rw.execute("UPDATE metadata_maintenance_control SET paused = ? WHERE id = 1", (paused_before,))
            log(f"Metadata routine {'left paused (it was paused before)' if paused_before else 'resumed'}")
    log("Result: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))


def cmd_fix_orphans(args):
    """2026-11-21: fix-endings left an old ComicInfo.xml that sat before the pages in place as unused bytes
    (renamed ComicInfo.old). 7-Zip still finds it by its local header and extracts it as an extra file, so
    Omnibus's retag reported "Extraction/build changed source paths or payloads". This cuts that record out
    (compact_out: the file is rewritten beside itself, checked with Python and 7-Zip, then swapped in; the
    cut bytes go to orphan_backup). Files rebuilt by a retag since then are "already clean".
    7-Zip 23 only picked up such a record at the very start of the file, but the container's 7-Zip 26 also
    extracts one between pages (Ghost Rider 088 (1997)), so every one is done (--start-only: the first kind).
    Each result must also pass Omnibus's own retag preparation (retag_check.js) before it replaces the file."""
    db, st = app_db(), state_db()
    # Each book's latest rewrite (one pass; a per-row subquery took minutes over ~50,000 rows).
    rows = st.execute("""SELECT e.book_id, e.path, e.orphan FROM endings_backup e
        JOIN (SELECT max(rowid) AS r FROM endings_backup GROUP BY book_id) m ON m.r = e.rowid
        WHERE e.orphan IS NOT NULL AND (e.orphan = 0 OR ?) ORDER BY e.path""", (0 if args.start_only else 1,)).fetchall()
    if args.match:
        want = [m.lower() for m in args.match]
        rows = [r for r in rows if any(m in (r["path"] or "").lower() for m in want)]
    # --shard K/N: this worker takes every Nth book from the K-th, so N workers never touch the same file.
    # Workers leave the metadata routine alone (pause it before, resume it after).
    shard = None
    if args.shard:
        k, n_ = (int(x) for x in args.shard.split("/"))
        if not 1 <= k <= n_:
            raise SystemExit("--shard K/N needs 1 <= K <= N")
        rows = rows[k - 1::n_]
        shard = (k, n_)
    if args.limit:
        rows = rows[:args.limit]
    if shard:
        log(f"worker {shard[0]} of {shard[1]}")
    log(f"{len(rows)} books with an old ComicInfo.xml left {'at the start of' if args.start_only else 'in'} the file; 7-Zip {'found: ' + SEVEN_ZIP if SEVEN_ZIP else 'NOT FOUND (only Python checks)'}")
    if not SEVEN_ZIP and not args.dry_run:
        raise SystemExit("7-Zip is needed to check the result; run this inside the Omnibus container")
    rw = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    paused_before = None
    if not args.dry_run and not shard:
        paused_before = pause_routine(rw)
        if paused_before is None:
            return
    counts = {}
    try:
        for n, r in enumerate(rows, 1):
            cur = db.execute("SELECT path FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
            path = cur["path"] if cur and cur["path"] and os.path.exists(cur["path"]) else r["path"]
            try:
                if not os.path.exists(path):
                    result = "file missing"
                else:
                    with zipfile.ZipFile(path) as z:
                        infos = z.infolist()
                        ci = root_comicinfo(z)
                        data = z.read(ci) if ci else None
                    start = r["orphan"]
                    with open(path, "rb") as f:
                        f.seek(start)
                        head = f.read(LOC.size)
                        name = f.read(LOC.unpack(head)[9]).lower() if len(head) == LOC.size and head[:4] == LOC_SIG else b""
                    listed = {i.header_offset for i in infos}
                    if ci is None or start in listed or not name.endswith((b"comicinfo.old", b"comicinfo.xml")):
                        result = "already clean"
                    elif args.dry_run:
                        result = "would repair"
                    else:
                        before = [(i.filename, i.CRC, i.file_size, i.header_offset) for i in infos]
                        st0 = os.stat(path)
                        reason, removed = compact_out(path, start, lambda tmp, shift: verify_compacted(
                            tmp, before, ci.filename, start, shift, data) or seven_zip_check(tmp, ci.filename, data)
                            or omnibus_retag_check(tmp))
                        if reason:
                            result = "failed: " + reason + " (file unchanged)"
                        else:
                            st.execute("INSERT INTO orphan_backup VALUES (?,?,?,?,?)", (r["book_id"], path, start, removed,
                                       datetime.now().isoformat(timespec="seconds")))
                            st1 = os.stat(path)
                            rw.execute("UPDATE scanned_books SET file_mtime = ?, file_size = ? WHERE id = ? AND path = ? AND file_mtime = ? AND file_size = ?",
                                       (st1.st_mtime_ns // 1_000_000, st1.st_size, r["book_id"], path, st0.st_mtime_ns // 1_000_000, st0.st_size))
                            result = "repaired"
            except Exception as e:
                result = f"error: {e}"
            counts[result] = counts.get(result, 0) + 1
            st.commit()
            if result not in ("repaired", "already clean", "would repair") or n % 500 == 0:
                log(f"[{n}/{len(rows)}] {os.path.basename(path)}: {result}")
    except KeyboardInterrupt:
        log("Stopped; progress kept (run again to continue)")
    finally:
        if paused_before is not None:
            rw.execute("UPDATE metadata_maintenance_control SET paused = ? WHERE id = 1", (paused_before,))
            log(f"Metadata routine {'left paused (it was paused before)' if paused_before else 'resumed'}")
    log("Result: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))


RETAG_CHECK_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "retag_check.js")


def omnibus_retag_check(path):
    """None when Omnibus's own retag preparation accepts the file (retag_check.js), else the reason."""
    if not os.path.exists(RETAG_CHECK_JS):
        return "check failed: retag_check.js is missing (copy it next to this script)"
    try:
        r = subprocess.run(["node", RETAG_CHECK_JS, path], capture_output=True, text=True, timeout=600)
        line = (r.stdout.strip().splitlines() or [""])[-1]
        res = json.loads(line) if line.startswith("{") else None
    except Exception as e:
        return f"check failed: Omnibus retag check did not run: {e}"
    if not res:
        return "check failed: Omnibus retag check gave no result: " + (r.stderr or "")[-160:]
    if res.get("ok"):
        return None
    return f"check failed: Omnibus retag: {res.get('code')}: {res.get('error')}" + (f" {json.dumps(res['explain'])}" if res.get("explain") else "")


def cmd_retag_check(args):
    """Read-only (2026-11-21): run Omnibus's own retag preparation (scripts/retag_check.js →
    metadata/archiveStaging.js) on files `write` edited, so a file counts as fixed only when Omnibus agrees.
    Pick files with --match, --orphans (an old ComicInfo.xml at the start: before and after fix-orphans),
    --sample N (random), or --all; --limit caps the count. Failures are kept in retag_check."""
    db, st = app_db(), state_db()
    st.execute("CREATE TABLE IF NOT EXISTS retag_check (book_id TEXT, path TEXT, ok INTEGER, code TEXT, error TEXT, at TEXT)")
    if args.orphans:
        rows = st.execute("""SELECT e.book_id, e.path FROM endings_backup e
            JOIN (SELECT max(rowid) AS r FROM endings_backup GROUP BY book_id) m ON m.r = e.rowid
            WHERE e.orphan IS NOT NULL ORDER BY e.path""").fetchall()
    else:
        rows = st.execute("SELECT book_id, path FROM written WHERE result = 'written' ORDER BY path").fetchall()
    if args.match:
        want = [m.lower() for m in args.match]
        rows = [r for r in rows if any(m in (r["path"] or "").lower() for m in want)]
    elif args.sample:
        import random
        rows = random.sample(rows, min(args.sample, len(rows)))
    elif not (args.all or args.orphans):
        raise SystemExit("choose files: --match TEXT, --orphans, --sample N or --all")
    if args.limit:
        rows = rows[:args.limit]
    paths, ids = [], {}
    for r in rows:
        cur = db.execute("SELECT path FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
        path = cur["path"] if cur and cur["path"] and os.path.exists(cur["path"]) else r["path"]
        paths.append(path)
        ids[path] = r["book_id"]
    script = RETAG_CHECK_JS
    log(f"{len(paths)} files; Omnibus's retag preparation ({script}), read-only")
    proc = subprocess.Popen(["node", script, "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    proc.stdin.write(json.dumps(paths))
    proc.stdin.close()
    counts, n = {}, 0
    try:
        for line in proc.stdout:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            n += 1
            key = "ok" if r["ok"] else r.get("code", "ERROR")
            counts[key] = counts.get(key, 0) + 1
            st.execute("INSERT INTO retag_check VALUES (?,?,?,?,?,?)", (ids.get(r["path"]), r["path"], 1 if r["ok"] else 0,
                       r.get("code"), r.get("error"), datetime.now().isoformat(timespec="seconds")))
            if not r["ok"] or n % 250 == 0:
                log(f"[{n}/{len(paths)}] {os.path.basename(r['path'])}: {'ok' if r['ok'] else r.get('code') + ': ' + (r.get('error') or '')}"
                    + (f" | {json.dumps(r['explain'])}" if r.get('explain') else ""))
            if n % 50 == 0:
                st.commit()
    except KeyboardInterrupt:
        proc.kill()
        log("Stopped")
    st.commit()
    proc.wait()
    log("Result: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))


def cmd_damage_check(args):
    """Read-only (2026-11-21): for files Omnibus calls damaged, show whether this script could have caused it.
    Every edit by this script wrote only from `cut` to the end of the file (and three bytes of an old
    ComicInfo.xml's name); a page whose bytes lie wholly before the earliest cut was never written by it.
    Lists each member that fails its CRC with its byte range and the earliest cut."""
    db, st = app_db(), state_db()
    want = [m.lower() for m in (args.match or [])]
    rows = st.execute("SELECT book_id, path, store_date FROM written WHERE result = 'written' ORDER BY path").fetchall()
    rows = [r for r in rows if any(m in (r["path"] or "").lower() for m in want)]
    for r in rows:
        cur = db.execute("SELECT path FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
        path = cur["path"] if cur and cur["path"] and os.path.exists(cur["path"]) else r["path"]
        cuts = [c["cut"] for c in st.execute("SELECT cut FROM endings_backup WHERE book_id = ?", (r["book_id"],))]
        first_cut = min(cuts) if cuts else None
        orphans = sorted({c["orphan"] for c in st.execute("SELECT orphan FROM endings_backup WHERE book_id = ? AND orphan IS NOT NULL", (r["book_id"],))})
        bad = []
        try:
            with zipfile.ZipFile(path) as z:
                for i in z.infolist():
                    if i.is_dir():
                        continue
                    try:
                        with z.open(i) as f:
                            while f.read(1 << 20):
                                pass
                    except Exception as e:
                        end = i.header_offset + 30 + len(i.filename.encode()) + len(i.extra) + i.compress_size
                        touched = (first_cut is not None and end > first_cut) or any(i.header_offset <= o < end for o in orphans)
                        bad.append(f"{i.filename} bytes {i.header_offset:,}-{end:,}: {type(e).__name__}: {str(e)[:60]}"
                                   + (" — OVERLAPS a region this script wrote" if touched else " — before any byte this script wrote"))
        except Exception as e:
            bad.append(f"cannot open: {e}")
        log(f"{os.path.basename(path)}: earliest cut {first_cut:,} | " + ("no damaged pages in Python" if not bad else "; ".join(bad[:4])) if first_cut is not None else
            f"{os.path.basename(path)}: no rewrite recorded | " + ("no damaged pages in Python" if not bad else "; ".join(bad[:4])))


def cmd_check_endings(args):
    """Read-only (2026-11-21): every file `write` edited, at its current path, must open in Python's zip
    reader with one end record (no earlier index left), give 7-Zip no warnings, and its ComicInfo.xml must
    carry the store date that was written, the same in Python and 7-Zip. Lists the files that do not.
    (Two fix-endings runs overlapped on 2026-11-21; this confirms none of their files was hurt.)"""
    db, st = app_db(), state_db()
    rows = st.execute("SELECT book_id, path, store_date FROM written WHERE result = 'written' ORDER BY path").fetchall()
    if args.limit:
        rows = rows[:args.limit]
    log(f"{len(rows)} written books to check; 7-Zip {'found' if SEVEN_ZIP else 'NOT FOUND (Python only)'}")
    counts, bad = {}, []
    for n, r in enumerate(rows, 1):
        cur = db.execute("SELECT path FROM scanned_books WHERE id = ?", (r["book_id"],)).fetchone()
        path = cur["path"] if cur and cur["path"] and os.path.exists(cur["path"]) else r["path"]
        try:
            if not os.path.exists(path):
                result = "file missing"
            else:
                with zipfile.ZipFile(path) as z:
                    ci = root_comicinfo(z)
                    data = z.read(ci) if ci else b""
                    z.testzip() if args.full else None
                d = comicinfo_store_date(data.decode("utf-8", "replace")) if ci else None
                if ci is None:
                    result = "problem: no ComicInfo.xml Omnibus would read"
                elif appended_layout(path):
                    result = "not repaired yet (earlier index left)"
                elif d is None:
                    result = "ok, no StoreDate (changed since: retag or another tool)"
                else:
                    reason = seven_zip_check(path, ci.filename, data)
                    result = ("problem: " + reason) if reason else "ok"
        except Exception as e:
            result = f"problem: {type(e).__name__}: {e}"
        counts[result.split(":")[0] if result.startswith("problem") else result] = counts.get(result.split(":")[0] if result.startswith("problem") else result, 0) + 1
        if result.startswith("problem") or result.startswith("not repaired"):
            bad.append((path, result))
            log(f"[{n}/{len(rows)}] {path}: {result}")
        elif n % 2000 == 0:
            log(f"[{n}/{len(rows)}] checked")
    log("Result: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))
    if bad:
        log(f"{len(bad)} files need a look (listed above)")


def cmd_fix_monitored(args):
    """fix-dates. 2026-11-21: dates that belong to another issue. (1) Books dated from a monitored issue
    that is not theirs. An old scanner linked specials
    and annuals to the parent series' issue with the same number, so Knight Terrors: Wonder Woman #1 got
    Wonder Woman #1's date. Finds every 'monitored' date whose link disagrees with the book's own Comic
    Vine ID, forgets it so collect, collect-gcd and collect-wiki date the book again, and queues the
    file's wrong StoreDate (if written) to be replaced or removed by write. Run before Omnibus clears
    those links (backfillMonitoredLinksByCv), since the link is how they are found. (2) Dates far from
    the book's cover month (plausible_date): another series' issue matched by number."""
    db, st = app_db(), state_db()
    rows = st.execute("SELECT book_id, path, store_date, source FROM dates WHERE store_date IS NOT NULL").fetchall()
    now, bad, queued = datetime.now().isoformat(timespec="seconds"), [], 0
    for r in rows:
        b = db.execute("SELECT filename, cv_issue_id, monitored_issue_id, comicinfo FROM scanned_books WHERE id = ?",
                       (r["book_id"],)).fetchone()
        if not b:
            continue
        wrong_link = r["source"] == "monitored" and b["monitored_issue_id"] and str(b["cv_issue_id"] or "").isdigit() \
            and str(b["cv_issue_id"]) != str(b["monitored_issue_id"])
        why = "wrong monitored issue" if wrong_link else (None if plausible_date(b["comicinfo"], r["store_date"]) else "far from the cover month")
        if not why:
            continue
        bad.append((why, b["filename"], r["store_date"], r["source"]))
        if args.dry_run:
            continue
        if comicinfo_store_date(b["comicinfo"]) == r["store_date"]:
            st.execute("INSERT OR REPLACE INTO redo VALUES (?,?,?,?)", (r["book_id"], r["store_date"], why, now))
            queued += 1
        for t in ("dates", "written", "gcd_tried", "wiki_tried"):
            try:
                st.execute(f"DELETE FROM {t} WHERE book_id = ?", (r["book_id"],))
            except sqlite3.OperationalError:
                pass                                      # table not made yet
    st.commit()
    for why, f, d, src in sorted(bad):
        print(f"  {why}: {f}: {d} ({src})")
    log(f"{len(bad)} wrong dates ({sum(1 for x in bad if x[0] == 'wrong monitored issue')} from another issue's monitored entry, "
        f"{sum(1 for x in bad if x[0] != 'wrong monitored issue')} far from the cover month)"
        + (" (dry run: nothing changed)" if args.dry_run else f"; {queued} files carry that date and will be corrected by write"))
    if not args.dry_run and bad:
        log("Next: collect, collect-gcd, collect-wiki, then write.")


def cmd_skipped(args):
    """Read-only: for each book write skipped with the given reason, the archive's ComicInfo-like members
    (folder, spelling, size) and how many members it has."""
    st = state_db()
    rows = st.execute("SELECT book_id, path, store_date, result FROM written WHERE result LIKE ? ORDER BY path",
                      (f"%{args.reason}%",)).fetchall()
    print(f"{len(rows)} books skipped with '{args.reason}'")
    for r in rows:
        print(f"\n{r['path']}  (date {r['store_date']})")
        try:
            with zipfile.ZipFile(r["path"]) as z:
                infos = z.infolist()
                hits = [i for i in infos if re.search(r"comicinfo", i.filename, re.I)]
                print(f"  {len(infos)} members; ComicInfo-like: " + ("; ".join(f"{i.filename!r} {i.file_size} B" for i in hits) or "none"))
                top = sorted({i.filename.split('/')[0] + ('/' if '/' in i.filename else '') for i in infos})[:6]
                print(f"  top level: {top}")
        except Exception as e:
            print(f"  cannot open: {e}")


def cmd_wiki_probe(args):
    pages, redirects, normalized = wiki_pages(args.wiki, args.titles)
    for n in normalized:
        print(f"(normalized {n.get('from')} -> {n.get('to')})")
    for rd in redirects:
        print(f"(redirect {rd.get('from')} -> {rd.get('to')})")
    for title, text in pages.items():
        print(f"\n===== {title} =====")
        if text is None:
            print("(no such page)")
            continue
        lines = text.splitlines()
        shown = [l for l in lines[:args.lines]]
        print("\n".join(shown))
        dates = [l for l in lines if re.search(r"(?i)date|day|month|year|publish|release|sale", l)][:30]
        print("--- lines mentioning dates ---")
        print("\n".join(dates))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--series", action="append")
    c.add_argument("--max-series", type=int)
    c.add_argument("--no-metron", action="store_true")
    c.add_argument("--no-cv", action="store_true")
    c.add_argument("--retry-missing", action="store_true")
    c.add_argument("--metron-budget", type=int, help="Metron requests this script may use per UTC day (default 3500 of Metron's 5000)")
    c.add_argument("--metron-reserve", type=int, help="stop using Metron when its daily count left falls to this (default 1500, kept for Omnibus)")
    r = sub.add_parser("report")
    r.add_argument("--csv")
    w = sub.add_parser("write")
    w.add_argument("--series", action="append")
    w.add_argument("--max-series", type=int)
    w.add_argument("--limit", type=int)
    w.add_argument("--dry-run", action="store_true")
    sub.add_parser("sync-db")
    ce = sub.add_parser("check-endings")
    ce.add_argument("--limit", type=int)
    ce.add_argument("--full", action="store_true", help="also test every page's CRC (reads whole files: slow)")
    fe = sub.add_parser("fix-endings")
    fe.add_argument("--dry-run", action="store_true")
    fe.add_argument("--limit", type=int)
    fe.add_argument("--shard", help="K/N: worker K of N (each takes every Nth book; the routine is left alone)")
    fe.add_argument("--match", action="append", help="only books whose path contains this text (repeatable)")
    dc = sub.add_parser("damage-check")
    dc.add_argument("--match", action="append", required=True, help="books whose path contains this text (repeatable)")
    rc = sub.add_parser("retag-check")
    rc.add_argument("--match", action="append", help="only books whose path contains this text (repeatable)")
    rc.add_argument("--orphans", action="store_true", help="books whose old ComicInfo.xml was left in the file")
    rc.add_argument("--sample", type=int, help="this many written books at random")
    rc.add_argument("--all", action="store_true", help="every written book (slow: Omnibus extracts each one)")
    rc.add_argument("--limit", type=int)
    fo = sub.add_parser("fix-orphans")
    fo.add_argument("--dry-run", action="store_true")
    fo.add_argument("--limit", type=int)
    fo.add_argument("--shard", help="K/N: worker K of N (each takes every Nth book; the routine is left alone)")
    fo.add_argument("--start-only", action="store_true", help="only an old ComicInfo.xml at the very start of the file")
    fo.add_argument("--match", action="append", help="only books whose path contains this text (repeatable)")
    fm = sub.add_parser("fix-dates", aliases=["fix-monitored"])
    fm.add_argument("--dry-run", action="store_true")
    sk = sub.add_parser("skipped")
    sk.add_argument("--reason", default="ComicInfo.xml")
    sub.add_parser("unmark-scan")
    sc = sub.add_parser("scan-check")
    sc.add_argument("--sample", type=int, default=500)
    pr = sub.add_parser("probe")
    pr.add_argument("--series", action="append", required=True)
    wp = sub.add_parser("wiki-probe")
    wp.add_argument("titles", nargs="+")
    wp.add_argument("--wiki", choices=sorted(WIKIS), default="dc")
    wp.add_argument("--lines", type=int, default=40)
    cg = sub.add_parser("collect-gcd")
    cg.add_argument("--index", default=os.path.join(os.path.dirname(DB_PATH), "gcd-index.db"))
    cg.add_argument("--build", help="build the index first from this GCD SQLite dump")
    cg.add_argument("--retry", action="store_true", help="check books already checked against GCD again")
    cw = sub.add_parser("collect-wiki")
    cw.add_argument("--wiki", choices=sorted(WIKIS))
    cw.add_argument("--max-series", type=int)
    cw.add_argument("--retry", action="store_true", help="ask again for books turned down for no Day, no published-on date, cover month differs or no ReleaseDate")
    wt = sub.add_parser("wiki-trial")
    wt.add_argument("--series", action="append", required=True)
    wt.add_argument("--wiki", choices=sorted(WIKIS), required=True)
    wt.add_argument("--wiki-name", help="the series name on the wiki when it differs from Omnibus's")
    wt.add_argument("--rendered", type=int, default=30, help="DC: pages whose 'published on' sentence is read (one request each)")
    args = p.parse_args()
    {"collect": cmd_collect, "report": cmd_report, "write": cmd_write, "probe": cmd_probe, "sync-db": cmd_sync_db, "skipped": cmd_skipped, "fix-dates": cmd_fix_monitored, "fix-endings": cmd_fix_endings, "fix-orphans": cmd_fix_orphans, "retag-check": cmd_retag_check, "damage-check": cmd_damage_check, "check-endings": cmd_check_endings, "fix-monitored": cmd_fix_monitored, "unmark-scan": cmd_unmark_scan, "scan-check": cmd_scan_check, "wiki-probe": cmd_wiki_probe, "wiki-trial": cmd_wiki_trial, "collect-wiki": cmd_collect_wiki, "collect-gcd": cmd_collect_gcd}[args.cmd](args)


if __name__ == "__main__":
    main()
