'use strict';
// ─── Held downloads: View, Process anyway, Delete file (2026-11-09) ───────────
// A downloaded issue that post-processing stops because the file names or tags
// another issue stays 'downloaded' (Download Manager › Queue › Post-processing).
// Admins can look at its cover, file it as that issue anyway, or delete the file
// (the issue goes back to wanted; nothing is blocked, since a host may fix the file).
const IDENTITY_HOLD = /^(IDENTITY_REVIEW_REQUIRED|CV_ISSUE_MISMATCH|ANNUAL_MISMATCH)\b/;
const COMIC = /\.(cbz|cbr|zip|rar|7z|cb7)$/i;

// The real path of a downloaded file or folder that may be deleted: inside a download folder
// (SABnzbd completed, GetComics, qBittorrent comics), never a download folder itself and never
// anything inside a library; else null. Also used for whole packs (packs.js).
function deletableDownload({ fs, path, db, getSetting }, p) {
  const inside = (root, x) => { const rel = path.relative(root, x); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  const real = x => { try { return fs.realpathSync(x); } catch { return null; } };
  const target = p ? real(p) : null;
  if (!target) return null;
  const roots = [getSetting('sabnzbd_completed_path') || '/downloads', getSetting('ddl_download_path') || '/downloads/getcomics', getSetting('qbittorrent_comic_savepath')]
    .filter(Boolean).map(real).filter(Boolean);
  const libraries = db.prepare('SELECT path FROM libraries').all().map(r => real(r.path)).filter(Boolean);
  if (!roots.some(r => inside(r, target)) || libraries.some(l => l === target || inside(l, target))) return null;
  return target;
}
module.exports.deletableDownload = deletableDownload;

module.exports.registerHeldDownloads = function registerHeldDownloads(deps) {
  const missing = ['app', 'requireAdmin', 'db', 'fs', 'path', 'logger', 'getSetting', 'processAnyway', 'isProcessing', 'runCompletionWatcher', 'listArchiveFiles', 'filterImages', 'readArchiveMember', 'coverThumb'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerHeldDownloads: missing ${missing.join(', ')}`);
  const { app, requireAdmin, db, fs, path, logger, getSetting, processAnyway, isProcessing, runCompletionWatcher, listArchiveFiles, filterImages, readArchiveMember, coverThumb } = deps;

  const heldIssue = (req, res) => {
    const issue = db.prepare('SELECT id, status, file_path, last_fail_reason FROM monitored_issues WHERE id = ?').get(req.params.id);
    if (!issue) { res.status(404).json({ error: 'Issue not found' }); return null; }
    if (issue.status !== 'downloaded') { res.status(409).json({ error: `Issue is '${issue.status}', not waiting for post-processing` }); return null; }
    if (isProcessing(issue.id)) { res.status(409).json({ error: 'Issue is being processed right now' }); return null; }
    if (!issue.file_path || !fs.existsSync(issue.file_path)) { res.status(409).json({ error: 'Downloaded file is missing; reset the issue to wanted' }); return null; }
    return issue;
  };
  // The comic file itself: the download, or the one comic in a download folder.
  const comicFile = p => {
    const st = fs.statSync(p);
    if (st.isFile()) return p;
    const found = fs.readdirSync(p).filter(f => COMIC.test(f)).sort();
    return found.length ? path.join(p, found[0]) : null;
  };
  const deletable = p => deletableDownload({ fs, path, db, getSetting }, p);

  app.post('/api/admin/downloads/issues/:id/process-anyway', requireAdmin, (req, res) => {
    const issue = heldIssue(req, res); if (!issue) return;
    if (!IDENTITY_HOLD.test(issue.last_fail_reason || '')) return res.status(409).json({ error: 'Process anyway is for downloads held because the file does not match the issue' });
    processAnyway(issue.id);
    db.prepare('UPDATE monitored_issues SET retry_after = NULL WHERE id = ?').run(issue.id);
    logger.info('postprocess', `Issue ${issue.id}: process anyway by ${req.user?.username || 'admin'}`, { file: path.basename(issue.file_path) });
    setImmediate(() => runCompletionWatcher());
    res.json({ ok: true, id: issue.id });
  });

  // Only inside a download folder (SABnzbd completed, GetComics, qBittorrent comics), never
  // a download folder itself and never anything inside a library.
  app.post('/api/admin/downloads/issues/:id/delete-file', requireAdmin, (req, res) => {
    const issue = heldIssue(req, res); if (!issue) return;
    const target = deletable(issue.file_path);
    if (!target) return res.status(409).json({ error: 'The file is not in a download folder; delete it by hand', file_path: issue.file_path });
    try {
      fs.rmSync(target, { recursive: fs.statSync(target).isDirectory(), force: true });
    } catch (e) { return res.status(500).json({ error: `Could not delete the file: ${e.message}` }); }
    db.prepare(`UPDATE monitored_issues SET status = 'wanted', download_id = NULL, file_path = NULL, retry_after = NULL,
                last_fail_reason = 'Download deleted by an admin' WHERE id = ? AND status = 'downloaded'`).run(issue.id);
    logger.info('postprocess', `Issue ${issue.id}: downloaded file deleted by ${req.user?.username || 'admin'}; back to wanted`, { file: path.basename(issue.file_path) });
    res.json({ ok: true, id: issue.id });
  });

  app.get('/api/admin/downloads/issues/:id/cover', requireAdmin, async (req, res) => {
    const issue = heldIssue(req, res); if (!issue) return;
    try {
      const file = comicFile(issue.file_path);
      if (!file) return res.status(404).json({ error: 'No comic file in the download' });
      const first = filterImages(await listArchiveFiles(file) || [])[0];
      if (!first) return res.status(404).json({ error: 'No pages found in the file' });
      const out = await coverThumb(await readArchiveMember(file, first), path.extname(first));
      res.set('Cache-Control', 'no-store').type(out.mime).send(out.buf);
    } catch (e) {
      logger.warn('postprocess', `Cover of held download ${issue.id} could not be read`, e.message);
      res.status(500).json({ error: 'The cover could not be read' });
    }
  });
};
module.exports.IDENTITY_HOLD = IDENTITY_HOLD;
