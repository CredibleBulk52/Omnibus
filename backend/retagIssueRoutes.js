'use strict';
// ─── Retagging monitored issues (moved out of server.js 2026-11-19, server.js split step 7A) ───
// Retag one issue, retag a whole series (cancellable, shown in Downloads), and set the status of many
// issues at once. Moved unchanged; the work itself is the shared metadata runtime's retag.

const NEEDS = ['activeDownloads', 'app', 'db', 'fetchCvIssue', 'finalizeCancellation', 'isCancelled', 'logger', 'metadataRuntime', 'pushDownloadUpdate', 'requireAdmin', 'requireDownloadAccess', 'retagHandlers'];
module.exports.NEEDS = NEEDS;

module.exports.registerRetagIssueRoutes = function registerRetagIssueRoutes(deps) {
  const missing = NEEDS.filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerRetagIssueRoutes: missing ${missing.join(', ')}`);
  const { activeDownloads, app, db, fetchCvIssue, finalizeCancellation, isCancelled, logger, metadataRuntime, pushDownloadUpdate, requireAdmin, requireDownloadAccess, retagHandlers } = deps;
  // ─── Existing-book reprocessing through the shared metadata lifecycle ───
  async function retagIssue(issue, series, { skipCvRefresh = false, preserveFilename = false, signal } = {}) {
    let freshIssue = null;
    if (skipCvRefresh) { try { freshIssue = JSON.parse(issue.cv_data || 'null'); } catch {} }
    const result = await metadataRuntime.retag({issue, freshIssue, preserveFilename, signal});
    // Only the exact monitored path processed by the runtime is acknowledged.
    const fresh = db.prepare('SELECT cv_data FROM monitored_issues WHERE id = ?').get(issue.id);
    if (fresh?.cv_data) db.prepare('UPDATE monitored_issues SET last_retag_cv_hash = ?, has_comicinfo = 1 WHERE id = ? AND file_path = ?')
      .run(crypto.createHash('md5').update(fresh.cv_data).digest('hex'), issue.id, result.path || issue.file_path);
    return result;
  }

  // Retag a single processed issue
  app.post('/api/monitor/series/:id/issues/:issueId/retag', requireAdmin, async (req, res) => {
    const { id, issueId } = req.params;

    // Look up by issue ID only — annual issues belong to their own series_id (the annual CV volume),
    // not the parent series. Verify the issue is reachable from the parent via direct ownership or
    // a series_annual_links entry so we don't expose arbitrary issue retags.
    const issue = db.prepare('SELECT * FROM monitored_issues WHERE id = ?').get(issueId);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const ownedByParent = issue.series_id === id;
    const linkedAsAnnual = !ownedByParent && !!db.prepare(
      'SELECT 1 FROM series_annual_links WHERE parent_series_id = ? AND annual_series_id = ?'
    ).get(id, issue.series_id);
    if (!ownedByParent && !linkedAsAnnual) return res.status(403).json({ error: 'Issue does not belong to this series' });

    if (issue.status !== 'processed') return res.status(400).json({ error: 'Issue is not processed' });

    // Use the issue's own series row (annual series for annuals, parent series for regular issues)
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(issue.series_id);
    if (!series) return res.status(404).json({ error: 'Series not found' });

    try {
      await retagIssue(issue, series);
      res.json({ success: true });
    } catch (e) {
      logger.error('retag', `Failed for issue ${issueId}`, e.message);
      retagHandlers.errorResponse(res, e);
    }
  });

  // POST /api/monitor/series/:id/retag-all — retag every processed issue in a series
  // with fresh Comic Vine metadata. Streams progress as SSE so the client can render
  // a live counter. Does NOT include linked annual volumes — those must be retagged
  // from their own series row. Admin-only.
  //
  // Optional body: { issueIds: [...] } — restricts retag to a specific subset.
  // Non-processed IDs are silently filtered out so the client doesn't have to pre-filter.
  app.post('/api/monitor/series/:id/retag-all', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const series = db.prepare('SELECT * FROM monitored_series WHERE id = ?').get(id);
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const subsetIds = Array.isArray(req.body?.issueIds) ? req.body.issueIds : null;
    const onlyUntagged = req.body?.onlyUntagged === true;
    let issues;
    if (subsetIds && subsetIds.length) {
      // Filter to processed issues that belong to this series and are in the subset.
      // Parameterised IN clause built from the subset length.
      const placeholders = subsetIds.map(() => '?').join(',');
      issues = db.prepare(
        `SELECT * FROM monitored_issues
       WHERE series_id = ? AND status = 'processed' AND id IN (${placeholders})
       ORDER BY CAST(issue_number AS REAL)`
      ).all(id, ...subsetIds);
    } else if (onlyUntagged) {
      // Retag only processed issues whose archive is confirmed missing ComicInfo.xml.
      // has_comicinfo IS NULL means "not yet scanned" — skip those so we don't do
      // needless work; they'll be scanned by the background task.
      issues = db.prepare(
        `SELECT * FROM monitored_issues WHERE series_id = ? AND status = 'processed' AND has_comicinfo = 0 ORDER BY CAST(issue_number AS REAL)`
      ).all(id);
    } else {
      issues = db.prepare(
        `SELECT * FROM monitored_issues WHERE series_id = ? AND status = 'processed' ORDER BY CAST(issue_number AS REAL)`
      ).all(id);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Mirror progress to the global download toast so users see activity
    // regardless of which page they're on. Same contract as auto-grab:
    // totalBytes = issue count, bytesReceived = issues completed.
    const scopeLabel = onlyUntagged ? 'Retag Untagged' : 'Retag All';
    const dlId = `retag-all-${id}-${Date.now()}`;
    const dlEntry = {
      id: dlId,
      filename: `${scopeLabel}: ${series.name}`,
      seriesName: series.name,
      bytesReceived: 0,
      totalBytes: issues.length,
      status: 'downloading',
      startedAt: new Date().toISOString(),
    };
    activeDownloads.set(dlId, dlEntry);
    pushDownloadUpdate(dlEntry);

    send({ log: `Retagging ${issues.length} issue${issues.length === 1 ? '' : 's'} in ${series.name}...\n`, progress: { done: 0, total: issues.length } });


    let done = 0, errors = 0, skipped = 0, aborted = false, userCancelled = false, abortReason = '';
    for (let i = 0; i < issues.length; i++) {
      // Cancel check — user clicked ✕ on the toast. Stop the batch; issues
      // already retagged this run stay retagged (not reversible, fine).
      if (isCancelled(dlId)) {
        userCancelled = true;
        const remaining = issues.length - i;
        send({
          log: `\n✕ Cancelled by user after ${done} successful retag${done === 1 ? '' : 's'}.\n` +
               `${remaining} issue${remaining === 1 ? '' : 's'} left unprocessed.\n`,
          progress: { done: done + skipped + errors, total: issues.length },
        });
        logger.info('retag-all', `Series ${id} cancelled by user after ${done} retagged`, { remaining });
        break;
      }
      const issue = issues[i];
      // Update toast with current position before each issue
      dlEntry.bytesReceived = done + skipped + errors;
      dlEntry.filename = `${scopeLabel}: ${series.name} — ${i + 1}/${issues.length} (#${issue.issue_number})`;
      pushDownloadUpdate({ ...dlEntry });

      try {
        send({ log: `#${issue.issue_number}... ` });
        const current = retagIssue(issue, series);
        // Look up the next issue on Comic Vine while this one is being written: the reply is cached
        // (10 min), so the next retag starts with it. Read-only; Comic Vine pacing still applies.
        const next = issues[i + 1];
        if (next && !isCancelled(dlId)) fetchCvIssue(next.id).catch(() => null);
        await current;
        done++;
        send({ log: `✓\n`, progress: { done: done + skipped + errors, total: issues.length } });
      } catch (e) {
        if (e.code === 'CV_RATE_LIMIT') {
          // Stop the whole batch. Continuing would either fall back to stale cv_data
          // or produce empty ComicInfo files for the remaining issues.
          const remaining = issues.length - i;
          send({
            log: `\n⚠ Comic Vine rate limit reached after ${done} successful retag${done === 1 ? '' : 's'}.\n` +
                 `Stopping batch — ${remaining} issue${remaining === 1 ? '' : 's'} left untouched.\n` +
                 `Try again in an hour, or retag in smaller batches.\n`,
            progress: { done: done + skipped + errors, total: issues.length },
          });
          logger.warn('retag-all', `Rate limited after ${done} issues, ${remaining} not processed`);
          aborted = true;
          break;
        }
        if (e.code === 'LIBRARY_RECOVERY_REQUIRED' || metadataRuntime.status().length) {
          errors++; aborted = true; abortReason = 'metadata recovery required'; send({log: 'Metadata work is held for recovery: ' + e.message + '\n', operationId: e.operationId}); break;
        }
        if (e.code === 'CV_NO_DATA') {
          // Not a true error — the issue simply can't be tagged right now. Leave it
          // alone (has_comicinfo stays 0) so the user can see it's still pending.
          skipped++;
          send({ log: `⊘ skipped (no CV data)\n`, progress: { done: done + skipped + errors, total: issues.length } });
          continue;
        }
        errors++;
        send({ log: `✗ ${e.message}\n`, progress: { done: done + skipped + errors, total: issues.length } });
        logger.error('retag-all', `Failed for issue ${issue.id}`, e.message);
      }
      // No fixed pause between issues (was 700 ms): cvApiGet spaces every Comic Vine request and keeps
      // the hourly budget, so a pause here only added time (2026-10-22).
    }

    // Final toast update with summary, then auto-remove. Three terminal paths:
    //   (1) userCancelled — short auto-remove, 'cancelled' status
    //   (2) aborted       — CV rate limit, 'error' status + explanation
    //   (3) success       — 'complete' status with normal summary
    dlEntry.bytesReceived = issues.length;
    const summary = `${done} retagged${skipped ? `, ${skipped} skipped` : ''}${errors ? `, ${errors} error${errors !== 1 ? 's' : ''}` : ''}`;
    if (userCancelled) {
      // Use finalizeCancellation so the UI gets the same 'cancelled' status
      // treatment as every other cancellable op.
      dlEntry.filename = `${scopeLabel} ${series.name} cancelled: ${summary}`;
      finalizeCancellation(dlEntry, `Cancelled: ${summary}`);
    } else {
      dlEntry.status = aborted ? 'error' : 'complete';
      dlEntry.filename = `${scopeLabel} ${series.name}: ${summary}${aborted ? ' — ' + (abortReason || 'rate limited') : ''}`;
      if (aborted) dlEntry.error = abortReason || 'Comic Vine rate limited — retry later';
      pushDownloadUpdate({ ...dlEntry });
      setTimeout(() => { activeDownloads.delete(dlId); pushDownloadUpdate({ id: dlId, status: 'removed' }); }, 15000);
    }

    send({ done: true, total: issues.length, succeeded: done, errors, skipped, aborted, cancelled: userCancelled });
    res.end();
  });

  // Reset a stuck issue back to wanted so it can be re-grabbed
  // Bulk set issue status — used for multi-select skip/unskip in the UI
  // Body: { issueIds: [...], status: 'skipped'|'wanted' }
  // Only transitions: wanted→skipped, skipped→wanted (never touches downloaded/processed)
  app.post('/api/monitor/series/:id/bulk-status', requireDownloadAccess, (req, res) => {
    const { issueIds, status } = req.body;
    if (!Array.isArray(issueIds) || !issueIds.length) return res.status(400).json({ error: 'issueIds required' });
    if (!['skipped', 'wanted'].includes(status)) return res.status(400).json({ error: 'status must be skipped or wanted' });

    const allowedFrom = status === 'skipped' ? ['wanted'] : ['skipped'];
    const stmt = db.prepare(`UPDATE monitored_issues SET status = ? WHERE id = ? AND status IN (${allowedFrom.map(() => '?').join(',')})`);
    let updated = 0;
    for (const id of issueIds) {
      const { changes } = stmt.run(status, id, ...allowedFrom);
      updated += changes;
    }
    logger.info('bulk-status', `Set ${updated} issues to ${status}`);
    res.json({ success: true, updated });
  });
  return { retagIssue };
};
