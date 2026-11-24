import DownloadIssueInspector from '../../components/DownloadIssueInspector';
import React, { useState } from 'react';
import { isAdmin } from '../../App';
import { DownloadIcon, SearchIcon, SourceStatus, StatusBadge, fmt, sourceOutcome, useToast, waitingTip } from './shared';

// ─── Issue row ────────────────────────────────────────────────────
// Build a short, loose query — strip punctuation and common words, keep max 4 terms.
// The user sees and edits this before firing so precision doesn't matter.
// Strip punctuation but keep dotted initialisms ("G.I.", "S.H.I.E.L.D.") —
// otherwise "G.I. Joe" becomes just "Joe". Mirrors the server's buildLooseSeriesName.
export function stripPunctKeepInitials(name) {
  return (name || '').split(/\s+/).map(w => {
    const letters = w.replace(/[^A-Za-z.]/g, '');
    return /^(?:[A-Za-z]\.){2,}$/.test(letters) ? letters : w.replace(/[^a-zA-Z0-9]/g, ' ');
  }).join(' ');
}

function buildLooseQuery(seriesName) {
  const stopWords = new Set(['the','a','an','of','in','on','at','to','for','and','or','new','all']);
  return stripPunctKeepInitials(seriesName)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()))
    .slice(0, 4)
    .join(' ');
}

