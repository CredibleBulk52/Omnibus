// ─── List editor adapters ─────────────────────────────────────────
// How each kind loads into editor rows and saves back. The editor shell
// (ListEditor.jsx) is the same for all of them. claude/ADMIN_REORG.md step 3.
//
// Row:   { key, id, type, label, note, tier, sub, owned, total, linked, unpacked,
//          refreshable, isNew, unpack, children: [Child] | null, childrenOrig,
//          childrenEditable, autoUnpack, sourceRows }
// Child: { key, liId, label, owned, bookId, lockedFrom }
import { isAdmin } from '../../App';
import { collectionsFor } from '../../pages/listCatalog';
const homepageFields = [
  {key:'home_tagline', label:'Homepage tagline', type:'text', max:120, wide:true, group:'Homepage', help:'Optional headline when this item is featured. Blank uses its title.'},
  {key:'home_description', label:'Homepage introduction', type:'textarea', max:400, wide:true, rows:3, group:'Homepage', help:'Optional short introduction for the homepage. Blank uses the description.'},
];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const delFetch = url => fetch(url, { method: 'DELETE' }).then(json);
// What else is affected when a Timeline event or Top Shelf run is deleted.
const usageNote = (u, what) => [
  u && u.lists ? `${plural(u.lists, 'reading list')} follow${u.lists === 1 ? 's' : ''} this ${what}; ${u.lists === 1 ? 'it' : 'they'} will show it as missing.` : '',
  u && u.runs ? `${plural(u.runs, 'Top Shelf run')} link${u.runs === 1 ? 's' : ''} to it and will be unlinked.` : '',
].filter(Boolean).join(' ');
const firstLine = t => String(t || '').split('\n')[0].replace(/\*\*/g, '');
const json = async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(d.error || `Request failed (${r.status})`); e.status = r.status; e.conflict = !!d.conflict; throw e; } return d; };
const get = url => fetch(url).then(json);
const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
const issueLabel = i => `${i.series_name || 'Unknown'}${i.volume_year ? ` (${i.volume_year})` : ''} #${i.issue_number ?? '?'}`;

// ── Reading lists and Essentials ──
const childOf = (i, lockedFrom = null) => ({ key: i.id != null ? 'li' + i.id : `lk${lockedFrom}-${i.cv_issue_id || i.issue_number}-${Math.random().toString(36).slice(2, 7)}`,
  liId: i.id ?? null, label: issueLabel(i), owned: !!i.owned, bookId: i.book_id || null, lockedFrom, issue: i });
