// ─── ListEditor ───────────────────────────────────────────────────
// Shared curated-list editor (claude/ADMIN_REORG.md step 3): reading lists
// and Essentials, Timeline events, Top Shelf runs. One shell; adapters.js
// says how each kind loads and saves. Everything is a draft until Save,
// which sends the whole draft in one go. The draft is also kept in this
// browser, so a reload or lost connection does not lose work. Supports desktop, tablet and phone.
// Library matches are the one exception: they save at once (they do not
// change order, so they cannot clash with the draft).
import { useConfirm } from '../Confirm';
import React, { useState, useEffect, useMemo, useRef, useContext, useCallback } from 'react';
import { useNavigate, UNSAFE_NavigationContext } from 'react-router-dom';
import { childOf } from './adapters';
import DetailsPanel, { detailsDiff, detailsCss } from './DetailsPanel';
import IssueWindow, { coverUrl, issueWindowCss } from './IssueWindow';
import AddWindow, { addWindowCss } from './AddWindow';
import ToolWindow, { toolWindowCss } from './ToolWindow';
import { readableCss, responsiveCss } from './editorLayout';

const draftKey = (kind, id) => `omnibus.listEditor.${kind}.${id}`;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  clear(k) { try { localStorage.removeItem(k); } catch {} },
};
let seq = 0;
const nk = () => 'n' + Date.now().toString(36) + (++seq);
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const TYPE_MARK = { range: 'issues', series: 'series', event: 'timeline', canon_run: 'top shelf', story: 'crossover' };
const TIER_DOT = { essential: '#e8151f', recommended: '#f5c518', 'tie-in': '#6b8fd6', all: '#6b8fd6', aftermath: '#8a8a8a' };

const ownedOf = r => (r.children ? r.children.filter(c => c.owned).length : r.single ? (r.single.owned ? 1 : 0) : (r.owned || 0));
const totalOf = r => (r.children ? r.children.length : r.single ? 1 : (r.total || 0));
const childrenChanged = r => !!(r.children && r.childrenOrig &&
  (r.children.length !== r.childrenOrig.length || r.children.some((c, i) => c.liId !== r.childrenOrig[i])));
// Issues of a row as movable children (each with its stored issue id), or null.
const kidsOf = r => {
  if (r.type === 'section') return null;
  if (r.type === 'issue' && r.single && r.single.id != null && !r.children) return [childOf(r.single)];
  return r.children && r.children.every(c => c.liId != null) ? r.children : null;
};
// A single issue taken out of an entry becomes its own (new) row.
const issueRowFrom = c => ({ key: nk(), id: null, type: 'issue', isNew: true, label: c.label, note: '', owned: c.owned ? 1 : 0, total: 1,
  single: { ...(c.issue || {}), id: c.liId, owned: c.owned, book_id: c.bookId }, children: null });
const undoable = r => !!(r.isNew && r.combinedKeys && r.children.length === r.combinedKeys.length && r.children.every((c, i) => c.key === r.combinedKeys[i]));

// Ask before leaving with unsaved changes: browser close/reload, links inside
// the app (BrowserRouter has no blocker, so wrap its navigator), and the
// browser's Back/Forward buttons (2026-11-05). Back/Forward: this module adds
// its popstate listener when it loads, before the router mounts, so it runs
// first (window listeners run in the order added; capture does not change
// that). While the editor has unsaved changes it hides the step from the
// router, returns to the editor's history entry, then asks; Leave repeats the
// step with the guard off. No extra history entries.
let popGuard = null;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', e => { if (popGuard) popGuard(e); });
}

export function useLeaveGuard(active, message) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  useEffect(() => {
    if (!active) return;
    const onUnload = e => { e.preventDefault(); e.returnValue = message; return message; };
    window.addEventListener('beforeunload', onUnload);
    const push = navigator.push, replace = navigator.replace;
    const idxNow = () => { const i = window.history.state?.idx; return typeof i === 'number' ? i : null; };
    const here = idxNow();
    let returning = 0;          // the step back to the editor's entry: hidden from the router too
    let released = false;
    const onPop = e => {
      e.stopImmediatePropagation();
      if (returning) {
        const delta = returning; returning = 0;
        setTimeout(() => {
          if (released || !window.confirm(message)) return;
          release();
          window.history.go(-delta);
        }, 0);
        return;
      }
      const to = idxNow();
      const delta = here != null && to != null && to !== here ? here - to : 1;   // > 0: Back
      returning = delta;
      window.history.go(delta);
    };
    const release = () => {
      released = true;
      window.removeEventListener('beforeunload', onUnload);
      if (popGuard === onPop) popGuard = null;
      navigator.push = push; navigator.replace = replace;
    };
    popGuard = onPop;
    navigator.push = (...a) => { if (window.confirm(message)) { release(); push(...a); } };
    navigator.replace = (...a) => { if (window.confirm(message)) { release(); replace(...a); } };
    return release;
  }, [active, message, navigator]);
}

// Small popover menu; closes on an outside click or Esc.
function Menu({ rect, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const down = e => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', down); window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const list = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && i < a.length - 1 && a[i - 1] !== '-'));
  const up = rect.bottom > window.innerHeight - 280;
  const style = { left: Math.max(8, Math.min(rect.right - 220, window.innerWidth - 236)), ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) };
  return (
    <div className="le-menu" ref={ref} style={style} role="menu">
      {list.map((it, i) => (it === '-' ? <div key={i} className="le-menu-sep" /> :
        <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} title={it.title || ''}
          onClick={() => { onClose(); it.run(); }}>{it.label}</button>))}
    </div>
  );
}

// Small cover on a row: the matched comic, or a "no match" tile. Click opens the issue window.
function Thumb({ bookId, onClick, title }) {
  return (
    <button type="button" className={`le-thumb${bookId ? '' : ' none'}`} onClick={onClick} disabled={!onClick} title={title || ''} aria-label={title || 'Cover'}>
      {bookId ? <img src={coverUrl(bookId)} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : <span>?</span>}
    </button>
  );
}

