import { readingPalettes, paletteTokens } from '../themes/readingPalettes';
export function normalizePublisher(value) {
  const s = String(value || '').trim();
  if (/^dc(?: comics)?$/i.test(s)) return 'DC';
  if (/^marvel(?: comics)?$/i.test(s)) return 'Marvel';
  return s;
}
export function publishersFor(list, libraries = []) {
  const raw = list.catalog?.publishers || [];
  if (raw.length) return [...new Set(raw.map(normalizePublisher).filter(Boolean))];
  // Library names are only a fallback for the two unambiguous publisher libraries.
  return [...new Set(libraries.filter(l => (list.catalog?.library_ids || []).includes(String(l.id)))
    .map(l => /^(dc|marvel)(?: comics)?$/i.test(l.name.trim()) ? normalizePublisher(l.name) : '').filter(Boolean))];
}
export function selectLists(lists, { library, libraries = [], query = '', sort = 'alpha' } = {}) {
  const term = query.trim().toLocaleLowerCase();
  const filtered = lists.filter(l => {
    const ids = l.catalog?.library_ids || [];
    const explicitLibraries = l.catalog?.explicit?.library_ids?.length;
    const libraryPublisher = library && /^(dc|marvel)(?: comics)?$/i.test(library.name.trim()) ? normalizePublisher(library.name) : null;
    const inLibrary = !library || ids.includes(String(library.id)) || (!explicitLibraries && libraryPublisher && publishersFor(l, libraries).includes(libraryPublisher));
    return inLibrary && (!term || [l.name, l.description, l.catalog?.group, ...collectionsFor(l, libraries), ...publishersFor(l, libraries)].join(' ').toLocaleLowerCase().includes(term));
  });
  const alpha = (a,b) => a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'});
  const active = l => l.progress?.read > 0 && l.progress.read < l.progress.total ? 1 : 0;
  return filtered.sort((a,b) => (sort === 'recent' ? dateValue(b.created_at) - dateValue(a.created_at) : sort === 'progress' ? active(b) - active(a) : 0) || alpha(a,b));
}
function dateValue(s) { return Date.parse(s && !s.includes('T') ? s.replace(' ', 'T') + 'Z' : s) || 0; }
export function isNew(list, now = Date.now()) { const age = now - dateValue(list.created_at); return age >= 0 && age < 14 * 86400000; }
export function featuredList(lists, now = Date.now()) {
  const chosen = lists.filter(l => l.catalog?.featured), pool = (chosen.length ? chosen : lists).slice().sort((a,b) => String(a.id).localeCompare(String(b.id), undefined, {numeric:true}));
  return pool.length ? pool[Math.floor(now / 86400000) % pool.length] : null;
}
export function publisherGroups(lists, libraries) {
  const groups = new Map();
  for (const list of lists) for (const publisher of publishersFor(list, libraries).length ? publishersFor(list, libraries) : ['Unassigned']) {
    if (!groups.has(publisher)) groups.set(publisher, []);
    groups.get(publisher).push(list);
  }
  const rank = p => p === 'DC' ? 0 : p === 'Marvel' ? 1 : p === 'Unassigned' ? 3 : 2;
  return [...groups].sort(([a],[b]) => rank(a) - rank(b) || a.localeCompare(b));
}

