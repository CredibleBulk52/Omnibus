import DeleteCatalogAction from '../components/DeleteCatalogAction';
// ─── ReadingListDetail ────────────────────────────────────────────
// One reading list: comic hero (fanned covers, chips, progress, actions),
// then the reading order. Each entry is a numbered "chapter" with an
// optional narration-box note; its issues show as Timeline-style rows or
// as Top Shelf-style books on a wood shelf (toggle, remembered per viewer).
// Edit mode: drag or arrow entries, edit label/note, unpack, refresh,
// remove; inside unpacked entries, move or remove single issues.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Loading } from '../components/StateMessage';
import BackLink from '../components/BackLink';
import { tierColour } from '../components/tiers';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import '../comicReadingOrder.css';
import IssueShelf from '../components/ReadingListShelf';
import '../readingOrderActions.css';
import RunReadingPanel from '../components/RunReadingPanel';
import { runReadingState } from '../components/runReading';
import {
  rlApi, prefs, VisibilityChip, Modal, ListSettingsModal, RichText,
} from '../components/ReadingListBits';

import ReadingOrderHero from '../components/ReadingOrderHero';
import { useReadingTheme } from '../components/ReadingTheme';
import { reportProblem } from '../components/ReportProblem';
import AcquireBox, { AcquireDialog } from '../components/AcquireBox';
import { isAdmin, useAppSettings } from '../App';
import ManageMenu from '../components/ManageMenu';
import { useConfirm } from '../components/Confirm';

const COLLAPSE_AT = 12;
const TYPE_COLOUR = { issue: '#c8c0a8', range: '#8ab0e8', series: '#6fcf8a', event: '#e8151f', canon_run: '#f5c518', story: '#d79be8' };

