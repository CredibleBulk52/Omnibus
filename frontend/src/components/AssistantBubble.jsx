// ─── AssistantBubble ──────────────────────────────────────────────
// Floating speech-bubble button on every Shell page that opens the Comic
// Book Guy chat panel. The reader mounts it too, with the `reader` prop:
// the context is then the open issue and page, the chat is kept per issue,
// and "Show him this page" sends the current page as an image. The page the user is on (series,
// event, Top Shelf run, reading list) is sent as context, so "is this worth
// reading?" works from anywhere. Conversation lives in component state and
// sessionStorage (survives navigation and reloads within the tab).
// Styles: ../assistant.css. Backend: backend/assistant.js.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import '../assistant.css';
import SelectionSetup from './SelectionSetup';
import { AiInfo } from './AiInfo';

const STORE = 'omnibus.cbg.chat';
const load = (key = STORE) => { try { return JSON.parse(sessionStorage.getItem(key) || '[]'); } catch { return []; } };
const save = (msgs, key = STORE) => { try { sessionStorage.setItem(key, JSON.stringify(msgs.slice(-30))); } catch {} };

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(d.error || `Request failed (${r.status})`); e.data = d; throw e; }
  return d;
}

// What the user is looking at, from the URL. Read only when a question is
// sent (no requests on navigation); the server turns it into a PAGE line.
const PAGE_LABEL = {
  home: 'Home', series_index: 'Series', series: 'this series', collections: 'Comic Box', collection: 'this comic box',
  top_shelf: 'Top Shelf', top_shelf_category: 'this Top Shelf shelf', canon_run: 'this Top Shelf run',
  timeline: 'Timeline', event: 'this event', essentials: 'Essentials', reading_lists: 'Reading Lists',
  reading_list: 'this reading list', search: 'Search',
  editor: 'the editor', my_requests: 'My requests', appearance: 'Appearance',
};
const OTHER_LABEL = { downloads: 'Downloads', offline: 'Offline', settings: 'Settings',
  'cv-admin': 'Library', library: 'Library' };
export function pageContext(pathname, search) {
  const q = new URLSearchParams(search || '');
  let m;
  if (pathname === '/' || pathname === '') return { page: 'home' };
  // The editors first: /…/edit is the editor, not the page it edits (2026-10-30).
  if ((m = pathname.match(/^\/(reading-lists|essentials)\/(\d+)\/edit/))) return { page: 'editor', kind: 'list', id: m[2] };
  if ((m = pathname.match(/^\/events\/([^/]+)\/edit/))) return { page: 'editor', kind: 'event', id: m[1] };
  if ((m = pathname.match(/^\/canon\/run\/([^/]+)\/edit/))) return { page: 'editor', kind: 'run', id: m[1] };
  if (pathname === '/series') return { page: 'series_index', q: q.get('q') || undefined };
  if ((m = pathname.match(/^\/series\/([^/]+)/))) return { page: 'series', seriesId: m[1] };
  if (pathname === '/collections' || pathname === '/my-boxes') return { page: 'collections' };
  if ((m = pathname.match(/^\/collections\/([^/]+)/))) return { page: 'collection', collectionId: m[1] };
  if ((m = pathname.match(/^\/canon\/run\/([^/]+)/))) return { page: 'canon_run', runId: m[1] };
  if ((m = pathname.match(/^\/canon\/([^/]+)/))) return { page: 'top_shelf_category', category: m[1] };
  if (pathname === '/canon') return { page: 'top_shelf' };
  if ((m = pathname.match(/^\/events\/([^/]+)/))) return { page: 'event', eventId: m[1] };
  if (pathname === '/events') return { page: 'timeline' };
  if (pathname === '/essentials') return { page: 'essentials' };
  if ((m = pathname.match(/^\/(?:reading-lists|essentials)\/(\d+)/))) return { page: 'reading_list', listId: m[1] };
  if (pathname === '/reading-lists') return { page: 'reading_lists', tab: q.get('tab') || 'mine' };
  if (pathname === '/search') return { page: 'search', q: q.get('q') || undefined };
  if (pathname === '/my-requests') return { page: 'my_requests' };
  if (pathname === '/appearance') return { page: 'appearance' };
  const first = pathname.split('/')[1];
  return { page: 'other', label: OTHER_LABEL[first] || first };
}
// Starter questions: two or three that fit the page's purpose, then the
// page tour. Kept general (no named characters) so they work for anyone.
const TOUR = 'How do I use this page?';
// Recaps (user 2026-10-19): starter questions, no new buttons. In the reader, and
// first on a series page once the reader has started that series. Quick: from summaries
// already in the library (free); Full: the detailed recap (looks things up).
const QUICK_RECAP = 'Quick refresher';
const FULL_RECAP = 'Full recap';
const STARTERS = {
  home:               ['What should I read next?', 'Surprise me with something from my library.'],
  series_index:       ['Recommend a great series I already own.', 'Help me find a series I half-remember.', 'What genres does this library cover?'],
  series:             ['Is this series worth my time?', 'Where should I start in this series?', 'What should I read after this?'],
  collections:        ['Which box should I dig into first?', 'What is each era of comics known for?'],
  collection:         ['What are the highlights in this box?', 'Where should a newcomer to this box start?'],
  top_shelf:          ['Which of these fits what I like?', 'Which is the easiest to jump into cold?', 'Which of these became films or shows?'],
  top_shelf_category: ['Which of these fits what I like?', 'Which is the easiest to jump into cold?'],
  canon_run:          ['Why is this run so acclaimed?', 'Do I need to read anything first?', 'What else reads like this?'],
  timeline:           ['Which events are actually worth reading?', 'What is a good first crossover?'],
  event:              ['Do I need to read anything before this?', 'Which tie-ins actually matter?', 'What happens after this?'],
  essentials:         ['Which of these suits a new reader?', 'Build me a reading order for a character I like.'],
  reading_lists:      ['Build me a reading list.', 'What should I add to my lists?'],
  reading_list:       ['Is anything missing from this list?', 'Is this the right order?', 'What should I read after this?'],
  search:             ['Help me find something I half-remember.'],
  reader:             [QUICK_RECAP, FULL_RECAP, 'Who is on this page?'],
  // Reader, on the end-of-issue card.
  reader_end:         ['What did you think of this issue?', 'What should I read next?', 'What did I miss in this issue?'],
};
function starters(ctx, started) {
  const base = STARTERS[ctx.page] || ['What can you help me with?'];
  // A started series: the two recaps, then what to read next (where to start no longer applies).
  return [...(ctx.page === 'series' && started ? [QUICK_RECAP, FULL_RECAP, base[2] || base[0]] : base), TOUR];
}

