'use strict';

// Resolve catalog identities independently of file ownership. Scans use only local evidence.
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const number = s => norm(s).replace(/^#/, '').replace(/^0+(?=\d)/, '');
const realId = id => /^[1-9]\d*$/.test(String(id));
const week = 7 * 86400000;
const tables = ['event_issues', 'canon_run_issues', 'list_issues'];
const key = (name, year, num) => JSON.stringify([norm(name), String(year), number(num)]);
function cover(issue) {
  const url = issue?.image?.thumb_url || issue?.image?.small_url;
  return /^https:\/\/(?:[\w-]+\.)*(?:gamespot\.com|comicvine\.com|cbsistatic\.com)\//i.test(url || '') ? url : null;
}
function agrees(volume, row) {
  return norm(volume.name) === norm(row.name) && (!row.year || Number(volume.start_year) === Number(row.year))
    && (!row.publisher || !volume.publisher?.name || norm(volume.publisher.name) === norm(row.publisher));
}
function exactIssue(issues, row) {
  if (!number(row.num)) return null;
  const hits = issues.filter(i => realId(i.id) && number(i.issue_number) === number(row.num));
  if (hits.length !== 1) return null;
  if (!row.year) {
    const gap = Math.abs(Date.parse(hits[0].store_date) - Date.parse(row.near));
    if (!Number.isFinite(gap) || gap > 120 * 86400000) return null;
  }
  return hits[0];
}

module.exports = function createMissingCatalog({ db, searchVolumes, volumeIssues, issueDetails, hasKey, background, logger }) {
  db.exec(`CREATE TABLE IF NOT EXISTS missing_catalog_art (id TEXT PRIMARY KEY, url TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS missing_catalog_retry (key TEXT PRIMARY KEY, due INTEGER NOT NULL, reason TEXT NOT NULL);`);
  const putArt = db.prepare('INSERT OR IGNORE INTO missing_catalog_art VALUES (?,?)');
  const art = db.prepare('SELECT url FROM missing_catalog_art WHERE id=?');
  const retry = db.prepare('SELECT due,reason FROM missing_catalog_retry WHERE key=?');
  const later = db.prepare('INSERT OR REPLACE INTO missing_catalog_retry VALUES (?,?,?)');
  const finished = db.prepare('DELETE FROM missing_catalog_retry WHERE key=?');
  const statusKey = 'missing_catalog_last_run';
  const saved = db.prepare('SELECT value FROM settings WHERE key=?');
  let running = false;
  function rows() {
    const out = [];
    for (const table of tables) {
      const list = db.prepare(`SELECT id, series_name AS name, issue_number AS num, volume_year AS year, cv_issue_id AS cv
        FROM ${table} WHERE scanned_book_id IS NULL OR NOT EXISTS (SELECT 1 FROM scanned_books WHERE id=CAST(${table}.scanned_book_id AS TEXT))`).all();
      const update = db.prepare(`UPDATE OR IGNORE ${table} SET cv_issue_id=? WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM scanned_books WHERE id=CAST(${table}.scanned_book_id AS TEXT))
        AND COALESCE(trim(cv_issue_id),'')='' AND series_name IS ? AND issue_number IS ? AND volume_year IS ?`);
      for (const r of list) out.push({ ...r, save: id => update.run(id,r.id,r.name,r.num,r.year).changes });
    }
    for (const side of ['from','to']) {
      const other = side === 'from' ? 'to' : 'from';
      const list = db.prepare(`SELECT l.id,l.${side}_series AS name,l.${side}_issue AS num,l.${side}_year AS year,
        l.${side}_cv_issue_id AS cv,b.store_date AS near,b.id AS anchor,
        CASE WHEN instr(b.comicinfo,'<Publisher>')>0 THEN substr(b.comicinfo,instr(b.comicinfo,'<Publisher>')+11,
          instr(b.comicinfo,'</Publisher>')-instr(b.comicinfo,'<Publisher>')-11) END AS publisher FROM crossover_links l
        JOIN scanned_books b ON b.id=l.${other}_book_id WHERE l.hidden=0 AND l.${side}_book_id IS NULL`).all();
      const update = db.prepare(`UPDATE crossover_links SET ${side}_cv_issue_id=? WHERE id=? AND hidden=0 AND ${other}_book_id=?
        AND ${side}_book_id IS NULL AND COALESCE(trim(${side}_cv_issue_id),'')='' AND ${side}_series=? AND ${side}_issue=? AND ${side}_year IS ?`);
      for (const r of list) out.push({ ...r, save: id => update.run(id,r.id,r.anchor,r.name,r.num,r.year).changes });
    }
    return out;
  }
  function remember(i) {
    const url = cover(i);
    if (url && realId(i.id)) putArt.run(String(i.id),url);
  }
  function local() {
    const pending = rows();
    const needed = new Set(pending.filter(r => !r.cv && r.year).map(r => key(r.name,r.year,r.num)));
    const known = new Map();
    const wantArt = new Set(pending.filter(r => realId(r.cv) && !art.get(String(r.cv))).map(r => String(r.cv)));
    function candidate(name,year,num,id) {
      const k = key(name,year,num);
      if (!needed.has(k) || !realId(id)) return false;
      if (!known.has(k)) known.set(k,new Set());
      known.get(k).add(String(id));
      return true;
    }
    for (const t of tables) {
      for (const i of db.prepare(`SELECT i.series_name,i.volume_year,i.issue_number,i.cv_issue_id FROM ${t} i
        JOIN scanned_books b ON b.id=CAST(i.scanned_book_id AS TEXT) AND b.cv_issue_id=i.cv_issue_id WHERE i.manually_matched=1`).iterate()) {
        candidate(i.series_name,i.volume_year,i.issue_number,i.cv_issue_id);
      }
    }
    for (const i of db.prepare(`SELECT series_name,volume_year,orig_number,cv_issue_id FROM book_ci_index
      WHERE cv_issue_id IS NOT NULL`).iterate()) candidate(i.series_name,i.volume_year,i.orig_number,i.cv_issue_id);
    const names = new Set(pending.map(r => norm(r.name)));
    for (const v of db.prepare('SELECT id,name,year FROM monitored_series').all()) {
      if (!names.has(norm(v.name))) continue;
      for (const i of db.prepare('SELECT id,issue_number,is_annual,cv_data FROM monitored_issues WHERE series_id=?').all(v.id)) {
        const hit = !i.is_annual && candidate(v.name,v.year,i.issue_number,i.id);
        if (hit || wantArt.has(String(i.id))) {
          try { const detail = JSON.parse(i.cv_data); if (String(detail?.id) === String(i.id)) remember(detail); } catch {}
        }
      }
    }
    // better-sqlite3 keeps the connection busy while this cursor is open.
    // Collect only matching thumbnails, then write them after the read finishes.
    const cachedArt = new Map();
    for (const v of db.prepare(`SELECT c.issues,s.name,s.year FROM cv_volume_issues_cache c LEFT JOIN monitored_series s ON s.id=c.vol_id`).iterate()) {
      let issues; try { issues = JSON.parse(v.issues); } catch { continue; }
      for (const i of issues || []) {
        if (candidate(v.name,v.year,i.issue_number,i.id) || wantArt.has(String(i.id))) {
          const url = cover(i);
          if (url && realId(i.id)) cachedArt.set(String(i.id),url);
        }
      }
    }
    for (const [id,url] of cachedArt) putArt.run(id,url);
    let filled = 0;
    for (const r of pending) {
      const ids = known.get(key(r.name,r.year,r.num));
      if (!r.cv && ids?.size === 1) filled += r.save([...ids][0]);
    }
    return filled;
  }
  const scan = db.transaction(local);
  const identityKey = r => JSON.stringify([norm(r.name),r.year,number(r.num),r.near || '',norm(r.publisher)]);
  async function online(report) {
    const pending = rows();
    const volumes = new Map(), issues = new Map();
    const catalogVolumes = db.prepare('SELECT id,name,year AS start_year FROM monitored_series').all();
    for (const r of pending.filter(r => !r.cv && r.name && (r.year || r.near))) {
      const k = identityKey(r);
      if (retry.get(k)?.due > Date.now()) continue;
      const title = norm(r.name);
      let matches = r.year ? catalogVolumes.filter(v => agrees(v,r) && realId(v.id)) : [];
      if (!matches.length) {
        if (!volumes.has(title)) {
          if (volumes.size >= 25) continue;
          try { volumes.set(title,await searchVolumes(r.name)); }
          catch (e) { later.run(k,Date.now()+86400000,'retry'); throw e; }
        }
        matches = volumes.get(title).filter(v => realId(v.id) && agrees(v,r));
      }
      let hit;
      if (matches.length === 1) {
        const id = String(matches[0].id);
        if (!issues.has(id)) {
          if (issues.size >= 25) continue;
          try { issues.set(id,await volumeIssues(id)); }
          catch (e) { later.run(k,Date.now()+86400000,'retry'); throw e; }
        }
        hit = exactIssue(issues.get(id),r);
      }
      if (hit) {
        const changes = r.save(String(hit.id));
        report.filled += changes;
        remember(hit);
        if (changes) finished.run(k);
        else later.run(k,Date.now()+week,'conflict');
      } else {
        later.run(k,Date.now()+week,matches.length > 1 ? 'ambiguous' : 'unresolved');
      }
    }
    let count = 0;
    for (const id of new Set(rows().map(r => String(r.cv)).filter(realId))) {
      const k = 'cover:'+id;
      if (art.get(id) || retry.get(k)?.due > Date.now()) continue;
      if (++count > 25) break;
      let i;
      try { i = await issueDetails(id); }
      catch (e) { later.run(k,Date.now()+86400000,'retry'); throw e; }
      if (String(i?.id) === id && cover(i)) { remember(i); finished.run(k); }
      else later.run(k,Date.now()+week,'no cover');
    }
  }
  function status() {
    return { running, last: JSON.parse(saved.get(statusKey)?.value || 'null'), configured: !!hasKey() };
  }
  function start() {
    if (running) return;
    running = true;
    setImmediate(async () => {
      const report = { filled: 0 };
      try {
        report.filled = scan();
        if (hasKey()) await background(() => online(report));
      } catch (e) {
        report.error = 'Lookup interrupted. Remaining issues will be retried.';
        logger.warn('missing-catalog','Lookup interrupted', { error: e.message });
      } finally {
        running = false;
        const left = rows().filter(r => !r.cv);
        report.remaining = left.length;
        report.ambiguous = left.filter(r => retry.get(identityKey(r))?.reason === 'ambiguous').length;
        report.at = Date.now();
        db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(statusKey,JSON.stringify(report));
      }
    });
  }
  return { scan, start, status, cover: id => art.get(String(id))?.url };
};