function listRow(e) {
  const linked = !!e.linked && !e.unpacked;
  const hasKids = e.type !== 'section' && e.type !== 'issue';
  const children = hasKids ? (e.issues || []).map(i => childOf(i, linked ? e.id : null)) : null;
  return {
    key: 'e' + e.id, id: e.id, type: e.type, label: e.label, note: e.note || '', tier: e.tier?.filter || null,
    owned: e.progress?.owned || 0, total: e.progress?.total || 0, linked, unpacked: !!e.unpacked, refreshable: !!e.refreshable, pending: e.resolve_status === 'pending',
    single: e.type === 'issue' ? (e.issues || [])[0] || null : null,
    children, childrenOrig: children ? children.map(c => c.liId) : null,
    childrenEditable: e.type === 'story' || !!e.unpacked || (!linked && (e.type === 'range' || e.type === 'series')),
    autoUnpack: !e.unpacked && (e.type === 'range' || e.type === 'series'),
  };
}
export const listAdapter = {
  kind: 'list', noun: 'list',
  caps: { reorder: true, sections: true, groups: true, notes: true, rename: true, children: true,
    tiers: [['essential', 'Essential only'], ['recommended', 'Essential + recommended'], ['all', 'Every tie-in']], tierFor: r => r.type === 'event' && r.linked },
  async load(id) {
    const [d, g] = await Promise.all([get(`/api/reading-lists/${id}`), get('/api/reading-lists/groups').catch(() => ({ groups: [] }))]);
    if (!d.can_edit) throw new Error('You can only edit your own reading lists.');
    return { title: d.list.name, subtitle: d.list.visibility === 'essential' ? 'Essentials list' : 'Reading list', version: d.list.updated_at, rows: d.entries.map(listRow),
      details: { name: d.list.name || '', description: d.list.description || '', visibility: d.list.visibility, home_tagline:d.list.home_tagline || '', home_description:d.list.home_description || '',
        catalog_collections: d.list.catalog?.collection_ids?.length ? d.list.catalog.collection_ids : collectionsFor(d.list) }, isOwner: !!d.list.is_owner, groupNames: g.collections || [], source: d.list.source };
  },
  // Hero details (Details panel). Same rules as the old Settings dialog.
  fields(base) {
    const cur = base.details.visibility;
    const vis = [['private', 'Private'], ['public', 'Shared'], ['essential', 'Essential']]
      .filter(([v]) => (v !== 'private' || base.isOwner || cur === 'private') && (v !== 'essential' || isAdmin() || cur === 'essential'));
    return [
      { key: 'name', label: 'Name', type: 'text', max: 200, wide: true },
      { key: 'description', label: 'Description', type: 'textarea', max: 4000, wide: true, rows: 5, placeholder: "What's this path through the long box?", help: 'Wrap words in **double asterisks** for bold.' },
      ...(isAdmin() && cur === 'essential' ? homepageFields : []),
      { key: 'visibility', label: 'Who can see it', type: 'select', options: vis,
        help: v => ({ private: 'Only you can see this reading order.', public: 'Shared: other readers find it with Find shared boxes on the Comic Box page, and can follow or copy it.', essential: 'Featured for everyone as an Essentials list. Admin only.' })[v] },
      // Where an Essential sits on the Essentials page (nothing is grouped automatically). Only
      // Essentials: reading orders are boxes on the Comic Box page (2026-11-03, BOXES_UNIFIED_PLAN).
      ...(cur === 'essential' ? [
        { key: 'catalog_collections', label: 'Collections', type: 'collections', wide:true, group:'Catalog', suggest:base.groupNames || [] },
      ] : []),
    ];
  },
  titleOf: d => d.name,
  // An imported list starts as the admin's private draft (curatedTransfer.js, 2026-11-12).
  draftNote: base => (base.source === 'import' && base.details.visibility === 'private'
    ? 'Imported draft: only you can see it. To publish it, open Details, set Who can see it to Essential (or Shared), then Save.' : null),
  summary: d => [d.name, firstLine(d.description)].filter(Boolean).join(' — '),
  // Delete the whole list (immediate, after a confirm); where to go afterwards.
  deleteItem: id => delFetch(`/api/reading-lists/${id}`),
  deleteLabel: 'Delete this list…',
  deleteWarning: base => `Delete “${base.details.name}” and all its entries for good?`,
  afterDelete: base => (base.details.visibility === 'essential' ? '/essentials' : '/collections'),
  // Children (issues) of an entry: own copies, crossovers, stored ranges.
  combinable: r => r.type !== 'section',
  buildSave(rows, removed, absorbed, version, original) {
    const byId = new Map(original.map(r => [r.id, r]));
    const order = rows.map(r => {
      // Added from the Add window: an issue (backend default label), a range or picked set (its label), an event or run.
      if (r.add) return { add: { ...r.add, label: r.add.type === 'issue' ? undefined : r.label, note: r.note || undefined }, ...(r.add.type === 'event' && r.tier ? { tier: r.tier } : {}) };
      if (r.type === 'section' && !r.id) return { add: { type: 'section', label: r.label, note: r.note || undefined } };
      if (r.isNew && r.type === 'story') {
        const members = []; const seen = new Set();
        for (const c of r.children) {
          if (c.liId != null) members.push({ li: c.liId });
          else if (!seen.has(c.lockedFrom)) { seen.add(c.lockedFrom); members.push({ entry: c.lockedFrom }); }
        }
        return { add: { type: 'story', label: r.label, note: r.note || undefined }, members };
      }
      if (r.isNew && r.type === 'issue') return { add: { type: 'issue' }, members: [{ li: r.children ? r.children[0].liId : r.single.id }] };
      const o = byId.get(r.id), x = { id: r.id };
      if (o && o.label !== r.label) x.label = r.label;
      if (o && (o.note || '') !== (r.note || '')) x.note = r.note || null;
      if (o && r.tier && o.tier !== r.tier) x.tier = r.tier;
      if (r.unpack) x.unpack = true;
      const now = r.children ? r.children.map(c => c.liId) : null;
      if (now && (now.length !== r.childrenOrig.length || now.some((v, i) => v !== r.childrenOrig[i]))) { x.issues = now; if (r.autoUnpack) x.unpack = true; }
      return Object.keys(x).length === 1 ? r.id : x;
    });
    for (const a of absorbed) order.push({ id: a.id, issues: [], ...(a.autoUnpack ? { unpack: true } : {}) });
    const consumedIds = new Set(rows.filter(r => r.isNew && r.type === 'story').flatMap(r => r.children.filter(c => c.liId == null).map(c => c.lockedFrom)));
    return { version, order, remove: removed.map(r => r.id).filter(id => !consumedIds.has(id)) };
  },
  save: (id, body) => post(`/api/reading-lists/${id}/save`, body),
  refresh: (id, row) => post(`/api/reading-lists/${id}/entries/${row.id}/refresh`, {}),
  matchTarget: (id, child) => (child.liId != null ? { url: `/api/reading-lists/${id}/issues/${child.liId}/match`, method: 'PATCH', body: bookId => ({ bookId, syncCv: true }) } : null),
  // The issue behind a row or child, for "Get this issue" (admin).
  acquireFor: (id, r, c) => { const li = c ? c.liId : r.single && r.single.id; return li != null ? { kind: 'list', owner: id, issue: li } : null; },
};