export default function ListEditor({ adapter, id, backTo }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const caps = adapter.caps;
  const sKey = draftKey(adapter.kind, id);
  const [base, setBase] = useState(null);          // { title, subtitle, version, rows } as saved
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);            // the draft
  const [removed, setRemoved] = useState([]);      // saved rows removed in the draft
  const [absorbed, setAbsorbed] = useState([]);    // saved entries whose issues all went elsewhere: [{ id, autoUnpack }]
  const [selected, setSelected] = useState(() => new Set());
  const [open, setOpen] = useState(() => new Set());
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [filter, setFilter] = useState('all');
  const [menu, setMenu] = useState(null);          // { rect, items }
  const [editing, setEditing] = useState(null);    // { key, field: 'label' | 'note' }
  const [drag, setDrag] = useState(null);          // { kind: 'rows', keys } | { kind: 'child', parent, key }; plus over
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);      // { text, tone }
  const [restore, setRestore] = useState(null);
  const [match, setMatch] = useState(null);
  const [details, setDetails] = useState(null);    // draft hero details (Details panel)
  const [addOpen, setAddOpen] = useState(false);
  const [tool, setTool] = useState(null);          // Tools menu: 'rematch' | 'rebuild' | 'annotate' (ToolWindow)
  const [src, setSrc] = useState(null);            // "Show sources" (events): { on, loading, data, error }
  const [why, setWhy] = useState(false);           // "Show reasoning" (events): tier reasons and order notes (same data as sources)
  const [confirmDel, setConfirmDel] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const lastClicked = useRef(null);
  const rootRef = useRef(null), headRef = useRef(null);
  const say = (text, tone = 'info') => setNotice({ text, tone });
  const noteWord = (caps.noteLabel || 'Note').toLowerCase();

  const load = useCallback(async () => {
    setError('');
    try {
      const b = await adapter.load(id);
      setBase(b); setRows(b.rows); setRemoved([]); setAbsorbed([]); setSelected(new Set()); setEditing(null); setDetails(b.details || null);
      const saved = store.get(sKey);
      if (saved && saved.rows) {
        if (saved.version === b.version) setRestore(saved);
        else { store.clear(sKey); setNotice({ tone: 'warn', text: `A draft from ${new Date(saved.at).toLocaleString()} was set aside: this ${adapter.noun} changed after it was made.` }); }
      }
      return b;
    } catch (e) { setError(e.message); return null; }
  }, [adapter, id, sKey]);
  useEffect(() => { load(); }, [load]);
  // Entries still fetching their issue list (a range or series just added): take the fetched
  // issues in when they arrive (2026-11-10), so the draft shows and refers to the rows the
  // list now has. A row the draft has already changed is left as it is.
  const baseRef = useRef(base); baseRef.current = base;
  const pendingKeys = base ? base.rows.filter(r => r.pending).map(r => r.key).join(',') : '';
  useEffect(() => {
    if (!pendingKeys) return undefined;
    let live = true, busy = false, tries = 0;
    const t = setInterval(async () => {
      if (busy) return;
      if (++tries > 40) { clearInterval(t); return; }
      busy = true;
      try {
        const b = await adapter.load(id), cur = baseRef.current;
        if (!live || !cur) return;
        if (b.version !== cur.version) { clearInterval(t); return; }   // changed elsewhere: the save will say so
        const was = new Map(cur.rows.map(r => [r.key, r]));
        const fresh = new Map(b.rows.filter(r => !r.pending && was.get(r.key)?.pending).map(r => [r.key, r]));
        if (!fresh.size) return;
        const kids = r => (r.children || []).map(c => c.key).join(',');
        setBase(x => ({ ...x, rows: x.rows.map(r => fresh.get(r.key) || r) }));
        setRows(rs => rs.map(r => {
          const f = fresh.get(r.key), o = was.get(r.key);
          return f && o && !r.unpack && kids(r) === kids(o) ? { ...f, label: r.label, note: r.note, tier: r.tier } : r;
        }));
      } catch { /* try again next time */ } finally { busy = false; }
    }, 2000);
    return () => { live = false; clearInterval(t); };
  }, [pendingKeys, adapter, id]);
  // ?tool=annotate (a new event from the generator): open that tool once the editor has loaded.
  const toolParam = useRef(typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tool') : null);
  useEffect(() => {
    const t = toolParam.current;
    if (!base || !t || !(adapter.tools || []).includes(t)) return;
    toolParam.current = null; setTool(t);
    window.history.replaceState(null, '', window.location.pathname);
  }, [base, adapter]);

  // What the draft changes, in words (also decides whether there is anything to save).
  const changes = useMemo(() => {
    if (!base) return [];
    const out = [], orig = base.rows, byKey = new Map(orig.map(r => [r.key, r]));
    const add = (n, w, ws) => { if (n) out.push(plural(n, w, ws)); };
    add(removed.length, 'removed', 'removed');
    add(orig.filter(r => r.type === 'section' && r.id == null && !rows.some(x => x.key === r.key)).length, 'section removed', 'sections removed');
    add(rows.filter(r => r.type === 'section' && !byKey.has(r.key)).length, 'section added', 'sections added');
    add(rows.filter(r => r.add).length, 'added', 'added');
    add(rows.filter(r => r.isNew && !r.add && r.type === 'story').length, 'crossover made', 'crossovers made');
    add(rows.filter(r => r.isNew && !r.add && r.type === 'issue').length, 'issue taken out', 'issues taken out');
    add(absorbed.length, 'entry replaced', 'entries replaced');
    const keys = rows.map(r => r.key).filter(k => byKey.has(k));
    const origKeys = orig.map(r => r.key).filter(k => keys.includes(k));
    if (keys.some((k, i) => k !== origKeys[i])) out.push('order changed');
    const kept = rows.filter(r => byKey.has(r.key)), was = r => byKey.get(r.key);
    add(kept.filter(r => r.label !== was(r).label).length, 'renamed', 'renamed');
    add(kept.filter(r => (r.note || '') !== (was(r).note || '')).length, `${noteWord} edited`, `${noteWord}s edited`);
    add(kept.filter(r => (r.tier || null) !== (was(r).tier || null)).length, 'tier changed', 'tiers changed');
    add(kept.filter(childrenChanged).length, 'issue list edited', 'issue lists edited');
    add(kept.filter(r => r.unpack).length, 'made own copy', 'made own copies');
    if (detailsDiff(base.details, details)) out.unshift('details edited');
    return out;
  }, [base, rows, removed, absorbed, noteWord, details]);
  const dirty = changes.length > 0;
  useLeaveGuard(dirty && !saving && !leaving, `You have unsaved changes in the editor. Leave without saving?`);

  // Keep the draft in this browser while it differs from what is saved.
  useEffect(() => {
    if (!base || restore) return;
    if (dirty) store.set(sKey, { version: base.version, rows, removed, absorbed, details, at: Date.now() });
    else store.clear(sKey);
  }, [rows, removed, absorbed, details, dirty, base, sKey, restore]);
  const applyRestore = () => { setRows(restore.rows); setRemoved(restore.removed || []); setAbsorbed(restore.absorbed || []); setDetails(restore.details || base.details || null); setRestore(null); };

  // Visible rows: a collapsed section hides what follows it; the filter hides the rest.
  const visible = useMemo(() => {
    const out = []; let hidden = false;
    for (const r of rows) {
      if (r.type === 'section') { hidden = collapsed.has(r.key); out.push(r); continue; }
      if (hidden) continue;
      if (filter === 'missing' && !(ownedOf(r) < totalOf(r))) continue;
      if (filter === 'notes' && !r.note) continue;
      out.push(r);
    }
    return out;
  }, [rows, collapsed, filter]);
  const position = useMemo(() => { const m = new Map(); let n = 0; for (const r of rows) if (r.type !== 'section') m.set(r.key, ++n); return m; }, [rows]);
  const selKeys = rows.filter(r => selected.has(r.key)).map(r => r.key);
  const toggle = (setter, key) => setter(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  // ── Changes to the draft ──
  const update = (key, patch) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const moveKeys = (keys, targetKey, before) => setRows(rs => {
    const moving = rs.filter(r => keys.includes(r.key)), rest = rs.filter(r => !keys.includes(r.key));
    const idx = targetKey == null ? -1 : rest.findIndex(r => r.key === targetKey);
    const at = targetKey == null ? (before ? 0 : rest.length) : idx < 0 ? rest.length : idx + (before ? 0 : 1);
    return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  });
  const nudge = dir => setRows(rs => {
    const a = [...rs];
    const idx = selKeys.map(k => a.findIndex(r => r.key === k)).sort((x, y) => (dir < 0 ? x - y : y - x));
    for (const i of idx) { const j = i + dir; if (j < 0 || j >= a.length || selKeys.includes(a[j].key)) continue; [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  });
  const removeKeys = keys => {
    const gone = rows.filter(r => keys.includes(r.key));
    const toRemoved = [], unabsorb = new Set();
    for (const r of gone) {
      if (r.id != null) toRemoved.push(r);
      // A crossover made in this draft takes the entries it was made from with it.
      if (r.isNew && r.sourceRows) for (const s of r.sourceRows) if (s.id != null) { toRemoved.push(s); unabsorb.add(s.id); }
    }
    setRows(rs => rs.filter(r => !keys.includes(r.key)));
    if (toRemoved.length) setRemoved(x => [...x, ...toRemoved]);
    if (unabsorb.size) setAbsorbed(a => a.filter(x => !unabsorb.has(x.id)));
    setSelected(new Set());
  };
  const putBack = () => { setRows(rs => [...rs, ...removed]); setRemoved([]); say('Removed rows are back at the end; move them where you want.'); };
  const addSection = () => {
    const s = { key: nk(), id: null, type: 'section', label: 'New section', note: '' };
    const first = rows.find(r => selected.has(r.key));
    setRows(rs => { const at = first ? rs.findIndex(r => r.key === first.key) : rs.length; return [...rs.slice(0, at), s, ...rs.slice(at)]; });
    setEditing({ key: s.key, field: 'label' });
  };
  const discard = async () => {
    if (!(await confirm({ title: 'Throw away changes?', message: 'Throw away all changes since the last save?', confirmLabel: 'Throw away', danger: true }))) return;
    setRows(base.rows); setRemoved([]); setAbsorbed([]); setSelected(new Set()); setEditing(null); setDetails(base.details || null); store.clear(sKey);
  };
  // Delete the whole list, event or run: immediate, after the confirm in the Details panel.
  const deleteItem = async () => {
    setLeaving(true); setNotice(null);
    try { await adapter.deleteItem(id); store.clear(sKey); navigate(adapter.afterDelete(base, backTo), { replace: true }); }
    catch (e) { setLeaving(false); setConfirmDel(false); say(`Could not delete: ${e.message}`, 'error'); }
  };

  // ── Crossover groups (reading lists) ──
  const combine = keys => {
    const picked = rows.filter(r => keys.includes(r.key) && adapter.combinable(r));
    if (picked.length < 2) return say('Tick two or more entries to combine them.', 'warn');
    const kids = [];
    for (const r of picked) {
      const k = kidsOf(r) || (r.linked && r.children ? r.children : null);
      if (!k) return say(`"${r.label}" has no issue list to combine yet.`, 'warn');
      kids.push(...k);
    }
    if (!kids.length) return say('Those entries have no issues to combine.', 'warn');
    if (kids.length > 100) return say(`That would make a crossover of ${kids.length} issues; the limit is 100.`, 'warn');
    const pickedKeys = new Set(picked.map(r => r.key));
    const g = { key: nk(), id: null, type: 'story', isNew: true, label: 'New crossover', note: '', children: kids, childrenOrig: null, childrenEditable: true,
      sourceRows: picked.flatMap(r => (r.isNew && r.type === 'story' ? r.sourceRows || [] : [r])), combinedKeys: kids.map(c => c.key) };
    // Saved entries whose issues move in are emptied; linked entries are copied in whole on save instead.
    const absorb = picked.filter(r => r.id != null && !r.linked).map(r => ({ id: r.id, autoUnpack: !!r.autoUnpack }));
    setRows(rs => {
      const at = rs.findIndex(r => r.key === picked[0].key);
      const rest = rs.filter(r => !pickedKeys.has(r.key));
      const pos = rs.slice(0, at).filter(r => !pickedKeys.has(r.key)).length;
      return [...rest.slice(0, pos), g, ...rest.slice(pos)];
    });
    if (absorb.length) setAbsorbed(a => [...a, ...absorb]);
    setSelected(new Set()); setOpen(o => new Set(o).add(g.key)); setEditing({ key: g.key, field: 'label' });
  };
  const split = r => {
    if (undoable(r)) {
      const src = r.sourceRows || [], ids = new Set(src.map(s => s.id).filter(x => x != null));
      setRows(rs => rs.flatMap(x => (x.key === r.key ? src : [x])));
      setAbsorbed(a => a.filter(x => !ids.has(x.id)));
      return;
    }
    if (!r.children.every(c => c.liId != null)) return say('Issues that came from a Timeline or Top Shelf entry can only be split after saving.', 'warn');
    const singles = r.children.map(issueRowFrom);
    setRows(rs => rs.flatMap(x => (x.key === r.key ? singles : [x])));
    if (r.id != null) setAbsorbed(a => [...a, { id: r.id }]);
  };
  // Drop whole rows into a crossover (their issues join it).
  const joinRows = (keys, groupKey) => {
    const g = rows.find(r => r.key === groupKey);
    const movers = rows.filter(r => keys.includes(r.key) && r.key !== groupKey);
    if (!g || !movers.length) return;
    const bad = movers.find(r => !kidsOf(r));
    if (bad) return say(bad.type === 'section' ? 'Sections cannot go inside a crossover.'
      : `"${bad.label}" follows its original. Tick it with the other entries and use Combine, or make it your own copy and save first.`, 'warn');
    const kids = movers.flatMap(kidsOf);
    if (g.children.length + kids.length > 100) return say('A crossover can hold up to 100 issues.', 'warn');
    const src = movers.flatMap(r => (r.isNew && r.type === 'story' ? r.sourceRows || [] : r.id != null ? [r] : []));
    setRows(rs => rs.filter(r => !keys.includes(r.key) || r.key === groupKey)
      .map(r => (r.key === groupKey ? { ...r, children: [...r.children, ...kids], sourceRows: r.isNew ? [...(r.sourceRows || []), ...src] : r.sourceRows } : r)));
    const absorb = movers.filter(r => r.id != null).map(r => ({ id: r.id, autoUnpack: !!r.autoUnpack }));
    if (absorb.length) setAbsorbed(a => [...a, ...absorb]);
    setSelected(new Set()); setOpen(o => new Set(o).add(groupKey));
  };
  // Move one issue: within or between entries ({ parent, child?, before }) or out to its own row ({ row, before }).
  const moveChild = (fromKey, childKey, to) => setRows(rs => {
    const from = rs.find(r => r.key === fromKey);
    const c = from && from.children && from.children.find(x => x.key === childKey);
    if (!c) return rs;
    let next = rs.map(r => (r.key === fromKey ? { ...r, children: r.children.filter(x => x.key !== childKey) } : r));
    if (to.parent) {
      next = next.map(r => {
        if (r.key !== to.parent) return r;
        const i = to.child ? r.children.findIndex(x => x.key === to.child) : -1;
        const at = i < 0 ? r.children.length : i + (to.before ? 0 : 1);
        return { ...r, children: [...r.children.slice(0, at), c, ...r.children.slice(at)] };
      });
    } else {
      const i = next.findIndex(r => r.key === to.row), at = i < 0 ? next.length : i + (to.before ? 0 : 1);
      next = [...next.slice(0, at), issueRowFrom(c), ...next.slice(at)];
    }
    return next.filter(r => !(r.isNew && r.type === 'story' && !r.children.length));
  });
  const removeChild = (parentKey, childKey) => setRows(rs => rs
    .map(r => (r.key === parentKey ? { ...r, children: r.children.filter(x => x.key !== childKey) } : r))
    .filter(r => !(r.isNew && r.type === 'story' && !r.children.length)));

  // ── Immediate actions: fetch an issue list again; library match ──
  const refreshRow = async r => {
    say(`Fetching the issue list for "${r.label}" again…`);
    try {
      await adapter.refresh(id, r);
      for (let i = 0; i < 20; i++) {
        await new Promise(res => setTimeout(res, 1500));
        const fresh = (await adapter.load(id)).rows.find(x => x.key === r.key);
        if (!fresh) break;
        if (fresh.pending) continue;
        setBase(b => ({ ...b, rows: b.rows.map(x => (x.key === r.key ? fresh : x)) }));
        setRows(rs => rs.map(x => (x.key === r.key ? { ...fresh, label: x.label, note: x.note, tier: x.tier } : x)));
        return say(`"${r.label}" now has ${plural(totalOf(fresh), 'issue')}.`, 'ok');
      }
      say('The issue list is still being fetched. Reopen the editor in a minute to see it.', 'warn');
    } catch (e) { say(e.message, 'error'); }
  };
  const matchTargetFor = (r, c) => {
    if (!c && r.id == null && !(r.single && r.single.id != null)) return null;   // added in this draft: save first
    return c ? adapter.matchTarget(id, c) : adapter.kind === 'list' ? adapter.matchTarget(id, childOf(r.single)) : adapter.matchTarget(id, r);
  };
  // ── Add window: new rows go in before the row now at that position ──
  const positionCount = rows.filter(r => r.type !== 'section').length;
  const addDefaultPos = (() => { const ps = rows.filter(r => selected.has(r.key) && r.type !== 'section').map(r => position.get(r.key)); return ps.length ? Math.max(...ps) + 1 : positionCount + 1; })();
  const tierBefore = pos => { const before = rows.filter(r => r.type !== 'section' && position.get(r.key) < pos); return (before.length && before[before.length - 1].tier) || null; };
  const existing = useMemo(() => {
    const cv = new Set(), books = new Set();
    const note = i => { if (!i) return; if (i.cv_issue_id) cv.add(String(i.cv_issue_id)); if (i.book_id) books.add(String(i.book_id)); };
    for (const r of rows) { note(r.single); for (const c of r.children || []) { note(c.issue); if (c.bookId) books.add(String(c.bookId)); } }
    return { cv, books };
  }, [rows]);
  const insertAt = (newRows, pos) => setRows(rs => {
    let n = 0, at = rs.length;
    for (let i = 0; i < rs.length; i++) { if (rs[i].type === 'section') continue; if (++n === pos) { at = i; break; } }
    return [...rs.slice(0, at), ...newRows, ...rs.slice(at)];
  });
  const openMatch = (r, c) => {
    const target = matchTargetFor(r, c); if (!target) return;
    const issue = (c ? { ...c.issue, book_id: c.bookId, owned: c.owned } : r.single) || {};
    setMatch({ r, c, target, issue, acquire: adapter.acquireFor ? adapter.acquireFor(id, r, c) : null });
  };
  const applyMatch = (m, book) => {
    const owned = !!book, bookId = book ? book.id : null;
    const liId = m.c ? m.c.liId : adapter.kind === 'list' ? m.r.single.id : null;
    const fix = r => {
      if (adapter.kind !== 'list') return r.single && r.id === m.r.id ? { ...r, owned: owned ? 1 : 0, single: { ...r.single, owned, book_id: bookId } } : r;
      let x = r;
      if (r.single && r.single.id === liId) x = { ...x, single: { ...r.single, owned, book_id: bookId } };
      if (r.children && r.children.some(c => c.liId === liId)) x = { ...x, children: r.children.map(c => (c.liId === liId ? { ...c, owned, bookId, issue: { ...c.issue, owned, book_id: bookId } } : c)) };
      return x;
    };
    setRows(rs => rs.map(fix)); setBase(b => ({ ...b, rows: b.rows.map(fix) }));
    say(book ? 'Library match saved.' : 'Library match cleared.', 'ok');
  };
  // Tools › Re-match: the applied matches (already saved), patched into the draft and the saved copy.
  const applyRematch = d => {
    const by = new Map((d.applied || []).map(a => [a.id, a]));
    const fix = r => { const a = r.single && by.get(r.id); return a ? { ...r, owned: 1, single: { ...r.single, owned: true, book_id: a.book_id, ...(a.cv_issue_id ? { cv_issue_id: a.cv_issue_id } : {}) } } : r; };
    setRows(rs => rs.map(fix)); setBase(b => ({ ...b, rows: b.rows.map(fix) }));
    say(`${plural(by.size, 'change')} saved.${d.stale && d.stale.length ? ` ${d.stale.length} skipped: they changed meanwhile.` : ''}`, 'ok');
  };
  // Tools › Write tier notes: the chosen notes go into the draft.
  const applyNotes = m => { setRows(rs => rs.map(r => (r.type !== 'section' && r.id != null && m[r.id] !== undefined ? { ...r, note: m[r.id] } : r))); say(`${plural(Object.keys(m).length, 'note')} put in the draft. Save to keep them.`, 'info'); };
  // Show sources: fetched once, on first use.
  const loadSrc = async on => {
    if (src && src.data) return setSrc(x => ({ ...x, on }));
    setSrc({ on, loading: true });
    try { setSrc({ on, data: await adapter.loadSources(id) }); }
    catch (e) { setSrc({ on, error: e.message || 'Could not load the sources' }); }
  };
  const toggleSources = () => loadSrc(!(src && src.on));
  const toggleReasoning = () => { const next = !why; setWhy(next); if (next && !(src && src.data)) loadSrc(false); };
  const srcData = new Map(((src && src.data && src.data.issues) || []).map(x => [x.id, x]));
  const srcById = src && src.on ? srcData : new Map();
  const whyById = why ? srcData : new Map();
  const toolItems = () => (adapter.tools || []).map(t => ({
    rematch: { label: 'Re-match to library…', run: () => setTool('rematch') },
    rebuild: { label: 'Rebuild from Comic Vine…', run: () => setTool('rebuild'), title: dirty ? 'Save or discard your changes first' : '' },
    annotate: { label: 'Write tier notes with AI…', run: () => setTool('annotate') },
  }[t]));

  const save = async () => {
    if (saving || !dirty) return;
    const unnamed = rows.find(r => (r.type === 'section' || r.type === 'story') && !String(r.label || '').trim());
    if (unnamed) { setEditing({ key: unnamed.key, field: 'label' }); return say('Give every section and crossover a name before saving.', 'warn'); }
    if (details && adapter.titleOf && !String(adapter.titleOf(details) || '').trim()) return say(`Give the ${adapter.noun} a name in Details before saving.`, 'warn');
    setSaving(true); setNotice(null);
    try {
      const body = adapter.buildSave(rows, removed, absorbed, base.version, base.rows);
      const dd = detailsDiff(base.details, details);
      if (dd) body.details = dd;
      const d = await adapter.save(id, body);
      store.clear(sKey);
      await load();
      const errs = d.errors || [];
      if (errs.length) say(`Saved, but ${plural(errs.length, 'change')} could not be applied: ${errs.map(x => x.error || String(x)).join('; ')}`, 'warn');
      else say('Saved.', 'ok');
    } catch (e) {
      say(e.conflict ? `Nothing was saved: this ${adapter.noun} was changed somewhere else after you opened it. Reload to start from the latest version.`
        : `Save failed: ${String(e.message).replace(/\.\s*$/, '')}. Your draft is kept.`, 'error');
    } finally { setSaving(false); }
  };
  const saveRef = useRef(save); saveRef.current = save;

  // ── Selection and keys ──
  const clickSelect = (e, key) => {
    const prev = lastClicked.current, shift = e.shiftKey;   // read now: the updater runs later
    setSelected(sel => {
      const next = new Set(sel);
      if (shift && prev) {
        const keys = visible.map(r => r.key), a = keys.indexOf(prev), b = keys.indexOf(key);
        if (a >= 0 && b >= 0) keys.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(k => next.add(k));
      } else if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    lastClicked.current = key;
  };
  useEffect(() => {
    const onKey = e => {
      if (match || menu || addOpen || tool) return;
      const t = e.target, typing = t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'a' || e.key === 'A') && base) { e.preventDefault(); setAddOpen(true); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (typing) t.blur(); setTimeout(() => saveRef.current(), 0); return; }
      if (typing || !selected.size) return;
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && caps.reorder) { e.preventDefault(); nudge(e.key === 'ArrowUp' ? -1 : 1); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeKeys(selKeys); }
      else if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });

  // ── Drag and drop: rows (ticked rows move together) and single issues ──
  const startRowDrag = (e, r) => {
    const keys = selected.has(r.key) ? selKeys : [r.key];
    setDrag({ kind: 'rows', keys, over: null });
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'rows');
  };
  const startChildDrag = (e, r, c) => {
    e.stopPropagation();
    setDrag({ kind: 'child', parent: r.key, key: c.key, over: null });
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'issue');
  };
  const setOver = over => setDrag(d => (d && (!d.over || d.over.row !== over.row || d.over.child !== over.child || d.over.zone !== over.zone) ? { ...d, over } : d));
  const overRow = (e, r) => {
    if (!drag) return;
    if (drag.kind === 'rows' && drag.keys.includes(r.key)) return;
    e.preventDefault(); e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect(), y = (e.clientY - box.top) / box.height;
    const canInto = drag.kind === 'rows' ? caps.groups && r.type === 'story' : !!(r.childrenEditable && r.children);
    setOver({ row: r.key, child: null, zone: canInto && y > 0.3 && y < 0.7 ? 'into' : y < 0.5 ? 'before' : 'after' });
  };
  const overChild = (e, r, c) => {
    if (!drag || drag.kind !== 'child' || !r.childrenEditable) return;
    e.preventDefault(); e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    setOver({ row: r.key, child: c.key, zone: e.clientY < box.top + box.height / 2 ? 'before' : 'after' });
  };
  // While dragging, scroll when the pointer nears the top (just under the
  // sticky header) or the bottom of the screen; faster the closer it gets.
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    let el = rootRef.current && rootRef.current.parentElement, scroller = null;
    while (el && el !== document.body && el !== document.documentElement) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) { scroller = el; break; }
      el = el.parentElement;
    }
    let y = null, raf = 0;
    const onOver = e => { y = e.clientY; };
    const tick = () => {
      if (y != null) {
        const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const top = Math.max(box.top, headRef.current ? headRef.current.getBoundingClientRect().bottom : box.top);
        const zone = 90, max = 22;
        let dy = 0;
        if (y < top + zone) dy = -Math.ceil(Math.min(1.5, (top + zone - y) / zone) * max);
        else if (y > box.bottom - zone) dy = Math.ceil(Math.min(1.5, (y - (box.bottom - zone)) / zone) * max);
        if (dy) { if (scroller) scroller.scrollTop += dy; else window.scrollBy(0, dy); }
      }
      raf = requestAnimationFrame(tick);
    };
    document.addEventListener('dragover', onOver, true);
    raf = requestAnimationFrame(tick);
    return () => { document.removeEventListener('dragover', onOver, true); cancelAnimationFrame(raf); };
  }, [dragging]);
  const drop = e => {
    e.preventDefault(); e.stopPropagation();
    const d = drag; setDrag(null);
    if (!d || !d.over) return;
    const o = d.over;
    if (d.kind === 'rows') { if (o.zone === 'into') joinRows(d.keys, o.row); else moveKeys(d.keys, o.row, o.zone === 'before'); }
    else if (o.child) { if (o.child !== d.key) moveChild(d.parent, d.key, { parent: o.row, child: o.child, before: o.zone === 'before' }); }
    else if (o.zone === 'into') moveChild(d.parent, d.key, { parent: o.row });
    else moveChild(d.parent, d.key, { row: o.row, before: o.zone === 'before' });
  };

  // ── Menus ──
  const openMenu = (e, items) => { e.stopPropagation(); setMenu({ rect: e.currentTarget.getBoundingClientRect(), items }); };
  const rowMenu = r => {
    const moves = caps.reorder ? [-1, 1].map(dir => {
      const target = rows[rows.findIndex(x => x.key === r.key) + dir];
      return { label: dir < 0 ? 'Move up' : 'Move down', disabled: !target, run: () => target && moveKeys([r.key], target.key, dir < 0) };
    }) : [];
    if (r.type === 'section') return [...moves, { label: 'Rename section', run: () => setEditing({ key: r.key, field: 'label' }) }, '-', { label: 'Remove section', danger: true, run: () => removeKeys([r.key]) }];
    const items = [...moves];
    if (caps.rename || r.isNew) items.push({ label: 'Rename', run: () => setEditing({ key: r.key, field: 'label' }) });
    if (caps.notes) items.push({ label: r.note ? `Edit ${noteWord}` : `Add ${noteWord}`, run: () => setEditing({ key: r.key, field: 'note' }) });
    if (r.single && matchTargetFor(r)) items.push({ label: r.single.owned ? 'Change library match' : 'Find in library', run: () => openMatch(r) });
    const cp = adapter.coverPick;
    if (cp && details && r.id != null && r.single?.owned) items.push(details[cp.field] === r.id
      ? { label: `Stop using as ${cp.label}`, run: () => setDetails(d => ({ ...d, [cp.field]: null })) }
      : { label: `Use as ${cp.label}`, run: () => setDetails(d => ({ ...d, [cp.field]: r.id })) });
    if (caps.children && r.id != null && !r.unpacked && (r.linked || r.autoUnpack)) {
      items.push(r.unpack ? { label: 'Keep following the original', run: () => update(r.key, { unpack: false }) }
        : { label: 'Make own copy', title: 'Stop following the source, so its issues can be edited', run: () => update(r.key, { unpack: true }) });
    }
    if (r.refreshable && r.id != null && !r.unpack && !childrenChanged(r)) items.push({ label: 'Fetch issue list again', run: () => refreshRow(r) });
    if (caps.groups && r.type === 'story') items.push({ label: undoable(r) ? 'Undo combine' : 'Split into single issues', run: () => split(r) });
    items.push('-', { label: 'Remove', danger: true, run: () => removeKeys([r.key]) });
    return items;
  };
  const childMenu = (r, c) => {
    const editable = r.childrenEditable && c.liId != null;
    return [
      c.liId != null ? { label: c.owned ? 'Change library match' : 'Find in library', run: () => openMatch(r, c) }
        : { label: 'Find in library', disabled: true, title: 'Make own copy and save first' },
      ...((editable && caps.reorder) ? [-1, 1].map(dir => {
        const target = r.children[r.children.findIndex(x => x.key === c.key) + dir];
        return { label: dir < 0 ? 'Move issue up' : 'Move issue down', disabled: !target, run: () => target && moveChild(r.key, c.key, { parent: r.key, child: target.key, before: dir < 0 }) };
      }) : []),
      editable && caps.groups && { label: 'Take out to its own row', run: () => moveChild(r.key, c.key, { row: r.key, before: false }) },
      editable && '-',
      editable && { label: 'Remove issue', danger: true, run: () => removeChild(r.key, c.key) },
    ];
  };

  // ── Render ──
  const sections = rows.filter(r => r.type === 'section');
  const nCombinable = caps.groups ? rows.filter(r => selected.has(r.key) && adapter.combinable(r)).length : 0;
  const help = [caps.reorder && 'Drag ⠿ to move a row.', 'Tick rows (Shift for a range) to act on several.',
    caps.groups && 'Drop a row onto a crossover to add it; drag single issues between entries.',
    caps.reorder && 'Alt+↑/↓ nudges ticked rows.', 'A opens Add. Delete removes ticked rows. Ctrl+S saves.'].filter(Boolean).join(' ');
  const noteEditor = r => (
    <textarea className="le-note-edit" autoFocus defaultValue={r.note} placeholder={caps.noteLabel ? `${caps.noteLabel} shown under this issue` : 'A note shown under this entry'}
      onBlur={e => { update(r.key, { note: e.target.value.trim() }); setEditing(null); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.target.value = r.note || ''; e.target.blur(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.target.blur(); }} />);
  const labelEditor = r => (
    <input className="le-input" autoFocus defaultValue={r.label} onFocus={e => e.target.select()}
      onBlur={e => { const v = e.target.value.trim(); if (v) update(r.key, { label: v }); setEditing(null); }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = r.label; e.target.blur(); } }} />);
  const kidHint = r => {
    const locked = r.children.some(c => c.liId == null);
    if (r.add) return 'Added in this draft: its issues can be edited after you save.';
    if (r.linked && !r.unpack) return `Follows the original ${r.type === 'event' ? 'Timeline event' : 'Top Shelf run'}. Choose Make own copy (⋯) to edit its issues.`;
    if (r.linked && r.unpack) return 'Becomes your own copy when you save; then its issues can be edited.';
    if (r.isNew && locked) return 'Issues from a Timeline or Top Shelf entry stay together until you save.';
    if (r.autoUnpack && !childrenChanged(r) && !r.unpack) return 'Editing these issues makes this entry your own copy (it stops refreshing).';
    return null;
  };

  return (
    <div ref={rootRef} className={`page-container le le-readable${selected.size ? ' ticking' : ''}${drag ? ' dragging' : ''}`}>
      <Style />
      <header className="le-head" ref={headRef}>
        <button className="le-back" onClick={() => navigate(backTo)} title="Back" aria-label="Back">←</button>
        <div className="le-titles">
          <h1>{base ? (details && adapter.titleOf && adapter.titleOf(details)) || base.title : error ? 'Editor' : 'Loading…'}</h1>
          <div className="le-sub">{base ? `${base.subtitle} · editing` : ''}</div>
        </div>
        <div className="le-status">
          <span className={dirty ? 'dirty' : ''} title={changes.join(', ')}>
            {saving ? 'Saving…' : dirty ? `Unsaved · ${changes.slice(0, 3).join(', ')}${changes.length > 3 ? ', …' : ''}` : base ? 'All changes saved' : ''}
          </span>
          {dirty && !saving && <button className="le-link" onClick={discard}>Discard</button>}
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>Save</button>
        </div>
      </header>
      <div className="le-body">
        {error && <div className="le-notice error">{error}</div>}
        {restore && <div className="le-notice warn">
          <span>Unsaved changes from {new Date(restore.at).toLocaleString()} are kept in this browser.</span>
          <button className="le-link" onClick={applyRestore}>Restore them</button>
          <button className="le-link" onClick={() => { store.clear(sKey); setRestore(null); }}>Discard them</button>
        </div>}
        {notice && <div className={`le-notice ${notice.tone}`}><span>{notice.text}</span><button className="le-x" onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
        {base && <>
          {details && adapter.fields && <DetailsPanel fields={adapter.fields(base)} base={base.details} draft={details} onChange={setDetails}
            events={base.events} summary={adapter.summary(details)}
            extra={adapter.deleteItem ? <div className="le-d-danger">
              {confirmDel ? <><span>{adapter.deleteWarning(base, base.rows)}</span>
                <button className="le-link danger" onClick={deleteItem} disabled={leaving}>Delete</button>
                <button className="le-link" onClick={() => setConfirmDel(false)}>Keep</button></>
                : <button className="le-link danger" onClick={() => setConfirmDel(true)}>{adapter.deleteLabel}</button>}
            </div> : null} />}
          <div className="le-order-heading"><h2>Reading order</h2><span className="le-muted">{rows.filter(r => r.type !== 'section').length} entries</span></div>
          <div className="le-bar">
            <div className="le-seg" role="group" aria-label="Show">
              {[['all', 'All'], ['missing', 'Not in library'], caps.notes && ['notes', caps.noteLabel ? `With ${caps.noteLabel.toLowerCase()}s` : 'With notes']].filter(Boolean)
                .map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}
            </div>
            <span className="le-spacer" />
            {caps.orderNote && <span className="le-muted">{caps.orderNote}</span>}
            {removed.length > 0 && <button className="le-link" onClick={putBack}>Put back {removed.length} removed</button>}
            <button className="le-link le-toolbar-button" onClick={() => setAddOpen(true)} title="Add issues (A)">+ Add</button>
            {adapter.tools && <button className="le-link le-toolbar-button" onClick={e => openMenu(e, toolItems())}>Tools ▾</button>}
            {adapter.loadSources && <button className="le-link le-toolbar-button" onClick={toggleSources}
              title="Which reading-order sites list each issue, the pages the generator read, and what it left out">{src && src.on ? 'Hide sources' : 'Show sources'}</button>}
            {adapter.loadSources && <button className="le-link le-toolbar-button" onClick={toggleReasoning}
              title="Why the generator gave each issue its tier, and why it moved issues from release order">{why ? 'Hide reasoning' : 'Show reasoning'}</button>}
            {caps.sections && <button className="le-link le-toolbar-button" onClick={addSection}>+ Section</button>}
            <span className="le-help" tabIndex={0} title={help} aria-label={help}>?</span>
          </div>
          {src && src.on && <SourcesPanel src={src} />}
          {why && src && src.data && src.data.centralNarrative && <div className="le-srcpanel"><div><b>Main story, as the generator read it</b>{src.data.centralNarrative}</div></div>}
          <div className="le-list">
            {!rows.length && <p className="le-muted pad">Nothing here yet.</p>}
            {visible.map(r => {
              const sec = r.type === 'section', sel = selected.has(r.key), isOpen = open.has(r.key);
              const zone = drag && drag.over && drag.over.row === r.key && !drag.over.child ? drag.over.zone : null;
              const moving = drag && drag.kind === 'rows' && drag.keys.includes(r.key);
              const tot = totalOf(r), own = ownedOf(r);
              const willCopy = r.unpack || (r.autoUnpack && childrenChanged(r));
              const tierOn = !sec && caps.tiers && caps.tierFor(r);
              const tierVal = r.tier || (caps.tiers ? caps.tiers[0][0] : '');
              const meta = sec ? null : tot === 0 ? <span className="le-meta">{r.pending ? 'fetching…' : 'no issues'}</span>
                : !r.children ? (r.single ? (own ? null : <span className="le-meta missing">not in library</span>) : <span className="le-meta">{tot} issue{tot === 1 ? '' : 's'}</span>)
                : <span className={`le-meta${own < tot ? ' part' : ''}`}>{own}/{tot} in library</span>;
              const hint = !sec && r.children && isOpen ? kidHint(r) : null;
              return (
                <div key={r.key} className={`le-item${sec ? ' sec' : ''}${sel ? ' sel' : ''}${moving ? ' moving' : ''}${zone ? ' drop-' + zone : ''}${r.id == null && !r.fromPhase ? ' new' : ''}`}>
                  <div className="le-head-row" onDragOver={e => overRow(e, r)} onDrop={drop}>
                    <div className="le-row">
                      {caps.reorder ? <span className="le-grip" draggable onDragStart={e => startRowDrag(e, r)} onDragEnd={() => setDrag(null)} title="Drag to move">⠿</span> : <span />}
                      <input className="le-tick" type="checkbox" checked={sel} onChange={() => {}} onClick={e => clickSelect(e, r.key)} aria-label="Tick" />
                      {sec ? <button className="le-caret" onClick={() => toggle(setCollapsed, r.key)} aria-label={collapsed.has(r.key) ? 'Expand section' : 'Collapse section'}>{collapsed.has(r.key) ? '▸' : '▾'}</button>
                        : <span className="le-pos">{position.get(r.key)}</span>}
                      {sec ? <span />
                        : r.single ? <Thumb bookId={r.single.book_id || null} onClick={matchTargetFor(r) ? () => openMatch(r) : null}
                            title={!matchTargetFor(r) ? 'Added in this draft: save first to change the match' : r.single.book_id ? 'Change the match' : 'No match: find it or get it'} />
                        : r.children ? <Thumb bookId={(r.children.find(c => c.bookId) || {}).bookId || null} onClick={() => toggle(setOpen, r.key)} title={isOpen ? 'Hide issues' : 'Show issues'} />
                        : <span />}
                      <span className="le-main">
                        {!sec && r.children && <button className="le-caret" onClick={() => toggle(setOpen, r.key)} title={isOpen ? 'Hide issues' : 'Show issues'}>{isOpen ? '▾' : '▸'}</button>}
                        {!sec && caps.groups && TYPE_MARK[r.type] && <span className="le-mark">{TYPE_MARK[r.type]}</span>}
                        {editing && editing.key === r.key && editing.field === 'label' ? labelEditor(r)
                          : <span className="le-label" title={r.label} onDoubleClick={() => (sec || caps.rename || r.isNew) && setEditing({ key: r.key, field: 'label' })}>{r.label}</span>}
                        {adapter.coverPick && details && r.id != null && details[adapter.coverPick.field] === r.id && <span className="le-tag">{adapter.coverPick.label}</span>}
                        {willCopy && <span className="le-tag">own copy on save</span>}
                      </span>
                      {meta || <span />}
                      {tierOn ? <span className="le-tier"><i style={{ background: TIER_DOT[tierVal] || 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))' }} />
                        <select value={tierVal} onChange={e => update(r.key, { tier: e.target.value, ...(adapter.askTierReason && r.id != null && r.tierFrom == null ? { tierFrom: r.tier } : {}) })} title={adapter.kind === 'list' ? 'Which tie-ins this Timeline entry includes' : 'Tier'}>
                          {caps.tiers.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></span> : <span />}
                      <button className="le-more" onClick={e => openMenu(e, rowMenu(r))} aria-label="More actions" title="More">⋯</button>
                    </div>
                    {!sec && caps.notes && (editing && editing.key === r.key && editing.field === 'note' ? noteEditor(r)
                      : r.note ? <div className="le-note" onClick={() => setEditing({ key: r.key, field: 'note' })} title="Click to edit">{r.note}</div> : null)}
                    {!sec && r.id != null && srcById.has(r.id) && <SourceLine info={srcById.get(r.id)} />}
                    {!sec && r.id != null && whyById.has(r.id) && <ReasonLine info={whyById.get(r.id)} />}
                    {!sec && adapter.askTierReason && r.id != null && r.tierFrom != null && r.tierFrom !== r.tier && <div className="le-reason-ask">
                      <label>Why {(caps.tiers.find(([v]) => v === r.tier) || [r.tier, r.tier])[1]}? <span className="le-muted">(optional; replaces the generator’s tier reason when you save)</span></label>
                      <input className="le-note-edit" value={r.reason || ''} maxLength={300} placeholder={`e.g. “parallel story; I read it and it matters”. Empty: the change from ${r.tierFrom} is recorded.`}
                        onChange={e => update(r.key, { reason: e.target.value })} />
                    </div>}
                  </div>
                  {!sec && r.children && isOpen && <div className="le-kids">
                    {hint && <div className="le-hint">{hint}</div>}
                    {r.children.map(c => {
                      const cz = drag && drag.over && drag.over.row === r.key && drag.over.child === c.key ? drag.over.zone : null;
                      const movable = r.childrenEditable && c.liId != null;
                      return (
                        <div key={c.key} className={`le-kid${cz ? ' drop-' + cz : ''}${drag && drag.kind === 'child' && drag.key === c.key ? ' moving' : ''}`} onDragOver={e => overChild(e, r, c)} onDrop={drop}>
                          {movable ? <span className="le-grip" draggable onDragStart={e => startChildDrag(e, r, c)} onDragEnd={() => setDrag(null)} title="Drag to move this issue">⠿</span> : <span />}
                          <Thumb bookId={c.bookId || null} onClick={c.liId != null ? () => openMatch(r, c) : null}
                            title={c.liId == null ? (r.add ? 'Save first' : 'Make own copy and save first') : c.bookId ? 'Change the match' : 'No match: find it or get it'} />
                          <span className="le-kid-label" title={c.label}>{c.label}</span>
                          {c.owned ? <span /> : <span className="le-meta missing">not in library</span>}
                          <button className="le-more" onClick={e => openMenu(e, childMenu(r, c))} aria-label="Issue actions" title="More">⋯</button>
                        </div>);
                    })}
                    {!r.children.length && <div className="le-hint">{childrenChanged(r) ? 'No issues left; this entry goes when you save.' : 'No issues yet.'}</div>}
                  </div>}
                </div>);
            })}
          </div>
          {filter !== 'all' && <p className="le-muted small">A filter is on; moved rows still land among all entries.</p>}
        </>}
      </div>
      {selected.size > 0 && <div className="le-pill" role="toolbar" aria-label="Ticked rows">
        <b>{selected.size} ticked</b>
        {nCombinable >= 2 && <button onClick={() => combine(selKeys)}>Combine into crossover</button>}
        {caps.reorder && <button onClick={() => moveKeys(selKeys, null, true)}>To top</button>}
        {caps.reorder && <button onClick={() => moveKeys(selKeys, null, false)}>To bottom</button>}
        {caps.reorder && sections.some(s => !selected.has(s.key)) && <button onClick={e => openMenu(e, sections.filter(s => !selected.has(s.key))
          .map(s => ({ label: s.label, run: () => moveKeys(selKeys.filter(k => k !== s.key), s.key, false) })))}>Under section…</button>}
        <button className="danger" onClick={() => removeKeys(selKeys)}>Remove</button>
        <button className="le-x" onClick={() => setSelected(new Set())} aria-label="Clear ticks" title="Clear (Esc)">✕</button>
      </div>}
      {menu && <Menu rect={menu.rect} items={menu.items} onClose={() => setMenu(null)} />}
      {addOpen && <AddWindow kind={adapter.kind} tiers={adapter.kind === 'event' ? caps.tiers : null} count={positionCount} defaultPos={addDefaultPos}
        defaultTier={adapter.kind === 'event' ? tierBefore(addDefaultPos) : null} existing={existing}
        onAdd={(newRows, pos) => insertAt(newRows, pos)} onClose={() => setAddOpen(false)} />}
      {tool && <ToolWindow tool={tool} kind={adapter.kind} id={id} rows={rows} dirty={dirty} onClose={() => setTool(null)}
        onRematched={applyRematch} onNotes={applyNotes} onRebuilt={async d => { await load(); say(`Rebuilt from Comic Vine: ${plural(d.inserted || 0, 'issue')} added, ${d.matched || 0} in your library.`, 'ok'); }} />}
      {match && <IssueWindow issue={match.issue} target={match.target} acquire={match.acquire} onClose={() => setMatch(null)} onDone={book => applyMatch(match, book)} />}
    </div>
  );
}

// ── Show sources (events) ──
const FLAG_TEXT = { late: 'read weeks after its release date, with no reason given', early: 'read weeks before its release date, with no reason given' };
function SourceLine({ info }) {
  if (!info.sources.length && !info.order_flag) return null;
  return <div className="le-src">
    {info.sources.length > 0 && <span title="Sites whose page lists this issue for the event">{info.sources.join(' · ')}</span>}
    {info.order_flag && <span className="flag">{FLAG_TEXT[info.order_flag] || info.order_flag}</span>}
  </div>;
}
function ReasonLine({ info }) {
  if (!info.tier_reason && !info.order_note) return null;
  return <div className="le-src why">
    {info.tier_reason && <span title={/^admin/.test(info.tier_reason) ? 'Your reason, given when you changed the tier' : 'Why the generator gave this tier (a tier you change asks for your reason, which replaces this)'}>Tier: {info.tier_reason}</span>}
    {info.order_note && <span title="Why it was moved from release order">Moved: {info.order_note}</span>}
  </div>;
}
function SourcesPanel({ src }) {
  if (src.loading) return <p className="le-muted pad">Loading sources…</p>;
  if (src.error) return <p className="le-muted pad">{src.error}</p>;
  const d = src.data || {};
  if (!d.recorded) return <p className="le-muted pad">No sources were recorded for this event. Events made before the October 2026 generator update have none.</p>;
  return <div className="le-srcpanel">
    <div><b>Pages read</b>{d.sourcesRead.length ? d.sourcesRead.map(p => p.url ? <a key={p.code + p.url} href={p.url} target="_blank" rel="noreferrer">{p.code}</a> : <span key={p.code} title="pasted text, no address"> {p.code}</span>) : <span className="le-muted"> none (AI knowledge)</span>}</div>
    <div><b>Left out ({d.omitted.length})</b>{d.omitted.length ? <ul>{d.omitted.map((o, n) => <li key={n}>{o.series_name} #{o.issue_number}{o.volume_year ? ` (${o.volume_year})` : ''}
      <span className="le-muted"> — {o.listed_by.join(', ') || 'no site'}: {o.reason || 'no reason given'}</span></li>)}</ul> : <span className="le-muted"> nothing</span>}</div>
  </div>;
}

function Style() {
  return <style>{`
    .le { padding: 0 0 110px; }
    .le-head { position: sticky; top: 0; z-index: 6; display: flex; align-items: center; gap: 14px; padding: 14px 24px; background: var(--bg-base, #111); border-bottom: 1px solid var(--border-subtle); }
    .le-back { background: none; border: 0; color: var(--text-muted); font-size: 1.3rem; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
    .le-back:hover { color: var(--text-primary); background: var(--bg-hover); }
    .le-titles { min-width: 0; flex: 1; }
    .le-titles h1 { margin: 0; font-size: 1.15rem; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .le-sub { color: var(--text-muted); font-size: 0.8rem; }
    .le-status { display: flex; align-items: center; gap: 14px; }
    .le-status > span { color: var(--text-muted); font-size: 0.85rem; max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .le-status > span.dirty { color: var(--td-yellow, #f5c518); }
    .le-body { max-width: 1080px; margin: 0 auto; padding: 14px 24px 0; }
    .le-link { background: none; border: 0; padding: 0; font: inherit; font-size: 0.85rem; color: var(--text-secondary, var(--text-muted)); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: transparent; }
    .le-link:hover { color: var(--text-primary); text-decoration-color: currentColor; }
    .le-link.danger, .le-menu button.danger, .le-pill button.danger { color: #e07070; }
    .le-muted { color: var(--text-muted); font-size: 0.82rem; }
    .le-muted.pad { padding: 14px; } .le-muted.small { font-size: 0.75rem; margin-top: 8px; }
    .le-notice { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 8px 12px; border-radius: 8px; margin-bottom: 10px; font-size: 0.86rem; border: 1px solid var(--border-subtle); background: var(--bg-surface, rgba(255,255,255,0.03)); }
    .le-notice > span { flex: 1; }
    .le-notice.warn { border-color: color-mix(in srgb, var(--td-yellow) 45%, transparent); background: color-mix(in srgb, var(--td-yellow) 7%, transparent); }
    .le-notice.error { border-color: color-mix(in srgb, color-mix(in srgb, var(--td-red) 70%, white) 50%, transparent); background: color-mix(in srgb, color-mix(in srgb, var(--td-red) 70%, white) 8%, transparent); }
    .le-notice.ok { border-color: rgba(76,170,96,0.45); background: rgba(76,170,96,0.07); }
    .le-x { background: none; border: 0; color: var(--text-muted); cursor: pointer; font-size: 1rem; line-height: 1; padding: 2px 6px; border-radius: 6px; }
    .le-x:hover { color: var(--text-primary); background: var(--bg-hover); }
    .le-bar { display: flex; align-items: center; gap: 16px; margin: 4px 0 10px; }
    .le-spacer { flex: 1; }
    .le-seg { display: inline-flex; background: var(--bg-surface, rgba(255,255,255,0.04)); border-radius: 999px; padding: 2px; }
    .le-seg button { background: none; border: 0; color: var(--text-muted); padding: 4px 12px; border-radius: 999px; font: inherit; font-size: 0.8rem; cursor: pointer; }
    .le-seg button.on { background: var(--bg-elevated, rgba(255,255,255,0.1)); color: var(--text-primary); }
    .le-help { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border-subtle); color: var(--text-muted); font-size: 0.72rem; cursor: help; }
    .le-list { border-top: 1px solid var(--border-subtle); }
    .le-item { border-bottom: 1px solid var(--border-subtle); }
    .le-item.sel { background: color-mix(in srgb, var(--td-yellow) 6%, transparent); }
    .le-item.new > .le-head-row { box-shadow: inset 2px 0 0 #4caa60; }
    .le-item.moving { opacity: 0.4; }
    .le-item.drop-before > .le-head-row { box-shadow: inset 0 2px 0 var(--td-yellow, #f5c518); }
    .le-item.drop-after > .le-head-row { box-shadow: inset 0 -2px 0 var(--td-yellow, #f5c518); }
    .le-item.drop-into > .le-head-row { background: color-mix(in srgb, var(--td-yellow) 10%, transparent); outline: 1px dashed var(--td-yellow, #f5c518); outline-offset: -2px; }
    .le-row { display: grid; grid-template-columns: 14px 16px 30px 26px minmax(0, 1fr) auto auto 26px; align-items: center; column-gap: 10px; padding: 5px 8px; min-height: 38px; font-size: 0.9rem; }
    .le-item.sec { border-bottom: 0; margin-top: 14px; }
    .le-item.sec .le-row { font-weight: 700; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-secondary, var(--text-muted)); }
    .le-item.sec:first-child { margin-top: 0; }
    .le-grip { cursor: grab; color: var(--text-muted); user-select: none; opacity: 0; font-size: 0.85rem; }
    .le-tick { margin: 0; opacity: 0; cursor: pointer; accent-color: var(--td-yellow, #f5c518); }
    .le-more { background: none; border: 0; color: var(--text-muted); cursor: pointer; border-radius: 6px; padding: 0 4px; font-size: 1.05rem; line-height: 1.3; opacity: 0; }
    .le-more:hover { background: var(--bg-hover); color: var(--text-primary); }
    .le-head-row:hover .le-row .le-grip, .le-head-row:hover .le-row .le-tick, .le-head-row:hover .le-row .le-more,
    .le-kid:hover .le-grip, .le-kid:hover .le-more, .le-item.sel .le-tick, .le.ticking .le-tick,
    .le-tick:focus-visible, .le-more:focus-visible { opacity: 1; }
    .le.dragging .le-more { opacity: 0 !important; }
    .le-pos { color: var(--text-muted); text-align: right; font-size: 0.78rem; font-variant-numeric: tabular-nums; }
    .le-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .le-caret { background: none; border: 0; color: var(--text-muted); cursor: pointer; padding: 0 2px; font-size: 0.75rem; width: 14px; }
    .le-label { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .le-item.sec .le-label { color: inherit; }
    .le-mark { flex: none; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0 5px; line-height: 1.5; }
    .le-tag { flex: none; font-size: 0.7rem; color: var(--td-yellow, #f5c518); }
    .le-meta { color: var(--text-muted); font-size: 0.78rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .le-meta.missing { color: #d08a5a; } .le-meta.part { color: var(--text-secondary, var(--text-muted)); }
    .le-tier { display: inline-flex; align-items: center; gap: 6px; }
    .le-src { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 0 8px 6px 104px; font-size: 0.75rem; color: var(--text-muted); }
    .le-src .flag { color: #d9a441; }
    .le-src.why { flex-direction: column; gap: 1px; color: var(--text-secondary, var(--text-muted)); }
    .le-reason-ask { padding: 0 8px 10px 104px; font-size: 0.78rem; }
    .le-reason-ask label { display: block; margin-bottom: 3px; color: #d9a441; }
    .le-reason-ask .le-note-edit { display: block; margin: 0; width: 100%; box-sizing: border-box; }
    .le-srcpanel { display: flex; flex-direction: column; gap: 8px; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--border, #333); border-radius: 6px; font-size: 0.82rem; }
    .le-srcpanel b { margin-right: 8px; }
    .le-srcpanel a { margin-right: 10px; color: var(--accent, #f5c518); }
    .le-srcpanel ul { margin: 6px 0 0; padding-left: 18px; max-height: 180px; overflow-y: auto; }
    .le-tier i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .le-tier select { background: transparent; border: 0; color: var(--text-secondary, var(--text-muted)); font: inherit; font-size: 0.8rem; cursor: pointer; padding: 2px 0; }
    .le-tier select:hover { color: var(--text-primary); }
    .le-tier option { background: var(--bg-card, #1b1b1b); color: var(--text-primary); }
    .le-input { background: var(--bg-surface, transparent); color: var(--text-primary); border: 1px solid var(--border-active, var(--border-subtle)); border-radius: 6px; padding: 3px 8px; font: inherit; min-width: 0; flex: 1; }
    .le-note { margin: -2px 40px 8px 134px; color: var(--text-muted); font-size: 0.8rem; font-style: italic; cursor: text; white-space: pre-wrap; }
    .le-note:hover { color: var(--text-secondary, var(--text-primary)); }
    .le-note-edit { display: block; box-sizing: border-box; width: calc(100% - 174px); margin: -2px 40px 8px 134px; min-height: 56px; background: var(--bg-surface, transparent); color: var(--text-primary); border: 1px solid var(--border-active, var(--border-subtle)); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 0.84rem; }
    .le-kids { margin: 0 8px 8px 74px; border-left: 1px solid var(--border-subtle); }
    .le-hint { color: var(--text-muted); font-size: 0.76rem; padding: 4px 12px; }
    .le-kid { display: grid; grid-template-columns: 14px 26px minmax(0, 1fr) auto 26px; column-gap: 10px; align-items: center; padding: 3px 0 3px 10px; font-size: 0.84rem; }
    .le-kid.moving { opacity: 0.4; }
    .le-kid.drop-before { box-shadow: inset 0 2px 0 var(--td-yellow, #f5c518); }
    .le-kid.drop-after { box-shadow: inset 0 -2px 0 var(--td-yellow, #f5c518); }
    .le-kid-label { color: var(--text-secondary, var(--text-primary)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .le-pill { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 20; display: flex; align-items: center; gap: 2px; padding: 5px 6px 5px 16px; border-radius: 999px; background: var(--bg-elevated, #222); border: 1px solid var(--border-subtle); box-shadow: 0 10px 30px rgba(0,0,0,0.45); font-size: 0.85rem; white-space: nowrap; }
    .le-pill b { margin-right: 8px; color: var(--text-primary); font-weight: 600; }
    .le-pill button { background: none; border: 0; color: var(--text-primary); font: inherit; padding: 6px 11px; border-radius: 999px; cursor: pointer; }
    .le-pill button:hover { background: var(--bg-hover); }
    .le-menu { position: fixed; z-index: 50; min-width: 210px; max-height: 320px; overflow-y: auto; padding: 4px; border-radius: 10px; background: var(--bg-elevated, #222); border: 1px solid var(--border-subtle); box-shadow: 0 12px 32px rgba(0,0,0,0.45); }
    .le-menu button { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--text-primary); font: inherit; font-size: 0.86rem; padding: 7px 12px; border-radius: 6px; cursor: pointer; }
    .le-menu button:hover:not(:disabled) { background: var(--bg-hover); }
    .le-menu button:disabled { opacity: 0.45; cursor: default; }
    .le-menu-sep { height: 1px; background: var(--border-subtle); margin: 4px 6px; }
    .le-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.55); display: grid; place-items: center; }
    .le-dialog { width: min(640px, 92vw); max-height: 80vh; display: flex; flex-direction: column; background: var(--bg-card, #1b1b1b); border: 1px solid var(--border-subtle); border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
    .le-dialog-head { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px 6px; }
    .le-dialog-head .le-x { margin-left: auto; }
    .le-dialog-search { display: flex; gap: 8px; padding: 6px 16px 10px; }
    .le-dialog-search .le-input.num { flex: 0 0 70px; }
    .le-dialog .le-notice { margin: 0 16px 8px; }
    .le-results { overflow-y: auto; border-top: 1px solid var(--border-subtle); }
    .le-result { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--border-subtle); color: var(--text-primary); font: inherit; font-size: 0.86rem; padding: 8px 16px; cursor: pointer; }
    .le-result:hover:not(:disabled) { background: var(--bg-hover); }
    .le-result .le-muted { font-size: 0.74rem; }
    .le-dialog-foot { padding: 10px 16px; border-top: 1px solid var(--border-subtle); }
    .le-narrow { padding: 24px 16px; color: var(--text-muted); }
    ${detailsCss}
    ${issueWindowCss}
    ${addWindowCss}
    ${toolWindowCss}
    ${readableCss}
    ${responsiveCss}
  `}</style>;
}
