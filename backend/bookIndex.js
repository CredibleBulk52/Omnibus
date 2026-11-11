'use strict';
// ── ComicInfo index ────────────────────────────────────────────────
// One row per scanned book: the series name, volume start year and issue
// number the book was PUBLISHED under, read from its ComicInfo.xml.
//
// Why: the library files specials, minis and one-shots inside a parent folder
// and renumbers them (Green Lantern: Rebirth #1-6 lives in the Green Lantern
// (2005) folder as #0, 0.2 … 0.6). Folder name + folder number then says
// nothing about what the book is. ComicInfo keeps the real <Series> and
// <Volume>; the Comic Vine link keeps the original number
// (…/green-lantern-rebirth-2-enemies-within/4000-130020/ → #2), even when
// <Number> was retagged.
//
// Built from scanned_books.comicinfo (already in the database); no file reads
// and no Comic Vine calls. Refresh is incremental (file mtime + ComicInfo
// length), so after the first build only changed books are parsed.

module.exports = function createBookIndex({ db, logger, IN }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_ci_index (
      book_id      TEXT PRIMARY KEY,
      series_name  TEXT,
      name_key     TEXT,
      volume_year  INTEGER,
      number       TEXT,          -- <Number> as tagged (may be retagged)
      orig_number  TEXT,          -- number as published (from the CV link, else <Number>)
      cv_issue_id  TEXT,
      stamp        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_book_ci_name ON book_ci_index(name_key, orig_number);
  `);
  // scanned_books had no index on series_id, so every "books in this series"
  // query read the whole table (~50k rows). Index only; no data changes.
  db.exec('CREATE INDEX IF NOT EXISTS idx_scanned_books_series ON scanned_books(series_id)');

  const normNum = n => (n == null || n === '') ? null : IN.normIssueNumber(String(n));
  const NOISE = new Set(['the', 'and', 'of', 'a', 'an']);
  // Same word rule as the reading-list matcher: "Hal Jordan & The Green Lantern
  // Corps" == "Hal Jordan and the Green Lantern Corps".
  const nameKey = s => [...new Set(String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/'/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !NOISE.has(w)))].sort().join(' ');
  const slugTokens = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

  const decode = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).trim();
  const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? decode(m[1]) : null; };

  // Original issue number from a Comic Vine issue URL slug:
  // "<volume-name>-<number>-<title>". Accept the token right after the series
  // name when it looks like an issue number.
  // The link drops punctuation ("23.1" → "23-1", "-1" → "1", "1/2" → "12"),
  // so the tagged <Number> wins whenever the link agrees with it; the link
  // number is used only when they disagree (a retagged book).
  function numberFromSlug(slug, series, tagged) {
    const st = slug.split('-').filter(Boolean), nt = slugTokens(series);
    const tries = [nt, nt[0] === 'the' ? nt.slice(1) : ['the', ...nt]];
    for (const t of tries) {
      if (!t.length || st.length <= t.length) continue;
      if (!t.every((w, i) => st[i] === w)) continue;
      const rest = st.slice(t.length);
      const tok = rest[0];
      if (!/^\d+[a-z]?$/.test(tok)) return null;
      const nTok = slugTokens(String(tagged || '').replace(/^0+(?=\d)/, ''));
      if (!nTok.length) return null;                                  // "½", "∞": keep the tag
      const agrees = nTok.every((w, i) => (rest[i] || '').replace(/^0+(?=\d)/, '') === w.replace(/^0+(?=\d)/, ''));
      if (agrees) return null;
      if (nTok.length === 1 && rest[0] + (rest[1] || '') === nTok[0]) return null;   // "1/2" tagged "12"
      if (nTok.length > 1 && nTok[0] !== '0' && tok === nTok.join('')) return null;   // "1.5" → "15", "679.1" → "6791"
      return tok;
    }
    return null;
  }

  function parse(xml) {
    const evidence = require('./metadata/evidence').parseComicInfoEvidence(xml);
    if (evidence.status !== 'valid') return null;
    const field = name => evidence.fields[name]?.length === 1 ? evidence.fields[name][0].trim() : null;
    const series = field('series');
    if (!series) return null;
    const number = field('number');
    const vol = parseInt(field('volume'), 10);
    const year = parseInt(field('year'), 10);
    const web = (evidence.fields.web || []).join(' ');
    const wm = web.match(/comicvine\.gamespot\.com\/([a-z0-9-]+)\/4000-(\d+)/i);
    const notes = (evidence.fields.notes || []).join(' ');
    const nm = notes.match(/CVDB(\d+)|Issue ID (\d+)/);
    const fromSlug = wm ? numberFromSlug(wm[1].toLowerCase(), series, number) : null;
    return {
      series_name: series, name_key: nameKey(series),
      volume_year: vol > 1800 && vol < 2200 ? vol : (year > 1800 && year < 2200 ? year : null),
      number: number || null,
      orig_number: normNum(fromSlug || number) || fromSlug || number || null,
      cv_issue_id: evidence.identity.cvIssueId,
    };
  }

  const yieldLoop = () => new Promise(r => setImmediate(r));
  let refreshing = null;

  // Incremental refresh. Returns { parsed, removed, total }.
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const t0 = Date.now();
      const have = new Map(db.prepare('SELECT book_id, stamp FROM book_ci_index').all().map(r => [r.book_id, r.stamp]));
      const books = db.prepare('SELECT id, file_mtime, length(comicinfo) AS len FROM scanned_books').all();
      const live = new Set();
      const todo = [];
      for (const b of books) {
        live.add(b.id);
        const stamp = `${b.file_mtime || ''}|${b.len || 0}`;
        if (have.get(b.id) !== stamp) todo.push({ id: b.id, stamp });
      }
      const gone = [...have.keys()].filter(id => !live.has(id));
      const get = db.prepare('SELECT comicinfo FROM scanned_books WHERE id = ?');
      const up = db.prepare(`INSERT INTO book_ci_index (book_id, series_name, name_key, volume_year, number, orig_number, cv_issue_id, stamp)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET series_name = excluded.series_name, name_key = excluded.name_key,
        volume_year = excluded.volume_year, number = excluded.number, orig_number = excluded.orig_number,
        cv_issue_id = excluded.cv_issue_id, stamp = excluded.stamp`);
      const del = db.prepare('DELETE FROM book_ci_index WHERE book_id = ?');
      for (let i = 0; i < todo.length; i += 1000) {
        db.transaction(() => {
          for (const t of todo.slice(i, i + 1000)) {
            const p = parse(get.get(t.id)?.comicinfo);
            up.run(t.id, p?.series_name ?? null, p?.name_key ?? null, p?.volume_year ?? null, p?.number ?? null,
              p?.orig_number ?? null, p?.cv_issue_id ?? null, t.stamp);
          }
        })();
        await yieldLoop();
      }
      if (gone.length) db.transaction(() => { for (const id of gone) del.run(id); })();
      const out = { parsed: todo.length, removed: gone.length, total: books.length, ms: Date.now() - t0 };
      if (todo.length || gone.length) logger.info('book-index', 'ComicInfo index refreshed', out);
      return out;
    })().catch(e => { logger.error('book-index', 'Refresh failed', { error: e.message }); return { error: e.message }; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  // Books published as <name> (volume year within 1 when given), keyed by
  // normalized original number. Annuals only when the name says Annual
  // (they are their own ComicInfo series, so the name decides).
  function lookup(name, year) {
    const key = nameKey(name);
    if (!key) return new Map();
    const rows = db.prepare(`SELECT ci.book_id, ci.series_name, ci.volume_year, ci.orig_number, ci.number, sb.series_id, sb.issue_number AS folder_number,
        ss.year AS folder_year, instr(sb.comicinfo, '<Volume>') > 0 AS has_volume
      FROM book_ci_index ci JOIN scanned_books sb ON sb.id = ci.book_id LEFT JOIN scanned_series ss ON ss.id = sb.series_id WHERE ci.name_key = ?`).all(key);
    const y = parseInt(year, 10);
    const byNum = new Map();
    for (const r of rows) {
      // Without a <Volume> tag, volume_year is the COVER year (Green Lantern
      // (1960) #184 says 1985); the folder year then counts as well.
      const ys = [r.volume_year, r.has_volume ? null : r.folder_year].filter(Boolean);
      const d = (y && ys.length) ? Math.min(...ys.map(v => Math.abs(v - y))) : 2;
      if (y && ys.length && d > 1) continue;
      const n = normNum(r.orig_number); if (!n) continue;
      // A book whose tag was overridden by its link loses ties to one that was
      // not (a mis-linked one-shot must not stand in for the real issue).
      const retag = normNum(r.number) !== n ? 1 : 0;
      const cur = byNum.get(n);
      if (!cur || d < cur.d || (d === cur.d && retag < cur.retag)) byNum.set(n, { ...r, d, retag });
    }
    return byNum;
  }

  // For the shared matcher: "name_key|number" → [{ id, year }].
  function matcherMap() {
    const m = new Map();
    for (const r of db.prepare('SELECT book_id, name_key, volume_year, number, orig_number FROM book_ci_index WHERE name_key IS NOT NULL AND orig_number IS NOT NULL').all()) {
      const n = normNum(r.orig_number); if (!n) continue;
      const k = `${r.name_key}|${n}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ id: r.book_id, year: r.volume_year, retag: normNum(r.number) !== n ? 1 : 0 });
    }
    return m;
  }

  // True when the book was PUBLISHED as issue `num` (ComicInfo / CV link),
  // whatever its folder number: Rebirth #2 filed as #0.2 is published as 2.
  const publishedAs = (bookId, num) => {
    const r = db.prepare('SELECT orig_number FROM book_ci_index WHERE book_id = ?').get(String(bookId));
    const a = normNum(r?.orig_number), b = normNum(num);
    return !!(a && b && a === b);
  };

  const info = bookId => db.prepare('SELECT series_name, volume_year, orig_number, number FROM book_ci_index WHERE book_id = ?').get(String(bookId)) || null;

  // Force one current row into the index inside an existing transaction. This
  // bypasses the legacy mtime/length shortcut after a known metadata write.
  function updateBook(bookId) {
    if (!(db.inTransaction || db.isTransaction)) throw new Error('Index finalization requires the caller transaction');
    const book = db.prepare('SELECT comicinfo,file_mtime,length(comicinfo) AS len FROM scanned_books WHERE id=?').get(bookId);
    if (!book) throw new Error('Cannot index a missing published book');
    const p = parse(book.comicinfo);
    db.prepare(`INSERT INTO book_ci_index(book_id,series_name,name_key,volume_year,number,orig_number,cv_issue_id,stamp)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET series_name=excluded.series_name,name_key=excluded.name_key,
      volume_year=excluded.volume_year,number=excluded.number,orig_number=excluded.orig_number,cv_issue_id=excluded.cv_issue_id,stamp=excluded.stamp`)
      .run(bookId, p?.series_name ?? null, p?.name_key ?? null, p?.volume_year ?? null, p?.number ?? null,
        p?.orig_number ?? null, p?.cv_issue_id ?? null, `${book.file_mtime || ''}|${book.len || 0}`);
  }
  return { refresh, lookup, matcherMap, info, nameKey, publishedAs, updateBook, _internal: { parse, numberFromSlug } };
};
