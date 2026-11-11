// Remembers which page sits at each step of this tab's history, so a back
// button can tell where "back" would land (2026-10-26). React Router stores the
// step number (idx) in window.history.state; Back and Forward keep it accurate.
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const KEY = 'omnibus.navTrail';
let trail = (() => { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch { return {}; } })();
const step = () => (typeof window !== 'undefined' && typeof window.history.state?.idx === 'number' ? window.history.state.idx : null);

export function useNavTrail() {
  const location = useLocation();
  useEffect(() => {
    const idx = step();
    if (idx == null) return;
    trail[idx] = { path: location.pathname, search: location.search };
    try { sessionStorage.setItem(KEY, JSON.stringify(trail)); } catch {}
  }, [location]);
}

// The page one step back in this tab, if it was an Omnibus page.
export function previousPage() {
  const idx = step();
  return idx > 0 ? trail[idx - 1] || null : null;
}

// Plain names for the places a back button can lead.
const NAMES = [
  [/^\/$/, 'Home'],
  [/^\/series$/, 'Series'],
  [/^\/series\/[^/]+$/, 'Series'],
  [/^\/collections$/, 'Comic Boxes'],
  [/^\/my-boxes$/, 'My Comic Boxes'],
  [/^\/collections\/[^/]+$/, 'Comic Box'],
  [/^\/events$/, 'Timeline'],
  [/^\/events\/[^/]+$/, 'Event'],
  [/^\/canon\/run\/[^/]+$/, 'Top Shelf run'],
  [/^\/canon(\/[^/]+)?$/, 'Top Shelf'],
  [/^\/essentials$/, 'Essentials'],
  [/^\/essentials\/[^/]+$/, 'Essential'],
  [/^\/reading-lists$/, 'Reading Lists'],
  [/^\/reading-lists\/[^/]+$/, 'Reading List'],
  [/^\/search$/, 'Search'],
  [/^\/offline$/, 'Offline'],
  [/^\/downloads$/, 'Downloads'],
  [/^\/library$/, 'Library'],
];
export const pageName = path => (NAMES.find(([re]) => re.test(path)) || [null, 'Back'])[1];