export function IssueRow({ issue, seriesId, selectMode = false, selected = false, onSelect, onSkip, onChanged }) {
  const { toast } = useToast();
  const [searchResults, setSearchResults] = useState([]);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [searching, setSearching] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [grabbed, setGrabbed] = useState(false);
  const [query, setQuery] = useState('');
  const [retagging, setRetagging] = useState(false);
  const [retagResult, setRetagResult] = useState(null);
  const [gcLinks, setGcLinks] = useState({});
  const [gcGrabbing, setGcGrabbing] = useState({});
  const [nyaaGrabbing, setNyaaGrabbing] = useState({});
  const [inspecting, setInspecting] = useState(false);
  const isSkipped = issue.status === 'skipped';
  const issueLabel = `${issue.series_name || ''} ${String(issue.issue_number || '').padStart(3,'0')}`;

  const retag = async () => {
    setRetagging(true);
    setRetagResult(null);
    try {
      const r = await fetch(`/api/monitor/series/${seriesId}/issues/${issue.id}/retag`, { method: 'POST' });
      const d = await r.json();
      setRetagResult(d.success ? 'ok' : 'error');
      toast(d.success ? `Retagged ${issueLabel}` : `Retag failed for ${issueLabel}`, d.success ? 'success' : 'error');
    } catch {
      setRetagResult('error');
      toast(`Retag failed for ${issueLabel}`, 'error');
    }
    setRetagging(false);
  };

  const openSearch = () => {
    if (!expanded) {
      const base = buildLooseQuery(issue.series_name);
      const year = (issue.store_date || issue.release_date || '').slice(0, 4);
      let parts;
      if (issue.is_annual) {
        const hasAnnual = /annual/i.test(issue.series_name);
        parts = hasAnnual ? [base, year] : [base, 'Annual', year];
      } else {
        const issueNum = String(parseInt(issue.issue_number || '0', 10));
        parts = [base, issueNum, year];
      }
      setQuery(parts.filter(Boolean).join(' '));
      setSearchResults([]);
    }
    setExpanded(e => !e);
  };

  // Each source's results show as soon as they arrive; a slow source (Prowlarr
  // waiting on its indexers) no longer holds back the others (2026-11-03).
  const runSearch = async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setGcLinks({});
    setGcGrabbing({});
    setNyaaGrabbing({});
    setSearchResults([]);
    const enc = encodeURIComponent(q.trim());
    const parts = { ddl: [], nzb: [], nyaa: [] };
    const status = {
      Prowlarr: { name: 'Prowlarr', ok: true, pending: true, text: 'searching…' },
      GetComics: { name: 'GetComics', ok: true, pending: true, text: 'searching…' },
      Nyaa: { name: 'Nyaa', ok: true, pending: true, text: 'searching…' },
    };
    const publish = () => {
      setSearchResults([...parts.ddl, ...parts.nzb, ...parts.nyaa]);
      setSourceStatus([status.GetComics, status.Prowlarr, status.Nyaa]);
    };
    publish();
    const source = (name, key, url, listOf, limit) => fetch(url).then(r => r.json())
      .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
      .then(res => {
        const list = res.status === 'fulfilled' ? listOf(res.value) : [];
        parts[key] = list.slice(0, limit).map(r => ({ ...r, _source: key }));
        status[name] = sourceOutcome(name, res, list);
        publish();
      });
    await Promise.all([
      source('GetComics', 'ddl', `/api/getcomics/search?q=${enc}`, v => (Array.isArray(v) ? v : []), 10),
      source('Prowlarr', 'nzb', `/api/prowlarr/search-classified?q=${enc}`, v => (Array.isArray(v) ? v : []), 20),
      source('Nyaa', 'nyaa', `/api/nyaa/search?q=${enc}`, v => (Array.isArray(v?.results) ? v.results.filter(r => r.type !== 'chapter') : []), 15),
    ]).catch(() => {});
    setSearching(false);
  };

  const grabNyaaIssue = async (result) => {
    const key = result.infoHash || result.title;
    setNyaaGrabbing(g => ({ ...g, [key]: 'grabbing' }));
    toast(`Sending to qBittorrent: ${result.title}`, 'info');
    try {
      const r = await fetch('/api/qbittorrent/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: result.magnet, torrentUrl: result.link, issueId: issue.id }),
      });
      const d = await r.json();
      if (d.success) {
        setNyaaGrabbing(g => ({ ...g, [key]: 'done' }));
        setExpanded(false);
        setGrabbed(true);
        toast(`Sent to qBittorrent — ${issueLabel}`, 'success');
      } else {
        setNyaaGrabbing(g => ({ ...g, [key]: 'error' }));
        toast(`qBittorrent error: ${d.error}`, 'error');
      }
    } catch (e) {
      setNyaaGrabbing(g => ({ ...g, [key]: 'error' }));
      toast(`Error: ${e.message}`, 'error');
    }
  };

  const fetchDdlLinks = async (pageUrl) => {
    setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: true, links: [] } }));
    try {
      const r = await fetch(`/api/getcomics/links?url=${encodeURIComponent(pageUrl)}`);
      const d = await r.json();
      setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: false, links: d.links || [] } }));
    } catch {
      setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: false, links: [] } }));
    }
  };

  const grabDdl = async (downloadUrl, filename) => {
    setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'grabbing' }));
    toast(`Starting DDL download for ${issueLabel}…`, 'info');
    try {
      const r = await fetch('/api/getcomics/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId, issueId: issue.id, downloadUrl, filename }),
      });
      const d = await r.json();
      if (d.success) {
        setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'done' }));
        setExpanded(false);
        setGrabbed(true);
        toast(`Download queued for ${issueLabel} — watch progress bottom-left`, 'success');
      } else {
        setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'error' }));
        toast(d.error ? `DDL failed for ${issueLabel}: ${d.error}` : `DDL failed for ${issueLabel}`, 'error');
      }
    } catch (e) {
      setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'error' }));
      toast(`DDL error: ${e.message}`, 'error');
    }
  };

  const grab = async (result) => {
    setGrabbing(true);
    toast(`Sending ${issueLabel} to SABnzbd…`, 'info');
    try {
      const r = await fetch('/api/sabnzbd/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: result.downloadUrl, name: result.title, issueId: issue.id }),
      });
      const d = await r.json();
      if (d.success) {
        setGrabbed(true);
        setExpanded(false);
        toast(`${issueLabel} sent to SABnzbd`, 'success');
      } else {
        toast(`SABnzbd rejected ${issueLabel}`, 'error');
      }
    } catch (e) {
      toast(`Grab failed: ${e.message}`, 'error');
    }
    setGrabbing(false);
  };

  return (
    <div style={{ borderBottom: '1px solid var(--om-base)', opacity: isSkipped ? (issue.owned_in ? 0.75 : 0.45) : 1 }}>
      <div className={`dm-issue-row a-flex a-ai-c a-gap-10${selected ? ' is-selected' : ''}`} style={{ padding: '6px 12px' }}>
        {selectMode && (
          <button type="button" role="checkbox" aria-checked={selected}
            aria-label={`Select issue ${issue.issue_number}`}
            onClick={(e) => { e.preventDefault(); onSelect?.(issue.id, e.shiftKey); }}
            className="a-noshrink a-ptr a-flex a-ai-c a-jc-c" style={{ width: 24, height: 24, padding: 0, borderRadius: 2, background: selected ? 'var(--td-yellow)' : 'var(--om-base)', border: `2px solid ${selected ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-base) 85%, white)'}` }}
          >
            {selected && <span className="a-fs-10" style={{ color: 'var(--adm-g0)', fontWeight: 900, lineHeight: 1 }}>✓</span>}
          </button>
        )}
        <span className="dm-issue-number a-faint a-fs-11 a-ta-r a-mono" style={{ minWidth: 36 }}>
          {issue.issue_number?.padStart ? issue.issue_number.padStart(3, '0') : issue.issue_number}
        </span>
        <button type="button" className="dm-issue-title a-grow a-text2 a-fs-12 a-ovh a-ellip a-nowrap" title="Inspect issue" onClick={() => setInspecting(true)}>
          {issue.title || `Issue #${issue.issue_number}`}
        </button>
        <span className="dm-issue-date a-faint a-fs-11" title="Release date">{issue.release_date?.slice(0, 7) || '—'}</span>
        <div className="dm-issue-status">
        {issue.file_path && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(issue.file_path);
                toast('File path copied to clipboard', 'info');
              } else {
                toast(issue.file_path, 'info');
              }
            }}
            title={`Linked file: ${issue.file_path}\n(click to copy)`}
            aria-label="Show linked file path"
            className="a-faint a-ptr a-fs-13 a-noshrink" style={{ background: 'transparent', border: 'none', lineHeight: 1, padding: '2px 4px', opacity: 0.6 }}
            onMouseEnter={e => e.currentTarget.style.opacity = 1}
            onMouseLeave={e => e.currentTarget.style.opacity = 0.6}
          >ⓘ</button>
        )}
        {isSkipped && issue.owned_in && !grabbed ? (
          <span title={`Skipped: the library already has this issue in ${issue.owned_in}`} className="a-ok a-fs-10 a-fw6 a-nowrap a-ovh a-ellip" style={{ background: 'rgba(100,180,100,0.08)', border: '1px solid rgba(100,180,100,0.35)', borderRadius: 3, padding: '1px 7px', letterSpacing: '0.04em', maxWidth: 260 }}>OWNED · in {issue.owned_in}</span>
        ) : (
          grabbed ? <StatusBadge status="snatched" />
            : issue.waiting ? <>
                <StatusBadge status="waiting" title={waitingTip(issue.waiting)} />
                <span className="a-fs-11 a-muted a-nowrap a-ovh a-ellip" style={{ maxWidth: 280 }}
                  title={waitingTip(issue.waiting)}>{waitingTip(issue.waiting)}</span>
              </>
            : issue.in_pack ? <StatusBadge status="snatched" title="Covered by a pack that is still downloading." />
            : <StatusBadge status={issue.status === 'processed' && issue.has_comicinfo === 0 ? 'untagged' : issue.status} />
        )}
        </div>
        <div className="dm-issue-actions">
        {issue.status !== 'processed' && issue.status !== 'skipped' && !grabbed && (
          <button
            className="dm-download-action adm-icon-btn a-accent a-fs-11 a-flex a-ai-c a-gap-4" style={{ border: '1px solid color-mix(in srgb, var(--td-yellow) 20%, transparent)', padding: '3px 8px' }}
            onClick={openSearch}
          ><SearchIcon /> Search</button>
        )}
        {issue.status !== 'processed' && issue.status !== 'skipped' && !grabbed && onSkip && (
          <button
            className="adm-icon-btn a-muted a-fs-11" style={{ border: '1px solid color-mix(in srgb, color-mix(in srgb, var(--om-base) 85%, white) 53%, transparent)', padding: '3px 8px' }}
            onClick={(e) => { e.stopPropagation(); onSkip(issue); }}
            title="Skip this issue"
          >Skip</button>
        )}
        {issue.status === 'skipped' && onSkip && (
          <button
            className="adm-icon-btn a-faint a-fs-11" style={{ border: '1px solid color-mix(in srgb, color-mix(in srgb, var(--om-base) 85%, white) 40%, transparent)', padding: '3px 8px' }}
            onClick={(e) => { e.stopPropagation(); onSkip(issue, 'wanted'); }}
            title="Un-skip this issue"
          >Un-skip</button>
        )}
        {issue.status === 'processed' && issue.has_comicinfo === 0 && isAdmin() && (
          <button
            className="adm-icon-btn a-fs-11 a-flex a-ai-c a-gap-4" style={{ padding: '3px 8px', color: retagResult === 'ok' ? '#4caa60' : retagResult === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : issue.has_comicinfo === 0 ? '#cc80cc' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', border: `1px solid ${retagResult === 'ok' ? '#4caa6033' : retagResult === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : issue.has_comicinfo === 0 ? '#aa60aa55' : 'color-mix(in srgb, var(--om-base) 85%, white)'}`, opacity: retagging ? 0.6 : 1 }}
            onClick={retag} disabled={retagging}
            title={issue.has_comicinfo === 0 ? 'Missing ComicInfo.xml — click to tag' : 'Re-inject ComicInfo.xml with current metadata'}
          >
            {retagResult === 'ok' ? '✓ Retagged' : retagResult === 'error' ? '✕ Failed' : retagging ? '…' : issue.has_comicinfo === 0 ? '↺ Tag' : '↺ Retag'}
          </button>
        )}
        </div>
      </div>

      {inspecting && <DownloadIssueInspector issue={issue} onClose={() => setInspecting(false)} onChanged={onChanged}
        onRetag={retag} onSearch={() => { setInspecting(false); openSearch(); }} />}
      {expanded && (
        <div style={{ background: '#08080a', borderTop: '1px solid var(--om-base)', padding: '8px 12px 10px' }}>
          <div className="a-flex a-gap-6 a-mb-8">
            <input
              className="adm-input a-fs-12 a-grow" style={{ padding: '5px 10px' }}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch(query)}
              placeholder="Edit query and press Enter or click Search…"
              autoFocus
            />
            <button
              className="adm-btn adm-btn-primary a-fs-12" style={{ padding: '5px 12px' }}
              onClick={() => runSearch(query)}
              disabled={searching}
            >
              {searching ? '…' : <SearchIcon />}
            </button>
            <button
              className="adm-btn a-fs-12" style={{ padding: '5px 10px' }}
              onClick={() => setExpanded(false)}
            >
              ✕
            </button>
          </div>

          <SourceStatus items={sourceStatus} />
          {searchResults.length > 0 && searchResults.map((r, i) => {
            if (r._source === 'ddl') {
              // DDL (GetComics) row — needs link expansion
              const linkState = gcLinks[r.url];
              return (
                <div key={i} style={{ borderBottom: '1px solid color-mix(in srgb, var(--om-base) 90%, black)' }}>
                  <div className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0' }}>
                    <span className="a-info a-fs-10 a-noshrink a-fw7" style={{ minWidth: 70 }}>DDL</span>
                    <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                    <button
                      className="adm-icon-btn a-info a-fs-11 a-noshrink" style={{ border: '1px solid #6080cc33', padding: '3px 8px' }}
                      onClick={() => !linkState && fetchDdlLinks(r.url)}
                      disabled={linkState?.loading}
                    >
                      {linkState?.loading ? '…' : linkState ? '▲' : '▼ Links'}
                    </button>
                  </div>
                  {linkState && !linkState.loading && linkState.links.length > 0 && (
                    <div style={{ paddingLeft: 78, paddingBottom: 4 }}>
                      {linkState.links.map((link, j) => {
                        const dlState = gcGrabbing[link.url];
                        // The text above this set of buttons on GetComics (which file it is).
                        const heading = link.packLabel && link.packLabel !== linkState.links[j - 1]?.packLabel ? link.packLabel : null;
                        return (
                          <React.Fragment key={j}>
                          {heading && <div className="a-fs-10 a-muted" style={{ padding: j ? '6px 0 1px' : '0 0 1px' }}>{heading}</div>}
                          <div className="a-flex a-ai-c a-gap-6" style={{ padding: '2px 0' }}>
                            <span className="a-grow a-faint a-fs-10 a-ovh a-ellip a-nowrap">{link.label}</span>
                            <button
                              className="adm-icon-btn a-fs-10 a-noshrink a-flex a-ai-c a-gap-2" style={{ padding: '2px 8px', color: dlState === 'done' ? '#4caa60' : dlState === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : '#4caa60', border: `1px solid ${dlState === 'done' ? '#4caa6033' : dlState === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : '#4caa6033'}` }}
                              onClick={() => !dlState && grabDdl(link.url, link.label)}
                              disabled={!!dlState}
                            >
                              <DownloadIcon />
                              {dlState === 'done' ? ' Queued' : dlState === 'error' ? ' Error' : dlState === 'grabbing' ? ' …' : ' Grab'}
                            </button>
                          </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  )}
                  {linkState && !linkState.loading && linkState.links.length === 0 && (
                    <div className="a-faint a-fs-10" style={{ paddingLeft: 78, paddingBottom: 4 }}>No direct links — may need Mediafire/Mega.</div>
                  )}
                </div>
              );
            }
            // NZB row
            if (r._source === 'nzb') return (
              <div key={i} className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0', borderBottom: '1px solid var(--adm-g1)' }}>
                <span className="a-muted a-fs-11 a-noshrink" style={{ minWidth: 70 }}>{r.indexer}</span>
                {r.looksLikePack && (
                  <span className="a-fs-10 a-noshrink a-fw7 a-warn" style={{ padding: '1px 5px', borderRadius: 3, background: 'var(--adm-g3)', border: '1px solid #aa704044' }}>
                    ⚠ pack
                  </span>
                )}
                <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                <span className="a-faint a-fs-11 a-ta-r a-noshrink" style={{ minWidth: 50 }}>{fmt(r.size)}</span>
                <button
                  className="adm-icon-btn a-ok a-fs-11 a-flex a-ai-c a-gap-4 a-noshrink" style={{ border: '1px solid #4caa6033', padding: '3px 8px' }}
                  onClick={() => grab(r)}
                  disabled={grabbing}
                >
                  <DownloadIcon /> Grab
                </button>
              </div>
            );
            // Nyaa row
            if (r._source === 'nyaa') {
              const key = r.infoHash || r.title;
              const grabState = nyaaGrabbing[key];
              return (
                <div key={i} className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0', borderBottom: '1px solid var(--adm-g1)' }}>
                  <span className="a-ok a-fs-10 a-noshrink a-fw7" style={{ minWidth: 70 }}>
                    NYAA{r.type === 'pack' ? ' ◈' : r.volumeNumber ? ` v${r.volumeNumber}` : ''}
                  </span>
                  <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                  <span className="a-faint a-fs-11 a-ta-r a-noshrink" style={{ minWidth: 40 }}>{r.size}</span>
                  <span className="a-fs-10 a-ta-r a-noshrink" style={{ color: r.seeders > 5 ? '#4caa60' : r.seeders > 0 ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', minWidth: 28 }}>↑{r.seeders}</span>
                  <button
                    className="adm-icon-btn a-fs-11 a-noshrink a-flex a-ai-c a-gap-4" style={{ padding: '3px 8px', color: grabState === 'done' ? '#4caa60' : grabState === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : '#4caa60', border: `1px solid ${grabState === 'done' ? '#4caa6033' : grabState === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : '#4caa6033'}` }}
                    onClick={() => !grabState && grabNyaaIssue(r)}
                    disabled={!!grabState}
                  >
                    <DownloadIcon />
                    {grabState === 'done' ? ' Sent' : grabState === 'error' ? ' Error' : grabState === 'grabbing' ? ' …' : ' Grab'}
                  </button>
                </div>
              );
            }
            return null;
          })}

          {!searching && searchResults.length === 0 && (
            <div className="a-faint a-fs-12" style={{ padding: '4px 0' }}>
              Edit the query above and hit Search — try fewer or different words.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