// Sections on the Reading Lists and Essentials pages. Nothing is grouped automatically:
// a list goes under its publisher(s) only when "Group by publisher" is on, under its
// custom group when it has one, and otherwise in the closing "other" section.
// Order: publishers (DC, Marvel, then A–Z), custom groups A–Z, then other.
export const OTHER_SECTION = 'other';
export function sectionKeyFor(kind, name) { return kind === 'group' ? 'group:' + name.toLocaleLowerCase() : kind === 'other' ? OTHER_SECTION : name; }
export function catalogSections(lists, libraries) {
  const sections = new Map();
  const add = (kind, name, list) => {
    const key = sectionKeyFor(kind, name);
    if (!sections.has(key)) sections.set(key, { key, kind, name, items: [] });
    sections.get(key).items.push(list);
  };
  for (const list of lists) {
    const publishers = list.catalog?.by_publisher ? publishersFor(list, libraries) : [];
    const group = String(list.catalog?.group || '').trim();
    if (publishers.length) publishers.forEach(p => add('publisher', p, list));
    else if (group) add('group', group, list);
    else add('other', '', list);
  }
  const rank = s => s.kind === 'publisher' ? (s.name === 'DC' ? 0 : s.name === 'Marvel' ? 1 : 2) : s.kind === 'group' ? 3 : 4;
  return [...sections.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function collectionsFor(list, libraries = []) {
  if (Array.isArray(list.catalog?.collections)) return list.catalog.collections;
  if (list.catalog?.by_publisher && publishersFor(list, libraries).length) return publishersFor(list, libraries);
  return list.catalog?.group?.trim() ? [list.catalog.group.trim()] : [];
}
export function essentialSections(lists, libraries = [], registry = [], includeEmpty = false) {
  if (registry.length) {
    const assigned = new Set();
    const sections = registry.map(c => {
      const items = lists.filter(l => (l.catalog?.collection_ids || []).includes(c.id) || collectionsFor(l,libraries).some(n => n.toLowerCase() === c.name.toLowerCase()));
      items.forEach(l => assigned.add(l.id));
      const pinned = c.pinned || [];
      items.sort((a,b) => {const x=pinned.indexOf(String(a.id)),y=pinned.indexOf(String(b.id));return (x<0?Infinity:x)-(y<0?Infinity:y) || a.name.localeCompare(b.name);});
      return {key:c.id,name:c.name,kind:"group",items,record:c};
    }).filter(s=>includeEmpty || s.items.length);
    const remaining=lists.filter(l=>!assigned.has(l.id));
    if(remaining.length) sections.push({key:"other",name:"",kind:"other",items:remaining});
    return sections;
  }
  const sections = new Map();
  const legacyPublishers = new Map(lists.filter(l => l.catalog?.by_publisher).flatMap(l => publishersFor(l, libraries)).map(p => [p.toLowerCase(), p]));
  for (const list of lists) {
    const names = collectionsFor(list, libraries);
    for (const name of names.length ? names : ['']) {
      const publisher = legacyPublishers.get(name.toLowerCase()) || (/^(DC|Marvel)$/i.test(name) ? normalizePublisher(name) : null);
      const key = !name ? 'other' : publisher || sectionKeyFor('group', name);
      if (!sections.has(key)) sections.set(key, {key, name:publisher || name, kind:publisher ? 'publisher' : name ? 'group' : 'other', items:[]});
      if (!sections.get(key).items.some(x => x.id === list.id)) sections.get(key).items.push(list);
    }
  }
  return [...sections.values()].sort((a,b) => (a.key === 'other') - (b.key === 'other') || a.name.localeCompare(b.name));
}

// A publisher prefix is explicit branding intent; membership alone never guesses it.
export function collectionBranding(name, kind, publishers = [], saved = {}) {
  const prefix = String(name || '').split(':')[0].trim();
  const candidates = [...new Set(['DC', 'Marvel', ...publishers].map(normalizePublisher))];
  const automatic = kind === 'publisher' ? name : candidates.find(p => p.toLowerCase() === normalizePublisher(prefix).toLowerCase()) || '';
  const publisher = typeof saved.publisher === 'string' ? saved.publisher : automatic;
  const style = {};
  const character = readingPalettes.find(p => p.name === saved.character);
  if (character) {const tokens=paletteTokens(character);style["--publisher-fill"]=tokens["--rl-theme-banner"];style["--publisher-accent"]=tokens["--rl-theme-accent"];style["--publisher-text"]=tokens["--rl-theme-banner-accent"];}
  if (/^#[0-9a-f]{6}$/i.test(saved.fill || '')) style['--publisher-fill'] = saved.fill;
  if (/^#[0-9a-f]{6}$/i.test(saved.accent || '')) { style['--publisher-accent'] = saved.accent; style['--publisher-text'] = saved.accent; }
  return {publisher:character ? "" : publisher, character:character?.name, style};
}
