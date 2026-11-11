import { useEffect, useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// ─── Back returns to the same place on every page (2026-11-03) ──────────────
// Replaces the per-page useScrollRestore (timeline, Top Shelf, Comic Boxes,
// series shelves) and the browser's own restoring, which detail pages (reading
// lists, Essentials, events, series) relied on.
// Why: on Back the browser restored the old position at once, while the page was
// still loading and short; it stopped at the bottom of the short page (e.g. 111px)
// and that position was then saved over the real one (3000px).
// Now: the position is kept per history step (React Router's location.key, which
// survives a reload and the full-screen reader). On Back/Forward the page is
// scrolled there as soon as it is tall enough, waiting up to 6 s for data and
// covers; any scroll by the reader stops it. Opening a new page starts at the top.
const KEY = 'omnibus.scroll';
const WAIT_MS = 6000;

let positions = (() => { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch { return {}; } })();
let current = null;          // location.key of the page on screen
let currentPath = null;
let restoring = null;        // { cancel } while a Back restore is in progress
let saveTimer = null;

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const keys = Object.keys(positions);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete positions[k];
    try { sessionStorage.setItem(KEY, JSON.stringify(positions)); } catch { /* storage unavailable */ }
  }, 250);
}

function onScroll() {
  if (restoring || current == null) return;   // a restore in progress is not the reader's position
  positions[current] = Math.round(window.scrollY);
  persist();
}

function restore(y) {
  restoring?.cancel();
  let done = false, frame = null, observer = null, timer = null;
  // save=false when a navigation cancels it: the page on screen is no longer this one.
  const stop = (save = true) => {
    if (done) return;
    done = true;
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
    clearTimeout(timer);
    for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) window.removeEventListener(ev, byReader, true);
    restoring = null;
    if (save) onScroll();
  };
  const byReader = () => stop();
  const attempt = () => {
    frame = null;
    if (done) return;
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) <= 2) stop();
  };
  const schedule = () => { if (!done && !frame) frame = requestAnimationFrame(attempt); };
  restoring = { cancel: () => stop(false) };
  for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) window.addEventListener(ev, byReader, true);
  if (typeof ResizeObserver === 'function') { observer = new ResizeObserver(schedule); observer.observe(document.body); }
  timer = setTimeout(() => stop(), WAIT_MS);
  schedule();
}

export function useScrollMemory() {
  const location = useLocation();
  const navType = useNavigationType();

  useEffect(() => {
    try { if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'; } catch {}
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Layout effect: switch pages before the browser reports the scroll caused by
  // the new page's height, so that scroll is never saved under the old page.
  useLayoutEffect(() => {
    if (current === location.key) return;
    restoring?.cancel();
    const samePage = currentPath === location.pathname;   // only the query changed (filters, tabs)
    current = location.key; currentPath = location.pathname;
    const y = positions[current];
    if (navType === 'POP') { if (y > 0) restore(y); }
    else if (navType === 'PUSH' && !samePage) { window.scrollTo(0, 0); positions[current] = 0; }
  }, [location.key, location.pathname, navType]);
}

export function ScrollMemory() { useScrollMemory(); return null; }