// ── Timeline events: issues with tiers; phases are sections ──
export const eventAdapter = {
  kind: 'event', noun: 'event',
  tools: ['rematch', 'annotate'],
  caps: { reorder: true, sections: true, groups: false, notes: true, noteLabel: 'Tier note', rename: false, children: false,
    tiers: [['essential', 'Essential'], ['recommended', 'Recommended'], ['tie-in', 'Tie-in'], ['aftermath', 'Aftermath']], tierFor: () => true },
  async load(id) {
    const d = await get(`/api/editor/event/${id}`);
    const rows = []; let phase;
    d.rows.forEach((r, i) => {
      if (r.phase && r.phase !== phase) rows.push({ key: `p${i}`, id: null, type: 'section', label: r.phase, note: '', fromPhase: true });
      phase = r.phase;
      rows.push({ key: 'i' + r.id, id: r.id, type: 'issue', label: issueLabel(r), note: r.tier_note || '', tier: r.tier, owned: r.owned ? 1 : 0, total: 1,
        single: { id: r.id, owned: r.owned, book_id: r.scanned_book_id, series_name: r.series_name, issue_number: r.issue_number, volume_year: r.volume_year, cv_issue_id: r.cv_issue_id } });
    });
    return { title: d.title, subtitle: 'Timeline event', version: d.version, rows, details: d.details, usage: d.usage };
  },
  deleteItem: id => delFetch(`/api/editor/event/${id}`),
  deleteLabel: 'Delete this event…',
  deleteWarning: (base, rows) => `Delete “${base.details.name}” and its ${plural(rows.filter(r => r.type !== 'section').length, 'issue')} for good? ${usageNote(base.usage, 'event')}`.trim(),
  afterDelete: () => '/events',
  // ⋯ › Use as Timeline cover on an owned issue (2026-11-10): details.cover_issue_id.
  coverPick: { field: 'cover_issue_id', label: 'Timeline cover' },
  draftNote: base => (base.details.draft ? 'Hidden draft: readers cannot see this event yet. To publish it, open Details, turn off Hidden draft, then Save.' : null),
  fields: base => [
    ...(base && base.details && 'draft' in base.details ? [{ key: 'draft', label: 'Hidden draft', type: 'switch', switchLabel: 'Only admins can see this event (imported, not yet published)' }] : []),
    ...homepageFields,
    { key: 'name', label: 'Name', type: 'text', max: 200 },
    { key: 'event_tier', label: 'Event tier', type: 'select', number: true, options: [[1, 'Crisis-level event'], [2, 'Major event'], [3, 'Crossover arc']] },
    { key: 'publisher', label: 'Publisher', type: 'text', max: 120, placeholder: 'DC Comics' },
    { key: 'year', label: 'Year', type: 'number' },
    { key: 'description', label: 'Description', type: 'textarea', max: 8000, wide: true, rows: 6 },
    { key: 'sort_order', label: 'Order within its year', type: 'number', group: 'Timeline', help: 'Events in the same year are listed by this number, then by name.' },
    { key: 'cover_image', label: 'Timeline image link', type: 'text', max: 1000, group: 'Timeline', help: 'Picture for this event on the Timeline and the home page. When set, it replaces the cover chosen from your issues; leave empty to use that cover. Paste the image address (ending .jpg or .png), not a page link.' },
    { key: 'cover_issue_id', label: 'Timeline cover issue', type: 'cover', group: 'Timeline',
      describe: v => (base?.rows || []).find(r => r.id === v)?.label || null,
      image: v => { const b = (base?.rows || []).find(r => r.id === v)?.single?.book_id; return b ? `/api/books/${b}/thumbnail` : null; },
      empty: 'Chosen automatically (issue #1 of the main series, else the first issue you have).',
      help: 'Pick one of this event\'s issues you have: ⋯ › Use as Timeline cover on its row. A picked issue is used before the image link above.' },
  ],
  titleOf: d => d.name,
  summary: d => [d.name, [d.publisher, d.year].filter(Boolean).join(' · '), firstLine(d.description)].filter(Boolean).join(' — '),
  combinable: () => false,
  buildSave(rows, removed, absorbed, version, original) {
    const byId = new Map(original.map(r => [r.id, r]));
    const tiers = {}, notes = {}, reasons = {};
    for (const r of rows) if (r.type !== 'section') {
      const o = byId.get(r.id);
      if (o && o.tier !== r.tier) { tiers[r.id] = r.tier; if ((r.reason || '').trim()) reasons[r.id] = r.reason.trim(); }
      if (o && (o.note || '') !== (r.note || '')) notes[r.id] = r.note || null;
    }
    return { version, order: rows.map(r => (r.type === 'section' ? { section: r.label } : r.add ? { add: r.add, tier: r.tier, note: r.note || null } : r.id)),
      remove: removed.filter(r => r.type !== 'section').map(r => r.id), tiers, notes, reasons };
  },
  save: (id, body) => post(`/api/editor/event/${id}/save`, body),
  // A tier change asks why (saved as the issue's tier reason, behind Show reasoning).
  askTierReason: true,
  matchTarget: (id, row) => ({ url: `/api/events/${id}/issues/${row.id}/match`, method: 'PUT', body: bookId => ({ scanned_book_id: bookId, syncCv: true }) }),
  // "Show sources" (admin): what the event generator recorded — pages read, issues left out, and per
  // issue the sites that list it, why it was moved from release order, a release-position flag.
  loadSources: id => get(`/api/events/${id}/sources`),
  acquireFor: (id, r) => ({ kind: 'event', owner: id, issue: r.id }),
};