export default function AssistantBubble({ reader = null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const storeKey = reader ? `${STORE}.reader.${reader.bookId}` : STORE;
  const keyRef = useRef(storeKey);
  const [status, setStatus] = useState(null);
  // In the reader the panel is opened from the reader's top bar (Ask button).
  const [openState, setOpenState] = useState(false);
  const open = reader ? !!reader.open : openState;
  const setOpen = reader ? (v => reader.onOpenChange?.(!!v)) : setOpenState;
  const [msgs, setMsgs] = useState(() => load(storeKey));
  const [attach, setAttach] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const ctx = reader
    ? { page: 'reader', bookId: reader.bookId, pageIndex: reader.page, pageCount: reader.pageCount, listId: reader.listId || undefined, eventId: reader.eventId || undefined, runId: reader.runId || undefined }
    : pageContext(location.pathname, location.search);
  const where = reader ? `${reader.title || 'this issue'}${reader.pageCount ? `, page ${reader.page + 1} of ${reader.pageCount}` : ''}`
    : ctx.page === 'other' ? ctx.label : PAGE_LABEL[ctx.page];

  const refreshStatus = useCallback(() => {
    api('GET', '/api/assistant/status').then(setStatus).catch(() => setStatus({ enabled: false }));
  }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);
  // Series page: has the reader started it? (the recap starters)
  const [started, setStarted] = useState(false);
  const seriesId = !reader && ctx.page === 'series' ? ctx.seriesId : null;
  useEffect(() => {
    setStarted(false);
    if (!seriesId) return;
    api('GET', `/api/assistant/series-started/${encodeURIComponent(seriesId)}`).then(d => setStarted(!!d?.started)).catch(() => {});
  }, [seriesId]);
  // While he works: the recap's progress line, when one is gathering summaries.
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    if (!busy) { setProgress(null); return; }
    let stop = false;
    const poll = () => api('GET', '/api/assistant/recap-progress').then(d => { if (!stop) setProgress(d && d.total ? d : null); }).catch(() => {});
    const t = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [busy]);
  // Reader: a new issue gets its own conversation.
  useEffect(() => {
    if (keyRef.current === storeKey) return;
    keyRef.current = storeKey; setMsgs(load(storeKey)); setAttach(false);
  }, [storeKey]);
  useEffect(() => { save(msgs, keyRef.current); }, [msgs]);
  const bodyRef = useRef(null);
  // Open at the latest message. Scroll the message list itself, not the page behind it.
  useEffect(() => {
    if (!open) return;
    const b = bodyRef.current;
    if (b) b.scrollTop = b.scrollHeight; else endRef.current?.scrollIntoView({ block: 'end' });
    inputRef.current?.focus({ preventScroll: true });
  }, [open, msgs, busy]);
  // Reader: the panel never grows past the visible screen (browser bars and the
  // on-screen keyboard included), so the header and the reply box both stay in view.
  const [vv, setVv] = useState(null);
  useEffect(() => {
    if (!open || !reader || !window.visualViewport) return;
    const v = window.visualViewport;
    const upd = () => setVv({ h: v.height, top: v.offsetTop });
    upd();
    v.addEventListener('resize', upd);
    v.addEventListener('scroll', upd);
    return () => { v.removeEventListener('resize', upd); v.removeEventListener('scroll', upd); };
  }, [open, !!reader]);
  const panelStyle = reader && vv
    ? (window.innerWidth < 768
        ? { top: vv.top, bottom: 'auto', height: vv.h, maxHeight: vv.h }
        : { bottom: 12, height: Math.min(640, vv.h - 24), maxHeight: vv.h - 24 })
    : undefined;
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Other pages can hand him a question (the New list dialog's Generate with AI tab):
  // window event omnibus:assistant-ask { text }. Opens the chat and asks it.
  const askRef = useRef(null);
  const [pendingAsk, setPendingAsk] = useState(null);
  useEffect(() => {
    if (reader) return undefined;
    const onAsk = e => { const t = e.detail?.text; if (t) { setPendingAsk(t); setOpenState(true); } };
    window.addEventListener('omnibus:assistant-ask', onAsk);
    return () => window.removeEventListener('omnibus:assistant-ask', onAsk);
  }, [reader]);
  useEffect(() => {
    if (!pendingAsk || !open || busy || !status?.enabled) return;
    setPendingAsk(null);
    askRef.current?.(pendingAsk);
  }, [pendingAsk, open, busy, status]);

  if (!status?.enabled) return null;
  const name = status.name || 'Comic Book Guy';
  const left = status.unlimited ? null : Math.max(0, (status.daily_limit || 0) - (status.used_today || 0));
  const outOfQuestions = left === 0 && status.daily_limit > 0;

  // extra: added to the context (intake_answer when a choice chip or a rebuild button was pressed).
  const ask = async (text, extra) => {
    const q = (text ?? input).trim();
    if (!q || busy || outOfQuestions) return;
    const next = [...msgs, { role: 'user', content: q }];
    setMsgs(next); setInput(''); setBusy(true); setError('');
    try {
      const d = await api('POST', '/api/assistant/chat', {
        // His earlier answers go back with the items they linked, so follow-ups
        // ("what order should I read them in?") keep the same books in view.
        messages: next.map(m => (m.role === 'assistant'
          ? { role: m.role, content: m.content, refs: (m.refs || []).map(r => ({ type: r.type, id: r.id, label: r.label })),
              // The list he proposed, so a follow-up can revise it.
              list: m.proposed_list?.edits?.length ? m.proposed_list.edits.map(o => `[change] ${o.display}`).slice(0, 60)
                : m.proposed_list?.entries?.length ? m.proposed_list.entries.map(e => (e.type === 'section' ? `== ${e.display} ==` : e.display)).slice(0, 60) : undefined,
              // His question about a new list, or the brief a list was built to: the server
              // rebuilds the choices from its own stock wording.
              intake: m.intake ? { kind: m.intake.kind, subject: m.intake.subject, options: m.intake.kind === 'custom' ? m.intake.options.map(o => o.label) : undefined, saved: m.intake.saved } : undefined,
              brief: m.brief ? { kind: m.brief.kind, subject: m.brief.subject, options: m.brief.options, saved: m.brief.saved, notes: m.brief.notes } : undefined }
          : { role: m.role, content: m.content })),
        context: { ...(attach ? { ...ctx, attachPage: true } : ctx), ...(extra || {}) },
      });
      setAttach(false);
      setMsgs(m => [...m, { role: 'assistant', content: d.answer, refs: d.refs || [], proposed_list: d.proposed_list || null, target_list: d.target_list || null, sources: d.sources || [],
        selection_setup: d.selection_setup || null, proposed_box: d.proposed_box || null,
        intake: d.intake || null, brief: d.brief || null,
        page_viewed: d.page_viewed || null,
        usage_id: d.usage_id || null, ai_request: d.ai_request || null, question: q, page: ctx.page || '' }]);
      setStatus(s => ({ ...s, used_today: d.used_today, daily_limit: d.daily_limit, unlimited: d.unlimited }));
    } catch (e) {
      setError(e.message);
      if (e.data?.used_today != null) setStatus(s => ({ ...s, used_today: e.data.used_today }));
    }
    setBusy(false);
  };
  askRef.current = ask;
  // Thumbs up/down. Thumbs-down sends the question and answer so the admin
  // can see what went wrong; 0 clears the rating.
  const rate = async (i, rating) => {
    const m = msgs[i]; if (!m?.usage_id) return;
    setMsgs(ms => ms.map((x, k) => (k === i ? { ...x, rating } : x)));
    try { await api('POST', '/api/assistant/feedback', { usage_id: m.usage_id, rating, question: m.question || '', answer: m.content || '', page: m.page || '' }); }
    catch { setMsgs(ms => ms.map((x, k) => (k === i ? { ...x, rating: m.rating || 0 } : x))); }
  };
  const reset = () => { setMsgs([]); setError(''); };
  const go = url => { if (window.innerWidth < 768 || reader) setOpen(false); navigate(url); };

  return (
    <>
      {!open && !reader && (
        <button className={`cbg-fab${reader ? ' cbg-fab--reader' : ''}`} data-chrome="1" onClick={e => { e.stopPropagation(); setOpen(true); }} aria-label={`Ask ${name}`} title={`Ask ${name}`}>
          <span className="cbg-fab-face"><img src={status.avatar_url} alt="" draggable={false} /></span>
          <span className="cbg-fab-bubble">?!</span>
        </button>
      )}

      {open && (
        <div className={`cbg-panel${reader ? ' cbg-panel--reader' : ''}`} style={panelStyle} role="dialog" aria-label={`${name} chat`} data-chrome="1" onClick={e => e.stopPropagation()}>
          <div className="cbg-head">
            <span className="cbg-head-face"><img src={status.avatar_url} alt="" /></span>
            <div className="cbg-head-text">
              <div className="cbg-head-name">{name}</div>
              <div className="cbg-head-sub">
                {status.unlimited ? 'Proprietor on duty' : `${left} of ${status.daily_limit} questions left today`}
              </div>
            </div>
            {msgs.length > 0 && <button className="cbg-head-btn" onClick={reset} title="Start over">↺</button>}
            <button className="cbg-head-btn" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          {where && <div className="cbg-where">📍 {reader ? 'Reading' : 'Looking at'} <b>{where}</b></div>}
          <div className="cbg-body" ref={bodyRef}>
            {msgs.length === 0 && (
              <div className="cbg-welcome">
                <div className="cbg-bubble cbg-bubble--him">
                  Ah. A customer. I am {name}, keeper of continuity and judge of crossovers. Ask your question, and do try to make it interesting.
                </div>
                <div className="cbg-starters">
                  {starters(reader?.atEnd ? { page: 'reader_end' } : ctx, started).map(s => <button key={s} className="cbg-starter" onClick={() => ask(s)}>{s}</button>)}
                </div>
              </div>
            )}

            {msgs.map((m, i) => m.role === 'user'
              ? <div key={i} className="cbg-you"><div className="cbg-caption">{m.content}</div></div>
              : <HisReply key={i} msg={m} onGo={go} onRate={r => rate(i, r)} last={i === msgs.length - 1} locked={busy || outOfQuestions}
                  onSetup={values => ask(values.format === 'box' ? `A box of series: ${values.subject}.` : `A reading order: ${values.subject}.`, { selection_setup: values })}
                  onCancelSetup={() => setMsgs(ms => ms.map((x, k) => k === i ? { ...x, selection_setup: null } : x))}
                  onBoxSaved={id => setMsgs(ms => ms.map((x, k) => k === i ? { ...x, proposed_box: { ...x.proposed_box, saved_id: id } } : x))}
                  onPick={(o, rebuild) => ask(rebuild ? `Rebuild it as ${o.label}.` : o.label, { intake_answer: { option: o.id } })} />)}

            {busy && <div className="cbg-bubble cbg-bubble--him cbg-thinking"><span /><span /><span />{progress && <em className="cbg-progress">Digging out back issues… {Math.min(progress.done, progress.total)} of {progress.total}</em>}</div>}
            {error && <div className="cbg-error">{error}</div>}
            <div ref={endRef} />
          </div>

          {reader && (
            <label className={`cbg-attach${attach ? ' on' : ''}`} title="Send him the page you are on with your next question (costs a little more)">
              <input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} /> Show him this page
            </label>
          )}
          <form className="cbg-input" onSubmit={e => { e.preventDefault(); ask(); }}>
            <textarea ref={inputRef} rows={1} value={input} maxLength={1500}
              placeholder={outOfQuestions ? 'The shop is closed until tomorrow.' : `Ask ${name}…`}
              disabled={outOfQuestions}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
            <button type="submit" className="cbg-send" disabled={busy || !input.trim() || outOfQuestions}>Ask</button>
          </form>
        </div>
      )}
    </>
  );
}