export default function ReadingListDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // Shelf is the default view; Rows is the alternative. ('viewMode' key: earlier 'view' choices don't carry over.)
  const [view, setViewState] = useState(() => (prefs.get('viewMode', 'shelf') === 'rows' ? 'rows' : 'shelf'));
  const [expanded, setExpanded] = useState(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const confirm = useConfirm();
  const [noteEntry, setNoteEntry] = useState(null);
  const [matchIssue, setMatchIssue] = useState(null);
  const [acquireIssue, setAcquireIssue] = useState(null);   // missing issue: get it or request it
  const appSettings = useAppSettings();
  const acquireLabel = isAdmin() || appSettings.download_manager_admin_only !== 'true' ? '⬇ Get' : '✉ Request';
  const [requests, setRequests] = useState({});   // list issue id → my download request status
  const [sectionDraft, setSectionDraft] = useState(null);   // { position } for a new section banner
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const pollCount = useRef(0);

  const setView = v => { setViewState(v); prefs.set('viewMode', v); };

  const load = useCallback(async () => {
    try {
      const d = await rlApi('GET', `/api/reading-lists/${id}`);
      setData(d); setError('');
      rlApi('GET', `/api/reading-lists/${id}/requests`).then(r => setRequests(r || {})).catch(() => {});
    } catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { setData(null); pollCount.current = 0; load(); }, [load]);
  // Comic Book Guy's "Update this list" changes the list in the background: reload.
  useEffect(() => {
    const onChange = ev => { if (String(ev.detail?.id) === String(id)) load(); };
    window.addEventListener('omnibus:reading-list-changed', onChange);
    return () => window.removeEventListener('omnibus:reading-list-changed', onChange);
  }, [id, load]);

  // While an entry is still gathering its issues, check back every 3 s (up to ~2 min).
  const anyPending = !!data?.entries?.some(e => e.resolve_status === 'pending');
  useEffect(() => {
    if (!anyPending || pollCount.current > 40) return;
    const t = setTimeout(() => { pollCount.current++; load(); }, 3000);
    return () => clearTimeout(t);
  }, [anyPending, data, load]);

  // Flat reading order of owned issues, for Continue Reading.
  const reading = useMemo(() => runReadingState((data?.entries || []).flatMap(e => (e.issues || []).map(i => ({
    ...i, scanned_book_id: i.owned ? i.book_id : null,
    readProgress: { page: i.page || 0, completed: !!i.completed },
  })))), [data]);
  const current = reading.current;
  const covers = [...new Set((data?.entries || []).flatMap(e => (e.issues || []).filter(i => i.owned).map(i => i.book_id)))].slice(0, 4);

  const theme = useReadingTheme(data?.list, covers[0]);

  // Essentials live under /essentials/:id so the sidebar highlights Essentials,
  // not Reading Lists, however the list was opened.
  const location = useLocation();
  const visibility = data?.list?.visibility;
  useEffect(() => {
    if (!visibility) return;
    const want = visibility === 'essential' ? '/essentials/' : '/reading-lists/';
    if (!location.pathname.startsWith(want)) navigate(`${want}${id}${location.search}`, { replace: true });
  }, [visibility, id, location.pathname, location.search, navigate]);


  if (error && !data) {
    return (
      <div className="rl-page">
        <div className="rl-empty" style={{ marginTop: 60 }}>
          <div className="rl-empty-title">List not found</div>
          <div className="rl-empty-text">{error === 'Reading list not found' ? 'It may be private, or it was deleted.' : error}</div>
          <button className="btn btn-secondary" onClick={() => navigate('/collections')}>← Comic Box</button>
        </div>
      </div>
    );
  }
  if (!data) return <Loading label="Loading list…" />;

  const { list, entries, progress, can_edit: canEdit } = data;
  const readUrl = bookId => `/read/${bookId}?listId=${list.id}`;

  // ── Actions ────────────────────────────────────────────────────
  const act = async (fn) => {
    setBusy(true); setActionError('');
    try { await fn(); await load(); } catch (e) { setActionError(e.message); }
    setBusy(false);
  };
  const refresh = e => act(() => rlApi('POST', `/api/reading-lists/${list.id}/entries/${e.id}/refresh`).then(() => { pollCount.current = 0; }));
  const follow = () => act(() => rlApi(list.following ? 'DELETE' : 'POST', `/api/reading-lists/${list.id}/follow`));
  const copy = async () => {
    setBusy(true); setActionError('');
    try { const d = await rlApi('POST', `/api/reading-lists/${list.id}/copy`, {}); navigate(`/reading-lists/${d.id}`); }
    catch (e) { setActionError(e.message); }
    setBusy(false);
  };
  // Sharing a personal reading order (the comic box page's Manage › Share, 2026-11-04).
  const canShare = list.is_owner && (list.visibility === 'private' || list.visibility === 'public');
  const toggleShare = async () => {
    const on = list.visibility !== 'public';
    if (!on && !(await confirm({ title: 'Stop sharing this reading order?', message: 'Other readers will no longer see it, and it leaves the boxes of anyone following it.', confirmLabel: 'Stop sharing' }))) return;
    await act(() => rlApi('PATCH', `/api/reading-lists/${list.id}`, { visibility: on ? 'public' : 'private' }));
  };
  const openEditor = () => navigate(`${location.pathname.replace(/\/$/, '')}/edit`);
  const toggleExpand = eid => setExpanded(s => { const n = new Set(s); n.has(eid) ? n.delete(eid) : n.add(eid); return n; });

  // ── Layout: section banners, and chapters. Outside edit mode, neighbouring
  // single issues from the same series share one chapter under a series header.
  const blocks = [];
  {
    let part = 0, chap = 0, sec = null;
    entries.forEach((e, idx) => {
      if (e.type === 'section') {
        sec = { kind: 'section', e, idx, part: ++part, progress: { total: 0, owned: 0, read: 0 } };
        blocks.push(sec); return;
      }
      if (sec) { sec.progress.total += e.progress.total; sec.progress.owned += e.progress.owned; sec.progress.read += e.progress.read; }
      const last = blocks[blocks.length - 1];
      // Neighbouring single issues group by the series they were published in
      // (owned or not), not by library folder: Rebirth #1-6 filed in the Green
      // Lantern (2005) folder still read as "Green Lantern: Rebirth (2004)".
      const i0 = e.issues?.[0];
      const gkey = e.type === 'issue' && i0?.series_name ? `${String(i0.series_name).toLowerCase()}|${i0.volume_year || ''}` : null;
      if (gkey && last?.kind === 'chapter' && last.gkey === gkey) {
        last.entries.push(e);
        if (last.ssid !== e.scanned_series_id) last.ssid = null;   // link the header only when all share one folder
        return;
      }
      blocks.push({ kind: 'chapter', entries: [e], idx, num: ++chap, gkey, ssid: e.scanned_series_id || null });
    });
  }
  const setTier = (e, filter) => act(() => rlApi('PATCH', `/api/reading-lists/${list.id}/entries/${e.id}`, { tier_filter: filter }));

  let globalIdx = 0;
  const renderChapter = (b) => {
    const e = b.entries[0];
    const isGroup = b.entries.length > 1;
    const issues = b.entries.flatMap(x => x.issues.map((i, k) => ({ ...i, _entry: x, _first: k === 0 })));
    const prog = isGroup
      ? b.entries.reduce((a, x) => ({ total: a.total + x.progress.total, owned: a.owned + x.progress.owned, read: a.read + x.progress.read }), { total: 0, owned: 0, read: 0 })
      : e.progress;
    const autoOpen = current && issues.findIndex(i => i.book_id === current.book_id) >= COLLAPSE_AT;
    const isOpen = expanded.has(e.id) || autoOpen || issues.length <= COLLAPSE_AT + 2;
    const shown = isOpen ? issues : issues.slice(0, COLLAPSE_AT);
    const startIdx = globalIdx; globalIdx += issues.length;
    const showTier = !!(e.tier && e.tier.effective !== 'essential');
    const first = issues[0];
    const groupLabel = first ? `${first.series_name || 'Unknown series'}${first.volume_year ? ` (${first.volume_year})` : ''}` : e.label;
    return (
      <div key={e.id}
        className="rl-chapter">
        <div className="rl-chapter-head">
          <div className="rl-chapter-num">{b.num}</div>
          {isGroup
            ? (b.ssid ? <Link className="rl-chapter-title" to={`/series/${b.ssid}`}>{groupLabel}</Link> : <span className="rl-chapter-title">{groupLabel}</span>)
            : <ChapterTitle entry={e} />}
          {isGroup
            ? <span className="rl-chip rl-chip--issue">◆ {b.entries.length} Issues</span>
            : null}
          {e.unpacked && e.type !== 'issue' && e.type !== 'story' && e.resolve_source !== 'named' && (
            <span className="rl-chip rl-chip--copy" title={e.type === 'event' || e.type === 'canon_run' ? 'Your own copy' : 'No automatic updates'}>
              {e.type === 'event' || e.type === 'canon_run' ? '⧉ Your copy' : '❄ Frozen'}
            </span>
          )}
          {!isGroup && e.note && <div className="rl-note rl-note--inline">{e.note}</div>}
          {isGroup && view === 'shelf' && b.entries.filter(x => x.note).map(x => <div key={`n${x.id}`} className="rl-note rl-note--inline">{x.note}</div>)}
          {prog.total > 1 && <span className="rl-chapter-stat">{prog.read}/{prog.total} read</span>}
        </div>



        <TierBar entry={e} canEdit={canEdit} busy={busy} onChange={f => setTier(e, f)} />
        {!isGroup && <EntryStatus entry={e} canEdit={canEdit} onRetry={() => refresh(e)} />}

        {view === 'rows' ? (
          <div className="rl-rows">
            {shown.map((i, k) => (
              <React.Fragment key={`${i._entry.id}-${i.id ?? k}`}>
                {isGroup && i._first && i._entry.note && <div className="rl-note rl-note--inrow">{i._entry.note}</div>}
                <IssueRow issue={i} n={startIdx + k + 1} colour={TYPE_COLOUR[e.type]} showTier={showTier}
                  isCurrent={current && i.book_id === current.book_id}
                  onRead={() => navigate(readUrl(i.book_id))}
                  onMatch={canEdit && i.id != null && !i.owned ? () => setMatchIssue(i) : null}
                  onAcquire={i.id != null && !i.owned && requests[i.id] !== 'open' ? () => setAcquireIssue(i) : null} acquireLabel={acquireLabel}
                  reqStatus={!i.owned && i.id != null ? requests[i.id] : null}
                  linkedMissing={e.linked && !i.owned} />
              </React.Fragment>
            ))}
          </div>
        ) : (
          <IssueShelf issues={issues} showSeries={e.type === 'story'} current={current} onRead={i => navigate(readUrl(i.book_id))}
            onMatch={canEdit ? (i => setMatchIssue(i)) : null} requests={requests} onIssueChanged={load}
            onAcquire={i => setAcquireIssue(i)} acquireLabel={acquireLabel}
            expanded={expanded.has(e.id)} onMore={() => toggleExpand(e.id)} />
        )}
        {view === 'rows' && issues.length > COLLAPSE_AT + 2 && !autoOpen && (
          <button className="rl-more" onClick={() => toggleExpand(e.id)}>
            {isOpen ? '▲ Show fewer' : `▼ Show all ${issues.length} issues`}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="rl-page rl-themed comic-reading-order" style={theme.style}>
      {/* ── Hero ── */}
      <ReadingOrderHero title={list.name} className={`rl-hero--${list.visibility}`} themeStyle={theme.style}
        covers={covers} emptyText={entries.length ? 'Nothing owned yet' : 'Empty list'}
        back={<BackLink to={list.visibility === 'essential' ? '/essentials' : '/my-boxes'}
          label={list.visibility === 'essential' ? 'Essentials' : 'My Comic Boxes'}
          match={list.visibility === 'essential' ? undefined : /^\/(collections|my-boxes)$/} />}
        chips={<>
          <VisibilityChip visibility={list.visibility} />
          {list.source === 'ai' && <span className="rl-chip rl-chip--ai">✦ AI built</span>}
          {list.following && <span className="rl-chip rl-chip--following">★ Following</span>}
          {list.copied_from && list.is_owner && <span className="rl-chip rl-chip--copy">⧉ Copy</span>}
          {!list.is_owner && list.owner_name && <span className="rl-stat-line">curated by {list.owner_name}</span>}
        </>}
        actions={<>
          <RunReadingPanel kind="list" state={reading} onRead={(issue, restart) => navigate(readUrl(issue.book_id) + (restart ? '&restart=1' : ''))} />
          <div className="order-secondary-actions">
            {(canEdit || canShare) && (
              <ManageMenu id="reading-order-manage-menu" open={manageOpen} setOpen={setManageOpen}>
                {canEdit && <button onClick={() => { setManageOpen(false); openEditor(); }} title="Name, description, order, sections and notes; save once">✎ Open Editor</button>}
                {canShare && <button disabled={busy} onClick={() => { setManageOpen(false); toggleShare(); }}>{list.visibility === 'public' ? 'Stop sharing' : 'Share with other readers'}</button>}
                {(list.visibility === 'essential' ? isAdmin() : list.is_owner) && <DeleteCatalogAction endpoint={`/api/reading-lists/${id}`} label="reading order" name={list.name} onDeleted={()=>navigate(list.visibility === 'essential' ? '/essentials' : '/collections')} />}
              </ManageMenu>
            )}
            {!canEdit && <div className="order-utility-actions">
              <button className="order-editor-button order-report-button" title="Tell the admin about a wrong order or a wrong or missing issue" onClick={() => reportProblem({ type: 'list', id: list.id, label: list.name, kinds: ['order', 'metadata', 'other'] })}><span aria-hidden="true">⚑ </span>Report</button>
            </div>}
            {!list.is_owner && list.visibility === 'public' && (
              <button className="btn btn-secondary" onClick={follow} disabled={busy}>{list.following ? '★ Following' : '☆ Follow'}</button>
            )}
            <button className="btn btn-ghost" onClick={copy} disabled={busy} title="Make your own private copy you can change">⧉ Copy</button>
          </div>
        </>}>
        {list.description
          ? <p className="rl-hero-desc"><RichText text={list.description} /></p>
          : canEdit && <button className="rl-add-intro" onClick={openEditor}>+ Add an introduction</button>}
      </ReadingOrderHero>

      {/* ── Reading order ── */}
      <div className="rl-section">
        <div className="rl-section-head">
          <span className="rl-section-title">Reading Order</span>
          <span className="rl-stat-line">{progress.owned}/{progress.total} in your library</span>
          <div className="rl-toggle" role="group" aria-label="View">
            <button className={view === 'shelf' ? 'on' : ''} onClick={() => setView('shelf')}>▤ Shelf</button>
            <button className={view === 'rows' ? 'on' : ''} onClick={() => setView('rows')}>☰ Rows</button>
          </div>
        </div>

        {actionError && <div className="rl-error" style={{ margin: '8px 0' }}>{actionError}</div>}

        {entries.length === 0 && (
          <div className="rl-empty">
            <div className="rl-empty-title">Nothing here yet</div>
            <div className="rl-empty-text">
              Use <b>+ Add to a box</b> on a series, an issue, a Timeline event or a Top Shelf run to add it here.
              Series can be added whole or as a run of issues.
            </div>
            <button className="btn btn-secondary" onClick={() => navigate('/series')}>Browse series</button>
          </div>
        )}

        {blocks.map(b => b.kind === 'section' ? (
          <div key={`s${b.e.id}`}
            className="rl-sec">
            <div className="rl-sec-banner">
              <span className="rl-sec-part">Part {b.part}</span>
              <span className="rl-sec-title">{b.e.label}</span>
              {b.progress.total > 0 && <span className="rl-sec-prog">{b.progress.read}/{b.progress.total} read</span>}
            </div>
            {b.e.note && <div className="rl-note rl-note--sec">{b.e.note}</div>}
          </div>
        ) : renderChapter(b))}
      </div>

      {settingsOpen && (
        <ListSettingsModal list={list} onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); load(); }}
          onDeleted={() => navigate(list.visibility === 'essential' ? '/essentials' : '/collections')} />
      )}
      {acquireIssue && (
        <AcquireDialog base={`/api/reading-lists/${list.id}/issues/${acquireIssue.id}`} issue={acquireIssue}
          onClose={() => { setAcquireIssue(null); load(); }} />
      )}
      {matchIssue && (
        <MatchModal issue={matchIssue} listId={list.id} onClose={() => { setMatchIssue(null); load(); }}
          onMatched={() => { setMatchIssue(null); load(); }} />
      )}
      {noteEntry && (
        <EntryNoteModal entry={noteEntry} listId={list.id} onClose={() => setNoteEntry(null)}
          onSaved={() => { setNoteEntry(null); load(); }} />
      )}
      {sectionDraft && (
        <EntryNoteModal entry={null} create={sectionDraft} listId={list.id} onClose={() => setSectionDraft(null)}
          onSaved={() => { setSectionDraft(null); load(); }} />
      )}
    </div>
  );
}

// ─── Timeline tier switch (linked event entries) ──────────────────
const TIER_OPTS = [['essential', 'Essential'], ['recommended', '+ Recommended'], ['all', 'All']];
function TierBar({ entry: e, canEdit, busy, onChange }) {
  const t = e.tier;
  if (!t) return null;
  const desc = t.effective === 'all' ? 'all' : t.effective === 'essential' ? 'essential' : 'essential + recommended';
  return (
    <div className="rl-tierbar" role="group" aria-label="Event reading scope">
      
      {canEdit ? (
        <div className="rl-seg rl-seg--mini">
          {TIER_OPTS.map(([k, l]) => (
            <button key={k} type="button" className={t.effective === k ? 'on' : ''} aria-pressed={t.effective === k} disabled={busy || !t.counts[k]}
              onClick={() => k !== t.effective && onChange(k)}>{l} <span className="rl-seg-n">{t.counts[k]}</span></button>
          ))}
        </div>
      ) : (
        <span className="rl-stat-line">{t.counts[t.effective]} {desc} of {t.counts.all}</span>
      )}
      {t.effective !== t.filter && <span className="rl-seg-hint">Nothing is marked {t.filter} in this event, so more is shown.</span>}
      <Link className="rl-tierbar-link" to={`/events/${e.ref_id}`}>Full event ({t.counts.all}) →</Link>
    </div>
  );
}

// ─── Chapter title (links to the source page) ─────────────────────
function ChapterTitle({ entry: e }) {
  const to = e.type === 'event' ? `/events/${e.ref_id}`
    : e.type === 'canon_run' ? `/canon/run/${e.ref_id}`
    : (e.type === 'series' || e.type === 'range' || e.type === 'issue') && e.scanned_series_id ? `/series/${e.scanned_series_id}`
    : e.resolve_source === 'named' && e.issues?.find(i => i.series_id) ? `/series/${e.issues.find(i => i.series_id).series_id}`   // folder that holds it
    : null;
  return to && !e.source_missing
    ? <Link className="rl-chapter-title" to={to}>{e.label}</Link>
    : <span className="rl-chapter-title" style={{ cursor: 'default' }}>{e.label}</span>;
}

function EntryStatus({ entry: e, canEdit, onRetry }) {
  if (e.source_missing) {
    return <div className="rl-status rl-status--error">✕ The original {e.type === 'event' ? 'Timeline event' : 'Top Shelf run'} was removed.</div>;
  }
  if (e.resolve_status === 'pending') {
    return <div className="rl-status"><span className="rl-spin" /> Gathering the issue list…</div>;
  }
  if (e.resolve_status === 'partial') {
    return (
      <div className="rl-status rl-status--warn">
        ⚠ Showing only the issues you own. Omnibus couldn't get the full issue list yet and will try again tonight.
        {canEdit && <button className="rl-ctrl" onClick={onRetry}>↻ Try now</button>}
      </div>
    );
  }
  if (e.resolve_status === 'error') {
    return (
      <div className="rl-status rl-status--error">
        ✕ Couldn't load this entry's issues.
        {canEdit && <button className="rl-ctrl" onClick={onRetry}>↻ Retry</button>}
      </div>
    );
  }
  if (!e.issues.length) {
    return <div className="rl-status">{e.type === 'range' ? 'No issues in this range yet.' : 'No issues yet.'}</div>;
  }
  return null;
}

// ─── Rows view ────────────────────────────────────────────────────
const REQ_LABEL = { open: 'Requested', added: 'Added to downloads', dismissed: 'Request dismissed' };
function IssueRow({ issue: i, n, colour, isCurrent, onRead, onMatch, onAcquire, acquireLabel, linkedMissing, showTier, reqStatus }) {
  const inProg = i.owned && !i.completed && i.page > 0;
  return (
    <div className={`rl-row ${i.owned ? '' : 'rl-row--missing'} ${isCurrent ? 'rl-row--current' : ''}`}
      style={{ borderLeft: `3px solid ${i.owned ? colour : 'transparent'}` }}
      onClick={i.owned ? onRead : undefined}
      title={i.owned ? 'Read' : linkedMissing ? 'Not in your library. Unpack this entry to match it by hand.' : 'Not in your library'}>
      <div className="rl-row-num">{n}</div>
      <div className="rl-thumb">
        {i.owned
          ? <img src={`/api/books/${i.book_id}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />
          : <div className="rl-thumb-missing">#{i.issue_number ?? '?'}</div>}
        {i.completed && <div className="rl-thumb-tick">✓</div>}
        {inProg && <div className="rl-thumb-bar" style={{ width: `${(i.page / (i.page + 1)) * 100}%` }} />}
        {i.owned && !i.completed && !inProg && !isCurrent && <div className="rl-thumb-unread" />}
        {isCurrent && <div className="rl-thumb-bookmark" title="Continue reading here" />}
      </div>
      <div className="rl-row-body">
        <div className="rl-row-title">
          <span>{i.series_name || 'Unknown series'}</span>
          <span className="rl-row-num-inline">#{i.issue_number ?? '?'}</span>
          {i.volume_year && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({i.volume_year})</span>}
          {i.manually_matched && i.owned && <span className="rl-matched" title="Matched by hand">✎ matched</span>}
        </div>
        {i.title && <div className="rl-row-sub">“{i.title}”</div>}
      </div>
      {showTier && i.tier && <span className="rl-pill" style={{ color: tierColour(i.tier) }}>{i.tier}</span>}
      {!i.owned && !onMatch && <span className="rl-pill rl-pill--missing">Not in library</span>}
      {reqStatus && REQ_LABEL[reqStatus] && <span className={`rl-pill rl-pill--req rl-pill--req-${reqStatus}`}>{REQ_LABEL[reqStatus]}</span>}
      {onAcquire && (
        <button className="rl-match-btn" onClick={ev => { ev.stopPropagation(); onAcquire(); }}>{acquireLabel}</button>
      )}
      {onMatch && (
        <button className="rl-match-btn" onClick={ev => { ev.stopPropagation(); onMatch(); }}
          title={i.owned ? 'Match this issue to a different book in your library' : 'Find this issue in your library'}>
          ⚲ {i.owned ? 'Rematch' : 'Find in library'}
        </button>
      )}
      {inProg && <span className="rl-pill rl-pill--reading">Reading</span>}
      {i.completed && <span className="rl-pill rl-pill--done">Read</span>}
    </div>
  );
}

// ─── Shelf view ───────────────────────────────────────────────────
// ─── Entry title + note editor ────────────────────────────────────
// entry = null + create = { position } → new section banner.
function EntryNoteModal({ entry, create, listId, onClose, onSaved }) {
  const isSection = !!create || entry?.type === 'section';
  const [label, setLabel] = useState(entry?.label || '');
  const [note, setNote] = useState(entry?.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (isSection && !label.trim()) { setError('Give the section a title.'); return; }
    setBusy(true); setError('');
    try {
      if (create) await rlApi('POST', `/api/reading-lists/${listId}/entries`, { type: 'section', label, note, position: create.position });
      else await rlApi('PATCH', `/api/reading-lists/${listId}/entries/${entry.id}`, { label, note });
      onSaved();
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title={create ? 'New Section' : isSection ? 'Edit Section' : 'Edit Chapter'} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : create ? 'Add section' : 'Save'}</button>
      </>}>
      <div className="rl-modal-body">
        <label className="rl-field">
          <span className="rl-label">{isSection ? 'Section title' : 'Chapter title'}</span>
          <input className="rl-input" value={label} maxLength={300} autoFocus={isSection} onChange={ev => setLabel(ev.target.value)}
            placeholder={isSection ? 'e.g. Fall and Parallax' : 'e.g. Emerald Twilight'} onKeyDown={ev => ev.key === 'Enter' && save()} />
        </label>
        <label className="rl-field">
          <span className="rl-label">Note (shows as a caption box)</span>
          <textarea className="rl-input" value={note} maxLength={2000} onChange={ev => setNote(ev.target.value)}
            placeholder={isSection ? 'e.g. Coast City is destroyed and Hal breaks.' : "e.g. Hal's fall. Read before Zero Hour."} />
        </label>
        {note && <div className="rl-note" style={{ marginLeft: 0 }}>{note}</div>}
        {error && <div className="rl-error">{error}</div>}
      </div>
    </Modal>
  );
}

// ─── Manual match: pick the library book for a stored list issue ──
function MatchModal({ issue, listId, onClose, onMatched }) {
  const [query, setQuery] = useState(issue.series_name || '');
  const [num, setNum] = useState(issue.issue_number || '');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const search = useCallback(async (q = query, n = num) => {
    if (!q.trim()) return;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (String(n).trim()) params.set('issue', String(n).trim());
      const d = await rlApi('GET', `/api/events/book-search?${params}`);
      setResults(Array.isArray(d) ? d : []);
    } catch (e) { setError(e.message); setResults([]); }
    setBusy(false);
  }, [query, num]);
  const searched = useRef(false);
  useEffect(() => { if (!searched.current) { searched.current = true; search(); } }, [search]);   // first search on open

  const pick = async (bookId) => {
    setBusy(true); setError('');
    try { await rlApi('PATCH', `/api/reading-lists/${listId}/issues/${issue.id}/match`, { bookId }); onMatched(); }
    catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title="Find in Library" onClose={onClose} width={580}
      footer={<>
        {issue.owned && (
          <button className="btn btn-ghost" style={{ marginRight: 'auto', color: '#ff7a6a' }} onClick={() => pick(null)} disabled={busy}>Clear match</button>
        )}
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </>}>
      <div className="rl-modal-sub">
        {issue.series_name} #{issue.issue_number}{issue.volume_year ? ` (${issue.volume_year})` : ''}{issue.title ? ` · “${issue.title}”` : ''}
      </div>
      <div className="rl-modal-body">
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="rl-input" style={{ flex: 1 }} value={query} placeholder="Series name"
            onChange={ev => setQuery(ev.target.value)} onKeyDown={ev => ev.key === 'Enter' && search()} />
          <input className="rl-input" style={{ width: 76 }} value={num} placeholder="#"
            onChange={ev => setNum(ev.target.value)} onKeyDown={ev => ev.key === 'Enter' && search()} />
          <button className="btn btn-primary" onClick={() => search()} disabled={busy}>{busy ? '…' : 'Search'}</button>
        </div>
        {results === null && <div className="rl-status"><span className="rl-spin" /> Searching your library…</div>}
        {results && results.length === 0 && (
          <div className="rl-status">No books found. Try fewer words, or clear the issue number.</div>
        )}
        {results && results.length === 0 && !issue.owned && issue.id != null && (
          <AcquireBox base={`/api/reading-lists/${listId}/issues/${issue.id}`} issue={issue} />
        )}
        {results && results.length > 0 && (
          <div className="rl-picklist" style={{ maxHeight: '45vh' }}>
            {results.map(b => (
              <button key={b.id} type="button" className="rl-pick" onClick={() => pick(b.id)} disabled={busy}>
                <img src={`/api/books/${b.id}/thumbnail`} alt="" style={{ width: 30, height: 45, objectFit: 'cover', border: '1.5px solid #000', flexShrink: 0 }}
                  onError={ev => { ev.target.style.visibility = 'hidden'; }} />
                <span className="rl-pick-name">
                  {b.series_name} <span className="rl-row-num-inline">#{b.issue_number}</span>
                  {b.series_year && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> ({b.series_year})</span>}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.filename}</span>
                </span>
                <span className="rl-pick-tag" style={{ color: 'var(--td-yellow)' }}>{issue.book_id === b.id ? '✓ Current' : 'Select'}</span>
              </button>
            ))}
          </div>
        )}
        {error && <div className="rl-error">{error}</div>}
      </div>
    </Modal>
  );
}