// ── Top Shelf runs: reorder (stored order is the reading order), remove, match ──
export const runAdapter = {
  kind: 'run', noun: 'run',
  tools: ['rematch', 'rebuild'],
  caps: { reorder: true, sections: false, groups: false, notes: false, rename: false, children: false, tiers: null, tierFor: () => false },
  async load(id) {
    const d = await get(`/api/editor/run/${id}`);
    return { title: d.title, subtitle: 'Top Shelf run', version: d.version, details: d.details, events: d.events || [], usage: d.usage,
      rows: d.rows.map(r => ({ key: 'i' + r.id, id: r.id, type: 'issue', label: issueLabel(r), note: '', owned: r.owned ? 1 : 0, total: 1,
        single: { id: r.id, owned: r.owned, book_id: r.scanned_book_id, series_name: r.series_name, issue_number: r.issue_number, volume_year: r.volume_year, cv_issue_id: r.cv_issue_id } })) };
  },
  combinable: () => false,
  draftNote: base => (base.details.status === 'pending' ? 'Pending: this run is not on Top Shelf yet. To publish it, open Details, set Status to Approved, then Save.' : null),
  fields: () => [
    ...homepageFields,
    { key: 'title', label: 'Title', type: 'text', max: 300 },
    { key: 'status', label: 'Status', type: 'select', options: [['pending', 'Pending'], ['approved', 'Approved (shown on Top Shelf)'], ['rejected', 'Blocked (never suggested again)']], help: 'Blocked runs stay off Top Shelf and the generator is told never to suggest them. Deleting a run instead lets it be suggested again.' },
    { key: 'admin_recommended', label: 'Recommended', type: 'switch', switchLabel: 'Feature in the Top Shelf spotlight' },
    { key: 'parent_series', label: 'Parent series', type: 'text', max: 200 },
    { key: 'issue_range_hint', label: 'Issue range', type: 'text', max: 120, placeholder: '#1–75', help: 'Shown under the title; Generate also uses it.' },
    { key: 'description', label: 'Description', type: 'textarea', max: 8000, wide: true, rows: 5 },
    { key: 'creators', label: 'Creators', type: 'creators', roles: ['writer', 'penciler', 'inker', 'artist', 'colorist', 'letterer'] },
    { key: 'categories', label: 'Categories', type: 'categories',
      options: [['adapted_to_screen', 'Adapted to screen', 'Which adaptation, e.g. Animated film 2011'], ['award_winning', 'Award winning', 'Which award, e.g. Eisner 1987'], ['critically_acclaimed', 'Critically acclaimed']] },
    { key: 'event_id', label: 'Linked Timeline event', type: 'event', wide: true, help: 'Top Shelf opens this Timeline event when the run is clicked.' },
    { key: 'cv_volume_id', label: 'Comic Vine volume ID', type: 'text', max: 40, group: 'Source', help: 'Used by Generate (Auto-resolve from CV) to fetch the issue list.' },
  ],
  deleteItem: id => delFetch(`/api/editor/run/${id}`),
  deleteLabel: 'Delete this run…',
  deleteWarning: (base, rows) => `Delete “${base.details.title}” and its ${plural(rows.length, 'issue')} for good? ${usageNote(base.usage, 'run')}`.trim(),
  afterDelete: () => '/canon',
  titleOf: d => d.title,
  summary: d => [d.title, [d.parent_series, d.issue_range_hint].filter(Boolean).join(' · '), firstLine(d.description)].filter(Boolean).join(' — '),
  buildSave: (rows, removed, absorbed, version) => ({ version, order: rows.map(r => (r.add ? { add: r.add } : r.id)), remove: removed.map(r => r.id) }),
  save: (id, body) => post(`/api/editor/run/${id}/save`, body),
  matchTarget: (id, row) => ({ url: `/api/canon/runs/${id}/issues/${row.id}/match`, method: 'PUT', body: bookId => ({ scanned_book_id: bookId, syncCv: true }) }),
  acquireFor: (id, r) => ({ kind: 'run', owner: id, issue: r.id }),
};

export const ADAPTERS = { list: listAdapter, event: eventAdapter, run: runAdapter };
export { issueLabel, childOf };