const REF_ICON = { series: '▥', book: '◆', event: '⚡', canon_run: '★', reading_list: '☰' };

// His answers may use **bold** and *italic* (titles). Rendered as elements,
// never as HTML, so nothing in the text can inject markup.
function Rich({ text }) {
  const parts = String(text || '').split(/(\*\*[^*\n]+?\*\*|\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\n]+?_(?![\w]))/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (/^\*[^*]+\*$/.test(p) || /^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    return p;
  });
}

function HisReply({ msg, onGo, onRate, onPick, onSetup, onCancelSetup, onBoxSaved, last, locked }) {
  const intake = msg.intake;
  const rec = id => intake && intake.kind !== 'custom' && id === intake.default;   // a custom question has no recommended choice
  return (
    <div className="cbg-him">
      <div className="cbg-bubble cbg-bubble--him"><Rich text={msg.content} /></div>
      {msg.selection_setup && last && <SelectionSetup setup={msg.selection_setup} locked={locked} onSubmit={onSetup} onCancel={onCancelSetup} />}
      {(msg.proposed_box?.series?.length > 0 || msg.proposed_box?.missing?.length > 0) && <ProposedBox box={msg.proposed_box} onGo={onGo} onSaved={onBoxSaved} />}
      {intake && last && (
        // His question about a new list: the choices, in the stock wording (he never lists them himself).
        <div className="cbg-choices" role="group" aria-label={intake.title || 'Choose one'}>
          {intake.title && <div className="cbg-choices-title">{intake.title}</div>}
          {intake.options.map(o => (
            <button key={o.id} className={`cbg-choice${rec(o.id) ? ' cbg-choice--rec' : ''}`} onClick={() => onPick(o)} disabled={locked}>
              <span className="cbg-choice-label">{o.label}{rec(o.id) && <span className="cbg-choice-rec">Recommended</span>}</span>
              {o.text && <span className="cbg-choice-text">{o.text}</span>}
            </button>
          ))}
          {intake.kind !== 'custom' && <div className="cbg-choices-hint">Or just say “go”.</div>}
        </div>
      )}
      {msg.page_viewed && <div className="cbg-viewed">👁 Looked at page{String(msg.page_viewed).includes(',') ? 's' : ''} {msg.page_viewed}</div>}
      {msg.refs?.length > 0 && (
        <div className="cbg-refs">
          {msg.refs.map(r => (
            <button key={`${r.type}:${r.id}`} className="cbg-ref" onClick={() => onGo(r.url)} title={r.label}>
              {r.cover_book_id ? <img src={`/api/books/${r.cover_book_id}/thumbnail`} alt="" />
                : r.cover_series_id ? <img src={`/api/series/${r.cover_series_id}/thumbnail`} alt="" />
                : <span className="cbg-ref-icon">{REF_ICON[r.type] || '◈'}</span>}
              <span className="cbg-ref-label">{r.label}</span>
            </button>
          ))}
        </div>
      )}
      {msg.proposed_list && (msg.proposed_list.mode === 'edit'
        ? <ProposedEdits list={msg.proposed_list} target={msg.target_list} onGo={onGo} />
        : <ProposedList list={msg.proposed_list} target={msg.target_list} onGo={onGo} />)}
      {msg.brief && msg.proposed_list && (
        // What the list was built for, and the other kinds, so a reader who never saw the question can find them.
        <div className="cbg-built">
          Built for: <b>{msg.brief.option.label}</b>
          {msg.brief.alternatives?.length > 0 && (<>
            <span className="cbg-built-sep">·</span> Also available:{' '}
            {msg.brief.alternatives.map((a, k) => (
              <React.Fragment key={a.id}>{k > 0 && <span className="cbg-built-sep">·</span>}
                <button className="cbg-built-alt" onClick={() => onPick(a, true)} disabled={locked || !last} title={last ? `Rebuild the list as ${a.label}` : 'Rebuild from the latest list'}>{a.label}</button>
              </React.Fragment>))}
          </>)}
        </div>
      )}
      {msg.sources?.length > 0 && (
        <div className="cbg-sources">
          <span>Checked:</span>
          {msg.sources.map(src => {
            let host = src.url; try { host = new URL(src.url).hostname.replace(/^www\./, ''); } catch {}
            return <a key={src.url} href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}>{host}</a>;
          })}
        </div>
      )}
      {(msg.usage_id || msg.ai_request) && (
        <div className="cbg-rate" aria-label="Rate this answer">
          {msg.usage_id && <>
            <button className={msg.rating === 1 ? 'on' : ''} onClick={() => onRate(msg.rating === 1 ? 0 : 1)} title="Good answer">👍</button>
            <button className={msg.rating === -1 ? 'on' : ''} onClick={() => onRate(msg.rating === -1 ? 0 : -1)} title="Bad answer (sends the question and answer to the admin)">👎</button>
          </>}
          <AiInfo request={msg.ai_request} />
        </div>
      )}
    </div>
  );
}

// A repair to the list on the page: only the changes (insert/remove/move by
// entry), applied with /edit so every other entry stays exactly as it is.
function ProposedEdits({ list, target, onGo }) {
  const [diff, setDiff] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const ops = () => list.edits.map(({ display, ...o }) => ({ ...o, entries: o.entries ? o.entries.map(({ display: d, missing, owned, ...b }) => b) : undefined }));
  useEffect(() => {
    if (!target) return;
    let live = true;
    api('POST', `/api/reading-lists/${target.id}/edit`, { ops: ops(), version: target.version, dryRun: true })
      .then(d => { if (live) setDiff(d); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [target?.id]);   // once per card
  const apply = async () => {
    setBusy(true); setError('');
    try {
      const d = await api('POST', `/api/reading-lists/${target.id}/edit`, { ops: ops(), version: target.version });
      setDone(true);
      if (d.errors?.length) setError(`${d.errors.length} entr${d.errors.length === 1 ? 'y' : 'ies'} could not be added.`);
      window.dispatchEvent(new window.CustomEvent('omnibus:reading-list-changed', { detail: { id: target.id } }));
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  if (!target) return null;
  return (
    <div className="cbg-list">
      <div className="cbg-list-head">
        <span className="cbg-list-tag">Repair</span>
        <span className="cbg-list-name">{target.name}</span>
      </div>
      <ol className="cbg-list-items cbg-edits">
        {list.edits.map((o, i) => <li key={i} className={`cbg-edit cbg-edit--${o.op}`}>{o.op === 'insert' ? '+ ' : o.op === 'remove' ? '− ' : o.op === 'note' || o.op === 'label' ? '✎ ' : '↕ '}{o.display}</li>)}
      </ol>
      {diff && !done && (
        <div className="cbg-diff">
          <span className="cbg-diff-head">Changes to “{target.name}”:</span>{' '}
          {[diff.adds.length ? `adds ${diff.adds.length}` : null, diff.sections_added.length ? `new part${diff.sections_added.length > 1 ? 's' : ''}: ${diff.sections_added.join(', ')}` : null,
            diff.removes.length ? `removes ${diff.removes.length} (${diff.removes.join(', ')})` : null, diff.sections_removed.length ? `drops part${diff.sections_removed.length > 1 ? 's' : ''}: ${diff.sections_removed.join(', ')}` : null,
            diff.moved ? `moves ${diff.moved}` : null,
            diff.notes_changed ? `rewords ${diff.notes_changed} annotation${diff.notes_changed > 1 ? 's' : ''}` : null,
            diff.labels_changed ? `renames ${diff.labels_changed} section header${diff.labels_changed > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')}. The other {diff.kept - (diff.moved || 0)} entries stay exactly as they are.
        </div>
      )}
      <div className="cbg-list-foot">
        {done
          ? <button className="cbg-save cbg-save--done" onClick={() => onGo(`/reading-lists/${target.id}`)}>✓ Updated. Open list →</button>
          : <button className="cbg-save" onClick={apply} disabled={busy || !diff}>{busy ? 'Saving…' : `Update “${target.name}”`}</button>}
      </div>
      {error && <div className="cbg-error">{error}</div>}
    </div>
  );
}

function ProposedList({ list, target, onGo }) {
  const [saved, setSaved] = useState(null);      // { id, updated }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);
  const [diff, setDiff] = useState(null);        // dry-run summary for "Update this list"
  const items = list.entries;
  const shown = all ? items : items.slice(0, 10);
  const bodies = () => items.map(({ display, missing, owned, ...body }) => body);
  const withLabels = () => items.map(({ missing, owned, ...body }) => body);   // display kept for the summary
  // Nothing changes until a button is pressed; the dry run only describes the change.
  useEffect(() => {
    if (!target || saved) return;
    let live = true;
    api('POST', `/api/reading-lists/${target.id}/apply`, { entries: withLabels(), dryRun: true })
      .then(d => { if (live) setDiff(d); }).catch(() => { if (live) setDiff(null); });
    return () => { live = false; };
  }, [target?.id]);   // once per card
  const saveNew = async () => {
    setBusy(true); setError('');
    try {
      const d = await api('POST', '/api/reading-lists', { name: list.name, description: list.description || '', source: 'ai', entries: bodies() });
      setSaved({ id: d.id, updated: false });
      if (d.errors?.length) setError(`${d.errors.length} entr${d.errors.length === 1 ? 'y' : 'ies'} could not be added.`);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const update = async () => {
    setBusy(true); setError('');
    try {
      const d = await api('POST', `/api/reading-lists/${target.id}/apply`, { entries: withLabels() });
      setSaved({ id: target.id, updated: true });
      if (d.errors?.length) setError(`${d.errors.length} entr${d.errors.length === 1 ? 'y' : 'ies'} could not be added.`);
      window.dispatchEvent(new window.CustomEvent('omnibus:reading-list-changed', { detail: { id: target.id } }));
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const unchanged = diff && !diff.adds.length && !diff.removes.length && !diff.sections_added.length && !diff.sections_removed.length && !diff.moved;
  const primaryUpdate = !!target && list.mode === 'update';
  const updateBtn = target && (
    <button key="u" className={`cbg-save ${primaryUpdate ? '' : 'cbg-save--alt'}`} onClick={update} disabled={busy || unchanged}>
      {busy ? 'Saving…' : `Update “${target.name}”`}
    </button>);
  const newBtn = (
    <button key="n" className={`cbg-save ${primaryUpdate ? 'cbg-save--alt' : ''}`} onClick={saveNew} disabled={busy}>
      {busy ? 'Saving…' : target ? 'Save as new' : '+ Save as reading list'}
    </button>);
  return (
    <div className="cbg-list">
      <div className="cbg-list-head">
        <span className="cbg-list-tag">{primaryUpdate ? 'Revised list' : 'Reading order'}</span>
        <span className="cbg-list-name">{list.name}</span>
      </div>
      <ol className="cbg-list-items">
        {shown.map((e, i) => e.type === 'section'
          ? <li key={i} className="cbg-list-sec">{e.display}</li>
          : <li key={i} className={e.missing ? 'cbg-list-missing' : ''}>
              {e.display}{e.missing ? <span className="cbg-list-flag">not in library</span> : e.owned && <span className="cbg-list-flag">{e.owned}</span>}
            </li>)}
      </ol>
      {items.length > 10 && <button className="cbg-link" onClick={() => setAll(x => !x)}>{all ? 'Show less' : `Show all ${items.length}`}</button>}
      {target && diff && !saved && (
        <div className="cbg-diff">
          <span className="cbg-diff-head">Changes to “{target.name}”:</span>{' '}
          {unchanged ? 'none, it already matches.' : [
            diff.adds.length ? `adds ${diff.adds.length} (${diff.adds.join(', ')})` : null,
            diff.removes.length ? `removes ${diff.removes.length} (${diff.removes.join(', ')})` : null,
            diff.sections_added.length ? `new part${diff.sections_added.length > 1 ? 's' : ''}: ${diff.sections_added.join(', ')}` : null,
            diff.sections_removed.length ? `drops part${diff.sections_removed.length > 1 ? 's' : ''}: ${diff.sections_removed.join(', ')}` : null,
            diff.moved ? `moves ${diff.moved}` : null,
          ].filter(Boolean).join(' · ') + '. Everything else stays as it is.'}
        </div>
      )}
      <div className="cbg-list-foot">
        {saved
          ? <button className="cbg-save cbg-save--done" onClick={() => onGo(`/reading-lists/${saved.id}`)}>{saved.updated ? '✓ Updated. Open list →' : '✓ Saved. Open list →'}</button>
          : (primaryUpdate ? [updateBtn, newBtn] : [newBtn, updateBtn])}
      </div>
      {error && <div className="cbg-error">{error}</div>}
    </div>
  );
}

// The verified series of a box he built, saved only when the reader asks: a private
// personal box. A retry finishes the same box; once saved, the message remembers it
// (kept in the chat history), so a reload shows "Open my box" instead of saving again.
export function ProposedBox({ box, onGo, onSaved }) {
  const [name, setName] = useState(box.name);
  const [boxId, setBoxId] = useState(box.saved_id || null);
  const [saved, setSaved] = useState(!!box.saved_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saveBox = async () => {
    setBusy(true); setError('');
    let id = boxId;
    try {
      if (!id) { id = (await api('POST', '/api/collections', { name: name.trim(), personal: true, collectionType: 'manual' })).id; setBoxId(id); }
      for (const series of box.series) await api('POST', '/api/collections/' + encodeURIComponent(id) + '/series', { seriesId: series.id });
      if (box.missing?.length) await api('POST', '/api/collections/' + encodeURIComponent(id) + '/missing', { items: box.missing });
      setSaved(true);
      onSaved?.(id);
      window.dispatchEvent(new CustomEvent('omnibus:collections-changed'));
    } catch (e) { setError((id ? 'Some series were not added. Retry to finish. ' : 'The box was not saved. ') + (e.message || '')); }
    setBusy(false);
  };
  const missing = box.missing || [];
  const [allSeries, setAllSeries] = useState(false);
  const [allMissing, setAllMissing] = useState(false);
  const series = allSeries ? box.series : box.series.slice(0, 12);
  const toFind = allMissing ? missing : missing.slice(0, 8);
  const more = (n, on, flip) => n > 0 && <button type="button" className="cbg-link cbg-box-more" onClick={flip}>{on ? 'Show fewer' : `Show all (${n} more)`}</button>;
  return <div className="cbg-list cbg-box">
    <div className="cbg-list-head"><span className="cbg-list-tag">Box</span><span className="cbg-list-name">{name || 'New box'}</span></div>
    <div className="cbg-box-body">
      <div className="cbg-box-counts">
        <span><b>{box.series.length}</b> in Omnibus</span>
        {missing.length > 0 && <span><b>{missing.length}</b> to find</span>}
      </div>
      {!saved && <label className="cbg-setup-field">Box name<input maxLength={100} value={name} disabled={busy || !!boxId} onChange={e => setName(e.target.value)} /></label>}
      {box.series.length > 0 && <>
        <div className="cbg-box-sec">In Omnibus</div>
        <ul className="cbg-box-covers">{series.map(s => <li key={s.id} title={s.label}>
          <span className="cbg-box-cover"><img src={`/api/series/${encodeURIComponent(s.id)}/thumbnail`} alt="" loading="lazy" onError={e => { e.target.style.display = 'none'; }} /></span>
          <span className="cbg-box-label">{s.label}</span>
        </li>)}</ul>
        {more(box.series.length - 12, allSeries, () => setAllSeries(v => !v))}
      </>}
      {missing.length > 0 && <>
        <div className="cbg-box-sec">Not in Omnibus yet</div>
        <ul className="cbg-box-missing">{toFind.map(m => <li key={m.name + (m.start_year || '')}>
          <span className="cbg-box-missing-name">{m.name}</span>
          <span className="cbg-box-missing-meta">{[m.start_year, m.publisher].filter(Boolean).join(' · ')}</span>
        </li>)}</ul>
        {more(missing.length - 8, allMissing, () => setAllMissing(v => !v))}
      </>}
    </div>
    <div className="cbg-list-foot">
      {saved ? <button className="cbg-save cbg-save--done" onClick={() => onGo('/collections/' + boxId)}>Open my box →</button>
        : <button className="cbg-save" disabled={busy || !name.trim()} onClick={saveBox}>{busy ? 'Saving…' : boxId ? 'Retry adding series' : '+ Save as a private box'}</button>}
    </div>
    {missing.length > 0 && !saved && <p className="cbg-setup-hint">Series not in Omnibus are kept in the box, ready to add or request.</p>}
    {error && <div className="cbg-error">{error}</div>}
  </div>;
}
