import { Loading } from '../components/StateMessage';
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { InfoTip, getToken } from '../App';
import { isComicOffline, getOfflinePage } from '../offlineStorage';
import AddToListModal from '../components/AddToListModal';
import AssistantBubble from '../components/AssistantBubble';
import { reportProblem } from '../components/ReportProblem';
import ComicReaderEndCard from '../components/ComicReaderEndCard';
import { validPath, preferenceKey, readPreference, eventAlternatives, pathEndMessage } from '../components/eventReadingPath';

// True while a reading-list dialog is open: keys, wheel and swipes go to the dialog, not the pages.
const dialogOpen = () => !!document.querySelector('.rl-modal-overlay');

// ─── ReaderPage ───────────────────────────────────────────────────
// Full-screen comic reader. Renders outside the Shell (no sidebar/topbar).
// Route: /read/:bookId
//
// Architecture note — stale closure prevention:
//   All event handlers (keyboard, click) read page/pageCount from refs,
//   NOT from useCallback dependency chains. This is the correct pattern for
//   values that change frequently. React state drives rendering; refs give
//   handlers fresh values without re-registering listeners on every change.
//
// Endpoints used:
//   GET /api/books/:id                 — book metadata (title, series_id, filename)
//   GET /api/books/:id/pages           — { count } total image pages
//   GET /api/books/:id/pages/:n        — stream page N (0-indexed), cached 24h
//   GET /api/read-progress/:bookId     — { page, completed }
//   PUT /api/read-progress/:bookId     — { page, completed } upsert
//
// Navigation:
//   Click left / right zone → previous / next page (swapped for right-to-left)
//   Click centre (tap on touch devices) → show / hide the overlay
//   Arrow keys ← →  (also A/D); Space / Page Down forward, Page Up back
//   Escape          → back to series
//   Fit Width / Original: the next-page action scrolls down first and turns
//   the page at the bottom; the wheel scrolls the page (2026-10-15).
//
// Fit modes (toggle via ⊞ button in chrome):
//   fit-height — default. Page fills viewport height, width auto.
//                Best for portrait comics on standard monitors.
//   fit-width  — Page fills viewport width, height scrollable.
//                Best for wide comics or narrow screens.
//   original   — Native resolution. May require scrolling.
//
// Overlay (2026-10-15): solid top bar (Back, series + issue, settings) and
//   bottom bar (thick progress bar with "Page N of M", Reading list, Ask,
//   Fullscreen). Hidden while reading; the progress bar lives only here.
//   Tap or drag the bar (mouse or finger); the page jumps on release.
//
// Preloading:
//   The next two pages and the previous one are fetched and decoded ahead.
//
// Read progress:
//   1.5s debounced PUT on every page turn.
//   Last page: immediate PUT with completed=true.

// Page-turn methods: the reader's choice, kept per device (browser storage).
// Defaults: zones on for mouse devices, off for touch (edge taps turned pages
// by accident, 2026-10-09); swipe, keyboard and wheel on.
// Only the choices that differ from the defaults are stored, so a device keeps
// following the defaults for everything it hasn't changed. (v2: earlier saves
// froze the zone setting; the key change resets it, 2026-10-15.)
const TURNS_KEY = 'omnibus.reader.turns.v2';
// Phones and tablets: a coarse pointer, no hover, a touch screen, or a phone-width
// screen (some phone browsers in "desktop site" mode report a fine pointer).
const mobileDevice = () => {
  const mq = q => !!window.matchMedia?.(q).matches;
  return mq('(pointer: coarse)') || mq('(hover: none)') || ((navigator.maxTouchPoints || 0) > 0 && window.innerWidth < 1024) || window.innerWidth < 768;
};
const defaultTurns = () => ({ zones: !mobileDevice(), zoneMode: 'sides', swipe: true, keyboard: true, wheel: true });
function loadTurns() {
  try { return { ...defaultTurns(), ...JSON.parse(localStorage.getItem(TURNS_KEY) || '{}') }; }
  catch { return defaultTurns(); }
}
function saveTurns(t) {
  const d = defaultTurns();
  const changed = Object.fromEntries(Object.entries(t).filter(([k, v]) => d[k] !== v));
  try { localStorage.setItem(TURNS_KEY, JSON.stringify(changed)); } catch {}
}
// "Batman #12" for an adjacent issue; falls back to its stored title.
const issueLine = (o) => o ? ((o.series_name ? `${o.series_name}${o.issue_number ? ` #${o.issue_number}` : ''}` : '') || o.title || '') : '';

const FIT_MODES  = ['fit-height', 'fit-width', 'original'];
const FIT_LABELS = { 'fit-height': 'Fit Height', 'fit-width': 'Fit Width', 'original': 'Original' };

export default function ReaderPage() {
  const { bookId } = useParams();
  const navigate   = useNavigate();
  const location   = useLocation();
  const eventId    = new URLSearchParams(location.search).get('eventId');
  const eventPath = validPath(new URLSearchParams(location.search).get('minTier') ?? readPreference(preferenceKey('event.' + eventId), 'all'));
  const canonRunId = new URLSearchParams(location.search).get('canonRunId');
  const restart = new URLSearchParams(location.search).get('restart') === '1';
  const listId     = new URLSearchParams(location.search).get('listId');
  // Query string that keeps the reading context (event / Top Shelf run / reading list) across issues.
  // The same context, sent with each progress save so Continue Reading on the home page
  // can offer the next issue in this event / run / list (readingContexts.js).
  const ctxSave = eventId ? { kind: 'event', id: eventId, minTier: eventPath } : canonRunId ? { kind: 'run', id: canonRunId } : listId ? { kind: 'list', id: listId } : null;
  const ctxSaveRef = useRef(ctxSave); ctxSaveRef.current = ctxSave;
  const ctxQs = eventId ? `?eventId=${encodeURIComponent(eventId)}&minTier=${eventPath}` : canonRunId ? `?canonRunId=${canonRunId}` : listId ? `?listId=${listId}` : '';
  const [listOpen, setListOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [asst, setAsst] = useState(null);   // Comic Book Guy status (enabled, name, avatar)
  useEffect(() => {
    if (!getToken()) return;
    fetch('/api/assistant/status').then(r => r.json()).then(setAsst).catch(() => setAsst(null));
  }, []);

  // ── State (drives rendering) ──────────────────────────────────
  const [book,         setBook]         = useState(null);
  const [pageCount,    setPageCount]    = useState(0);
  const [page,         setPage]         = useState(0);
  const [loading,      setLoading]      = useState(true);
  const [imgKey,       setImgKey]       = useState(0);
  const [imgLoading,   setImgLoading]   = useState(true);
  const [imgError,     setImgError]     = useState(false);
  const [showChrome,   setShowChrome]   = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [fitMode,      setFitMode]      = useState('fit-height');
  const [completed,    setCompleted]    = useState(false);
  const [scrubHover,   setScrubHover]   = useState(null);  // { page, pct } under the mouse
  const [scrubPreview, setScrubPreview] = useState(null);  // page under the finger/mouse while dragging
  const [slideDir,     setSlideDir]     = useState('forward'); // 'forward' | 'back'
  const [adjacent,     setAdjacent]     = useState({ prev: null, next: null, nextRecommended: null, nextEssential: null });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [nextToast,    setNextToast]    = useState(null);  // the issue being opened (brief flash)
  const [atEnd,        setAtEnd]        = useState(false); // end-of-issue card (after the last page)
  const [overviewOpen, setOverviewOpen] = useState(false); // page thumbnail grid
  const [turns,        setTurns]        = useState(loadTurns);
  const setTurn = (k, v) => setTurns(t => { const n = { ...t, [k]: v }; saveTurns(n); return n; });
  const isRtl = book?.series_type === 'manga'; // right-to-left reading for manga
  const scrubTrackRef  = useRef(null);
  const scrubActiveRef = useRef(false); // true during scrub — suppresses zone clicks

  // Touch / swipe refs
  const touchStartX   = useRef(null);
  const touchStartY   = useRef(null);
  const touchStartT   = useRef(0);
  const multiTouch    = useRef(false);   // a second finger touched (pinch/zoom) during this gesture
  const swipeDetected = useRef(false);

  // Touch-first devices (phones, tablets): pages turn by swipe only, and a tap
  // anywhere shows/hides the controls. Edge tap zones caused accidental page
  // turns (2026-10-09). Detected by the primary pointer, not screen width, so
  // tablets are included and touchscreen laptops keep the click zones.
  const [isTouch, setIsTouch] = useState(() => !!window.matchMedia?.('(pointer: coarse)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(pointer: coarse)');
    if (!mq) return;
    const h = () => setIsTouch(mq.matches);
    mq.addEventListener?.('change', h);
    return () => mq.removeEventListener?.('change', h);
  }, []);

  // ── Refs (fresh values for event handlers, no stale closures) ─
  const pageRef      = useRef(0);
  const pageCountRef = useRef(0);
  const completedRef = useRef(false);
  // Reaching the last page counts as reading the issue (achievements' reading log), once per opening.
  const finishedSentRef = useRef(false);
  useEffect(() => { finishedSentRef.current = false; }, [bookId]);
  // When this reading started on the first page: the finish then carries the seconds it took (hidden achievement, 2026-11-11).
  const openingRef = useRef({ at: 0, fromStart: false });
  const saveTimer    = useRef(null);
  const chromeTimer  = useRef(null);
  const adjacentRef  = useRef({ prev: null, next: null, nextRecommended: null, nextEssential: null });

  // Keep refs in sync with state
  useEffect(() => { pageRef.current      = page;      setImgRetry(0); setImgError(false); }, [page]);
  useEffect(() => { pageCountRef.current = pageCount; }, [pageCount]);
  useEffect(() => { completedRef.current = completed; }, [completed]);
  useEffect(() => { adjacentRef.current  = adjacent;  }, [adjacent]);
  const wrapRef       = useRef(null);   // the page area; scrolls in Fit Width / Original
  const fitModeRef    = useRef('fit-height');
  const isRtlRef      = useRef(false);
  const showChromeRef = useRef(true);
  const startAtEndRef = useRef(false);  // going back a page in a scrolling fit starts at its bottom
  const preloadRef    = useRef([]);     // preloaded Image objects, kept so the browser holds them
  useEffect(() => { fitModeRef.current = fitMode; }, [fitMode]);
  useEffect(() => { isRtlRef.current = isRtl; }, [isRtl]);
  useEffect(() => { showChromeRef.current = showChrome; }, [showChrome]);
  const atEndRef      = useRef(false);
  const overviewRef   = useRef(false);
  const turnsRef      = useRef(turns);
  const overviewGridRef = useRef(null);
  useEffect(() => { overviewRef.current = overviewOpen; }, [overviewOpen]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  // A new issue starts on its pages, not on the previous issue's end card.
  useEffect(() => {
    atEndRef.current = false; setAtEnd(false); setOverviewOpen(false); setNextToast(null);
  }, [bookId]);

  // ── Load book + pages + saved progress ───────────────────────
  // Offline-aware: if the comic is saved in OPFS and we can't reach
  // the server, get page count from the OPFS manifest instead so the
  // reader works without any network connection.
  useEffect(() => {
    if (!bookId) return;
    (async () => {
      try {
        // Check if offline-saved first — determines fallback strategy
        const savedOffline = await isComicOffline(bookId).catch(() => false);

        // Helper: fetch with a short timeout so offline hangs fail fast
        const fetchOrNull = (url, ms = 3000) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), ms);
          return fetch(url, { signal: ctrl.signal })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
            .finally(() => clearTimeout(t));
        };

        // Run all three fetches with timeout — they'll return null if offline
        const [bookRes, pagesRes, progressRes] = await Promise.all([
          fetchOrNull(`/api/books/${bookId}`),
          fetchOrNull(`/api/books/${bookId}/pages`),
          fetchOrNull(`/api/read-progress/${bookId}`),
        ]);

        if (bookRes) setBook(bookRes);

        // Page count: server response first, OPFS manifest fallback
        let count = pagesRes?.count || 0;
        if (count === 0 && savedOffline) {
          // Get count from OPFS manifest
          const { listOfflineComics } = await import('../offlineStorage');
          const comics = await listOfflineComics();
          const entry = comics.find(c => c.bookId === bookId);
          if (entry?.pageCount) count = entry.pageCount;
        }

        const savedPage = restart ? 0 : Math.min(progressRes?.page || 0, Math.max(0, count - 1));
        const isDone    = !!progressRes?.completed;
        setPageCount(count);
        pageCountRef.current = count;
        setPage(savedPage);
        pageRef.current = savedPage;
        openingRef.current = { at: Date.now(), fromStart: savedPage === 0 };
        setCompleted(isDone);
        completedRef.current = isDone;
      } catch (e) {
        console.error('Reader load error:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [bookId, restart]);

  // ── Load adjacent books ─────────────────────────────────────────
  const [adjacentLoading, setAdjacentLoading] = useState(false);
  useEffect(() => {
    if (!bookId) return;
    setAdjacent({ prev: null, next: null, nextRecommended: null, nextEssential: null });
    setAdjacentLoading(true);
    const url = eventId
      ? `/api/books/${bookId}/adjacent?eventId=${encodeURIComponent(eventId)}&minTier=${eventPath}`
      : canonRunId
      ? `/api/books/${bookId}/adjacent?canonRunId=${canonRunId}`
      : listId
      ? `/api/books/${bookId}/adjacent?listId=${listId}`
      : `/api/books/${bookId}/adjacent`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { setAdjacent(d); setAdjacentLoading(false); })
      .catch(() => { setAdjacentLoading(false); })
      .finally(() => clearTimeout(t));
  }, [bookId, eventId, eventPath, canonRunId, listId]);

  // ── Fullscreen sync ───────────────────────────────────────────
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // ── Save helpers ─────────────────────────────────────────────
  // A page save waits 1.5 s so fast page turns send one request. Leaving the
  // reader (or the issue) sends the waiting save at once: a late save landing
  // after "Clear progress" on the home page put the progress back (2026-10-15).
  const pendingSave = useRef(null);   // { bookId, page, completed }
  const sendSave = (b, p, isCompleted, keepalive = false, context = ctxSaveRef.current) => fetch(`/api/read-progress/${b}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: p, completed: isCompleted, context }),
    keepalive,
  }).catch(() => {});
  const flushSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const pending = pendingSave.current; pendingSave.current = null;
    if (pending) sendSave(pending.bookId, pending.page, pending.completed, true, pending.context);
  }, []);
  useEffect(() => {
    window.addEventListener('pagehide', flushSave);
    return () => { window.removeEventListener('pagehide', flushSave); flushSave(); };   // leaving this issue
  }, [bookId, flushSave]);

  const saveDebounced = useCallback((p, isCompleted) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pendingSave.current = { bookId, page: p, completed: isCompleted, context: ctxSaveRef.current };
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const pending = pendingSave.current; pendingSave.current = null;
      if (pending) sendSave(pending.bookId, pending.page, pending.completed, false, pending.context);
    }, 1500);
  }, [bookId]);

  const saveNow = useCallback((p, isCompleted, finished = false) => {
    pendingSave.current = null;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    fetch(`/api/read-progress/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: p, completed: isCompleted, context: ctxSaveRef.current,
        ...(finished ? { finished: true, tz: new Date().getTimezoneOffset(), pages: pageCountRef.current,
          ...(openingRef.current.fromStart ? { seconds: Math.round((Date.now() - openingRef.current.at) / 1000) } : {}) } : {}) }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (d?.achievements?.length) window.dispatchEvent(new CustomEvent('omnibus:achievements'));   // the toast, at once
    }).catch(() => {});
  }, [bookId]);

  // ── Core navigation — reads from refs, safe for any handler ──
  const goTo = useCallback((newPage) => {
    const count = pageCountRef.current;
    if (count === 0) return;

    // Past the last page → the end-of-issue card. Its buttons (or one more
    // "next") open the next issue in the reading context.
    if (newPage >= count) {
      if (!atEndRef.current) {
        atEndRef.current = true; setAtEnd(true);
        if (chromeTimer.current) clearTimeout(chromeTimer.current);
        setShowChrome(false); setShowSettings(false);
      }
      return;
    }
    // Past first page → navigate to prev issue
    if (newPage < 0 && adjacentRef.current.prev) {
      const prev = adjacentRef.current.prev;
      const params = ctxQs;
      navigate(`/read/${prev.id}${params}`, { replace: true });
      return;
    }

    const clamped = Math.max(0, Math.min(newPage, count - 1));
    const isLast  = clamped === count - 1;
    if (atEndRef.current) { atEndRef.current = false; setAtEnd(false); }

    // Set slide direction before updating page
    setSlideDir(clamped > pageRef.current ? 'forward' : 'back');

    // Update refs immediately so rapid clicks are always fresh
    pageRef.current = clamped;
    if (clamped === 0) openingRef.current = { at: Date.now(), fromStart: true };
    setPage(clamped);
    setImgError(false);
    setImgLoading(true);
    setImgKey(k => k + 1); // remount <img> so onLoad fires reliably

    if (isLast && (!completedRef.current || !finishedSentRef.current)) {
      completedRef.current = true;
      setCompleted(true);
      finishedSentRef.current = true;
      saveNow(clamped, true, true);
    } else {
      saveDebounced(clamped, completedRef.current);
    }
  }, [bookId, saveDebounced, saveNow, ctxQs, navigate]);

  // ── Preload: next two pages and the previous one, decoded ahead ──
  // (plus the next issue's first page near the end) so turns are instant.
  useEffect(() => {
    if (!bookId || !pageCount) return;
    const urls = [page + 1, page + 2, page - 1]
      .filter(n => n >= 0 && n < pageCount)
      .map(n => `/api/books/${bookId}/pages/${n}`);
    if (adjacent.next && page >= pageCount - 2) urls.push(`/api/books/${adjacent.next.id}/pages/0`);
    preloadRef.current = urls.map(u => {
      const im = new Image();
      im.decoding = 'async';
      im.src = u;
      im.decode?.().catch(() => {});
      return im;
    });
  }, [bookId, page, pageCount, adjacent.next]);

  // ── Scrolling fits (Fit Width, Original): scroll first, turn at the edge ──
  // Returns the page area when the current page is taller than the screen.
  const scrollable = () => {
    const w = wrapRef.current;
    if (!w || fitModeRef.current === 'fit-height') return null;
    return w.scrollHeight - w.clientHeight > 2 ? w : null;
  };
  // Scrolls most of a screen toward dir (+1 down, -1 up). False at the edge.
  const scrollStep = (dir) => {
    const w = scrollable();
    if (!w) return false;
    const max = w.scrollHeight - w.clientHeight;
    if (dir > 0 ? w.scrollTop >= max - 2 : w.scrollTop <= 2) return false;
    w.scrollBy({ top: dir * Math.round(w.clientHeight * 0.85), behavior: 'smooth' });
    return true;
  };
  // Open another issue, keeping the reading context (list / event / run).
  const openIssue = useCallback((b) => {
    if (!b) return;
    setNextToast(b);
    setTimeout(() => navigate(`/read/${b.id}${ctxQs}`, { replace: true }), 350);
  }, [ctxQs, navigate]);
  const closeEnd = useCallback(() => { atEndRef.current = false; setAtEnd(false); }, []);
  // Turn without scrolling first (swipes). From the end card: next issue / back to the last page.
  const turnForward = useCallback(() => {
    if (atEndRef.current) { openIssue(adjacentRef.current.next); return; }
    goTo(pageRef.current + 1);
  }, [goTo, openIssue]);
  const turnBack = useCallback(() => {
    if (atEndRef.current) { closeEnd(); return; }
    goTo(pageRef.current - 1);
  }, [goTo, closeEnd]);
  // Forward / backward in reading order (page index order); scrolling fits scroll first.
  const forward = useCallback(() => {
    if (!atEndRef.current && scrollStep(1)) return;
    turnForward();
  }, [turnForward]);
  const backward = useCallback(() => {
    if (atEndRef.current) { closeEnd(); return; }
    if (scrollStep(-1)) return;
    if (scrollable() && pageRef.current > 0) startAtEndRef.current = true;
    turnBack();
  }, [turnBack, closeEnd]);
  // Screen sides: right-to-left books swap them.
  const leftSide  = useCallback(() => (isRtlRef.current ? forward() : backward()), [forward, backward]);
  const rightSide = useCallback(() => (isRtlRef.current ? backward() : forward()), [forward, backward]);

  // A new page starts at the top (going back in a scrolling fit: at the bottom, set on load).
  useLayoutEffect(() => {
    const w = wrapRef.current;
    if (w) { w.scrollTop = 0; w.scrollLeft = 0; }
  }, [page, bookId, fitMode]);
  const onImgLoad = useCallback(() => {
    setImgLoading(false);
    if (startAtEndRef.current) {
      startAtEndRef.current = false;
      const w = wrapRef.current;
      if (w) w.scrollTop = w.scrollHeight;
    }
  }, []);

  const [imgRetry, setImgRetry] = useState(0);

  const handleImgError = useCallback(() => {
    setImgLoading(false);
    if (imgRetry < 2) {
      // Retry up to 2 times with a short delay — transient 7z/unrar failures
      setTimeout(() => { setImgRetry(r => r + 1); setImgLoading(true); }, 1200);
    } else {
      setImgError(true);
    }
  }, [imgRetry]);
  // The overlay stays out of the way of the end card and the page overview.
  const chromeVisible = showChrome && !atEnd && !overviewOpen;

  const showAndResetChrome = useCallback(() => {
    setShowChrome(true);
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(() => {
      setShowChrome(false);
      setShowSettings(false);
    }, 3500);
  }, []);

  useEffect(() => {
    showAndResetChrome();
    return () => { if (chromeTimer.current) clearTimeout(chromeTimer.current); };
  }, []); // mount only

  const hideChrome = useCallback(() => {
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    setShowChrome(false);
    setShowSettings(false);
  }, []);
  // Mouse: the overlay appears near the top or bottom edge, or over the bars.
  // Touch: a tap shows or hides it (clickCenter).
  const onRootPointerMove = useCallback((e) => {
    if (e.pointerType !== 'mouse') return;
    const nearEdge = e.clientY < 110 || e.clientY > window.innerHeight - 160;
    if (nearEdge || e.target?.closest?.('[data-chrome]')) showAndResetChrome();
  }, [showAndResetChrome]);

  // ── Responsive zone sizing ────────────────────────────────────
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (dialogOpen()) return;
      // Typing to Comic Book Guy must not turn pages; Escape closes his panel, not the reader.
      const tgt = e.target;
      if (tgt && (tgt.tagName === 'TEXTAREA' || tgt.tagName === 'INPUT' || tgt.isContentEditable)) return;
      if (e.key === 'Escape' && document.querySelector('.cbg-panel')) return;
      const k = e.key;
      if (overviewRef.current) { if (k === 'Escape') setOverviewOpen(false); return; }
      const pageKey = ['ArrowLeft', 'ArrowRight', 'a', 'd', ' ', 'PageDown', 'PageUp'].includes(k);
      if (pageKey && !turnsRef.current.keyboard) return;
      if (k === 'ArrowLeft'  || k === 'a') leftSide();
      else if (k === 'ArrowRight' || k === 'd') rightSide();
      else if ((k === ' ' && !e.shiftKey) || k === 'PageDown') { e.preventDefault(); forward(); }
      else if ((k === ' ' && e.shiftKey) || k === 'PageUp') { e.preventDefault(); backward(); }
      else if (k === 'ArrowDown' || k === 'ArrowUp') {
        const w = scrollable();
        if (w) { e.preventDefault(); w.scrollBy({ top: k === 'ArrowDown' ? 120 : -120 }); }
      }
      else if (k === 'Escape') { if (document.fullscreenElement) { document.exitFullscreen(); } else { navigate(-1); } }
      else if (k === 'f' || k === 'F') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leftSide, rightSide, forward, backward, navigate, toggleFullscreen]);

  // ── Mouse wheel handler (desktop page navigation) ─────────────
  // Fit Height: one page per 450 ms. Fit Width / Original: the wheel scrolls
  // the page; at the top or bottom a fresh scroll (not leftover trackpad
  // momentum) turns the page. Wheel down is always forward in reading order.
  useEffect(() => {
    let lastTurn = 0, lastEvt = 0;
    const onWheel = (e) => {
      if (scrubActiveRef.current || dialogOpen() || overviewRef.current) return;
      // Scrolling Comic Book Guy's chat scrolls the chat, not the pages.
      if (e.target?.closest?.('.cbg-panel')) return;
      if (e.target?.closest?.('[data-scroll-own]')) return;   // settings list, end card
      if (e.ctrlKey) return;                       // trackpad pinch = browser zoom
      e.preventDefault();
      const now = Date.now();
      const newGesture = now - lastEvt > 250;
      lastEvt = now;
      if (now - lastTurn < 450) return;            // let the new page settle
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const dy = e.deltaY * unit, dx = e.deltaX * unit;
      const w = scrollable();
      if (w) {
        if (Math.abs(dx) > Math.abs(dy) && w.scrollWidth - w.clientWidth > 2) { w.scrollLeft += dx; return; }
        const max = w.scrollHeight - w.clientHeight;
        const atEdge = dy > 0 ? w.scrollTop >= max - 2 : w.scrollTop <= 2;
        if (!atEdge) { w.scrollTop += dy; return; }
        if (!newGesture) return;
      }
      if (!turnsRef.current.wheel) return;         // wheel turning switched off (still scrolls)
      if (atEndRef.current && !newGesture) return;  // leftover momentum must not open the next issue
      const main = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      if (!main) return;
      lastTurn = now;
      if (main > 0) forward(); else backward();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [forward, backward]);

  // ── Zone click handlers — explicit divs, no offsetWidth math ────
  const clickPrev   = useCallback(() => { if (scrubActiveRef.current) return; leftSide(); }, [leftSide]);
  const clickNext   = useCallback(() => { if (scrubActiveRef.current) return; rightSide(); }, [rightSide]);
  const clickCenter = useCallback(() => {
    if (scrubActiveRef.current) return;
    if (showChromeRef.current) hideChrome(); else showAndResetChrome();
  }, [hideChrome, showAndResetChrome]);
  // One tap handler for the full-screen zone (touch, or "whole page") and for
  // the page area in scrolling fits on touch devices (so a finger can scroll).
  const tapAt = useCallback((e) => {
    if (swipeDetected.current || scrubActiveRef.current) return;
    const t = turnsRef.current;
    if (!t.zones) { clickCenter(); return; }
    if (t.zoneMode === 'whole') {
      if (e.clientY < window.innerHeight * 0.2) clickCenter(); else forward();
      return;
    }
    const x = e.clientX / window.innerWidth;
    const edge = window.innerWidth < 768 ? 0.25 : 0.2;
    if (x < edge) clickPrev(); else if (x > 1 - edge) clickNext(); else clickCenter();
  }, [clickCenter, clickPrev, clickNext, forward]);

  // Page overview: open at the current page.
  useEffect(() => {
    if (!overviewOpen) return;
    const el = overviewGridRef.current?.querySelector(`[data-page="${pageRef.current}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [overviewOpen]);

  // ── Progress bar — tap or drag (mouse, pen or finger) ──────
  // The page number follows the pointer while dragging; the page jumps on release.
  const pctToPage = useCallback((clientX) => {
    const track = scrubTrackRef.current;
    const count = pageCountRef.current;
    if (!track || count < 1) return { page: 0, pct: 0 };
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return { page: Math.round(pct * (count - 1)), pct };
  }, []);
  const scrubDown = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    scrubActiveRef.current = true;
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    setScrubHover(null);
    setScrubPreview(pctToPage(e.clientX).page);
  }, [pctToPage]);
  const scrubMove = useCallback((e) => {
    const hit = pctToPage(e.clientX);
    if (scrubActiveRef.current) setScrubPreview(hit.page);
    else if (e.pointerType === 'mouse') setScrubHover(hit);
  }, [pctToPage]);
  const scrubEnd = useCallback((e, commit) => {
    if (!scrubActiveRef.current) return;
    e.stopPropagation();
    const target = pctToPage(e.clientX).page;
    setScrubPreview(null);
    if (commit && target !== pageRef.current) goTo(target);
    setTimeout(() => { scrubActiveRef.current = false; }, 0);
    showAndResetChrome();
  }, [pctToPage, goTo, showAndResetChrome]);

  // ── Touch / swipe handlers ────────────────────────────────────
  // swipe left = next page, swipe right = prev page
  // Only triggers when horizontal delta > 50px AND more horizontal than vertical
  // Sets swipeDetected.current so zone onClick handlers know to skip
  const handleTouchStart = useCallback((e) => {
    // Touches on the overlay bars, progress bar or chat are not swipes.
    if (e.target?.closest?.('[data-chrome]')) { touchStartX.current = null; return; }
    if (e.touches.length > 1) { multiTouch.current = true; return; }   // second finger: pinch, not a swipe
    multiTouch.current    = false;
    touchStartX.current   = e.touches[0].clientX;
    touchStartY.current   = e.touches[0].clientY;
    touchStartT.current   = Date.now();
    swipeDetected.current = false;
  }, []);

  const handleTouchEnd = useCallback((e) => {
    if (touchStartX.current === null) return;
    if (!turnsRef.current.swipe) { touchStartX.current = null; return; }
    if (e.touches.length > 0) return;                 // wait until every finger is lifted
    const dx    = e.changedTouches[0].clientX - touchStartX.current;
    const dy    = e.changedTouches[0].clientY - touchStartY.current;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const quick = Date.now() - touchStartT.current < 700;
    // Pinch-zoomed in (panning a zoomed page): the visible part is narrower than the page.
    // Not visualViewport.scale (2026-11-06): Chrome on Android tablets opens sites as "desktop
    // site", which can report a scale above 1 with no pinch at all, so every swipe was ignored.
    const vv = window.visualViewport;
    const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
    const zoomed = !!vv && vv.width > 0 && vv.width < layoutWidth * 0.98;
    const w = wrapRef.current;
    const pansSideways = !!w && fitModeRef.current !== 'fit-height' && w.scrollWidth - w.clientWidth > 2;
    const wasMulti = multiTouch.current;
    touchStartX.current = null;
    multiTouch.current  = false;
    if (wasMulti || zoomed || pansSideways) return;
    // A deliberate swipe: mostly sideways, at least 15% of the screen width
    // (min 60px, at most 120px so a tablet doesn't need a long sweep, 2026-11-06),
    // and quick — slow drags and scroll wobbles don't count.
    if (absDx > Math.min(120, Math.max(60, window.innerWidth * 0.15)) && absDx > absDy * 1.5 && quick) {
      swipeDetected.current = true;
      // RTL: swipe left = back (higher page index = earlier in reading order)
      // LTR: swipe left = forward
      // Swipe left = forward (manga: back); swipe right = back (manga: forward).
      if (dx < 0) (isRtlRef.current ? turnBack : turnForward)();
      else        (isRtlRef.current ? turnForward : turnBack)();
      setTimeout(() => { swipeDetected.current = false; }, 350);
    }
  }, [turnForward, turnBack]);

  // ── Image sizing by fit mode ──────────────────────────────────
  const imgStyle = {
    'fit-height': { maxHeight: '100vh', maxWidth: '100%',  display: 'block', objectFit: 'contain' },
    'fit-width':  { width: '100%',      maxHeight: 'none', display: 'block' },
    'original':   { display: 'block' },
  }[fitMode];

  const wrapOverflow = fitMode === 'fit-height' ? 'hidden' : 'auto';
  const scrollFit = fitMode !== 'fit-height';
  const fsSupported = !!document.fullscreenEnabled;

  // ── Render ────────────────────────────────────────────────────
  if (loading) {
    return <div style={s.root}><Loading label="Opening comic…" /></div>;
  }

  const pageUrl  = `/api/books/${bookId}/pages/${page}`;
  const seriesId = book?.series_id;
  // Overlay heading: series name + issue number, then the issue's own title.
  const ci         = book?.comicinfo || {};
  const seriesName = (ci.series || book?.series_name || '').trim();
  const issueNum   = String(book?.issue_number || ci.number || '').trim();
  const fallback   = book?.title || book?.filename || '';
  const headline   = seriesName ? `${seriesName}${issueNum ? ` #${issueNum}` : ''}` : fallback;
  const rawSub     = (ci.title || '').trim();
  const issueTitle = rawSub && rawSub !== headline ? rawSub : '';
  // The solicit (ComicInfo Summary), entities and markup removed, for the end card's "About this issue".
  const solicit = (() => {
    const raw = String(ci.summary || '').trim();
    if (!raw) return '';
    const t = document.createElement('textarea');
    t.innerHTML = raw; let x = t.value.replace(/<[^>]+>/g, ' ');
    t.innerHTML = x; x = t.value.replace(/\s+/g, ' ').trim();
    return x.length >= 20 ? x : '';
  })();
  const title      = issueTitle ? `${headline} — ${issueTitle}` : headline;
  const goBack = () => {
    if (eventId) navigate(`/events/${eventId}?minTier=${eventPath}`);
    else if (canonRunId) navigate(`/canon/run/${canonRunId}`);
    else if (listId) navigate(`/reading-lists/${listId}`);
    else if (seriesId) navigate(`/series/${seriesId}`, { replace: true });
    else navigate(-1);
  };
  const shownPage = scrubPreview ?? page;
  const barPct = pageCount > 1 ? (shownPage / (pageCount - 1)) * 100 : 100;
  const barStyle = (edge) => ({
    opacity: chromeVisible ? 1 : 0,
    transform: chromeVisible ? 'none' : `translateY(${edge === 'top' ? '-100%' : '100%'})`,
    pointerEvents: chromeVisible ? 'auto' : 'none',
  });

  return (
    <>
    <style>{`
      @keyframes slideInForward {
        from { transform: translateX(6%); opacity: 0; }
        to   { transform: translateX(0);  opacity: 1; }
      }
      @keyframes slideInBack {
        from { transform: translateX(-6%); opacity: 0; }
        to   { transform: translateX(0);   opacity: 1; }
      }
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
        20%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        80%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
      }
      .page-enter-forward { animation: slideInForward 0.18s ease-out both; }
      .page-enter-back    { animation: slideInBack    0.18s ease-out both; }
      @keyframes readerSpinnerIn { from { opacity: 0; } to { opacity: 1; } }
      .reader-spinner { animation: readerSpinnerIn 0.2s ease 0.35s both; }
      .reader-bar-btn:hover { background: #2a2a2a !important; border-color: #555 !important; }
    `}</style>
    <div style={s.root} onPointerMove={onRootPointerMove}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >

      {/* ── Page image ── */}
      <div ref={wrapRef}
        style={{ ...s.imageWrap, overflowY: wrapOverflow, alignItems: fitMode === 'fit-height' ? 'center' : 'flex-start' }}
        onClick={isTouch && scrollFit ? tapAt : undefined}>
        {imgLoading && !imgError && <div className="reader-spinner" style={s.imgSpinner}>Loading page {page + 1}…</div>}
        {imgError
          ? <div style={s.imgError}>Failed to load page {page + 1}</div>
          : (
            <img
              key={`${imgKey}-${imgRetry}`}
              src={pageUrl}
              alt={`Page ${page + 1}`}
              className={slideDir === 'forward' ? 'page-enter-forward' : 'page-enter-back'}
              style={{ ...imgStyle, opacity: imgLoading ? 0 : 1 }}
              onLoad={onImgLoad}
              onError={handleImgError}
              draggable={false}
            />
          )
        }
      </div>

      {/* ── Tap/click zones ──
          Touch devices: one full-screen tap area that only shows/hides the
          controls; pages turn by swipe. Mouse: left/centre/right zones. */}
      {isTouch && scrollFit ? null : (turns.zones && turns.zoneMode === 'sides' && !isTouch) ? (<>
      <div style={{ ...s.zoneLeft, width: isMobile ? '10%' : '20%' }}
        onClick={() => { if (!swipeDetected.current) clickPrev(); }} title="Previous page">
        {!isMobile && (
          <div style={s.zoneArrowLeft}>‹</div>
        )}
      </div>
      <div style={{ ...s.zoneCenter, left: isMobile ? '10%' : '20%', width: isMobile ? '80%' : '60%' }}
        onClick={() => { if (!swipeDetected.current) clickCenter(); }} />
      <div style={{ ...s.zoneRight, width: isMobile ? '10%' : '20%' }}
        onClick={() => { if (!swipeDetected.current) clickNext(); }} title="Next page">
        {!isMobile && (
          <div style={s.zoneArrowRight}>›</div>
        )}
      </div>
      </>) : (
        // Touch devices, "whole page = next", or zones off: one full-screen area (tapAt decides).
        // In Fit Width / Original on touch the page area itself takes the tap, so a finger can scroll it.
        <div style={{ ...s.zoneCenter, left: 0, width: '100%', cursor: turns.zones && turns.zoneMode === 'whole' ? 'pointer' : 'default' }}
          onClick={tapAt} />
      )}

      {/* ── Top bar: Back · series + issue · settings ── */}
      <div data-chrome="1" style={{ ...s.topBar, ...barStyle('top') }} onPointerDown={showAndResetChrome}>
        <button className="reader-bar-btn" style={s.barBtn} onClick={goBack} title="Back (Esc)">← Back</button>
        <div style={s.titleBlock}>
          <div style={s.titleMain}>
            <span style={s.ellipsis} title={headline}>{headline}</span>
            {completed && <span style={s.doneCheck} title="Completed">✓</span>}
            {isRtl && <span style={s.rtlBadge} title="Right-to-left reading (manga): pages advance right to left.">RTL</span>}
          </div>
          {issueTitle && <div style={{ ...s.titleSub, ...s.ellipsis }} title={issueTitle}>{issueTitle}</div>}
        </div>
        <div style={{ position: 'relative' }} data-chrome="1">
          <button className="reader-bar-btn" style={s.barBtn} onClick={(e) => { e.stopPropagation(); setShowSettings(x => !x); }}
            aria-expanded={showSettings} title="Reader settings">
            ⚙{!isMobile && <span>Settings</span>}
          </button>
          {showSettings && (
            <div data-chrome="1" data-scroll-own="1" style={s.settingsDropdown}>
              <div style={s.settingsHeading}>Fit mode</div>
              {[
                ['fit-height', 'Fit Height', 'Whole page on screen.'],
                ['fit-width', 'Fit Width', 'Page fills the width; scroll down, then turn.'],
                ['original', 'Original', 'Actual pixel size; scroll to move around.'],
              ].map(([m, label, desc]) => (
                <button
                  key={m}
                  data-chrome="1"
                  style={{ ...s.settingsOpt, ...(fitMode === m ? s.settingsOptActive : {}) }}
                  onClick={(e) => { e.stopPropagation(); setFitMode(m); setShowSettings(false); }}
                >
                  <span style={{ fontWeight: 600 }}>{fitMode === m ? '● ' : ''}{label}</span>
                  <span style={s.settingsDesc}>{desc}</span>
                </button>
              ))}
              <div style={{ ...s.settingsHeading, marginTop: 10, borderTop: '1px solid color-mix(in srgb, var(--om-base) 90%, white)', paddingTop: 10 }}>Turn pages with</div>
              {[
                ['zones', isTouch ? 'Tap zones' : 'Click zones',
                  turns.zones ? (turns.zoneMode === 'whole' ? 'Tap anywhere for the next page; tap the top for the menu.' : 'Left and right edges turn the page; the middle shows the menu.')
                              : 'A tap only shows or hides the menu.'],
                ...(isTouch ? [['swipe', 'Swipe', 'Swipe sideways to turn the page.']] : []),
                ['keyboard', 'Keyboard', '← → or A / D, Space, Page Up / Down.'],
                ...(!isTouch ? [['wheel', 'Mouse wheel', 'Turns the page (Fit Width scrolls first).']] : []),
              ].map(([k, label, desc]) => (
                <div key={k}>
                  <button data-chrome="1" role="switch" aria-checked={!!turns[k]} style={s.toggleRow}
                    onClick={(e) => { e.stopPropagation(); setTurn(k, !turns[k]); }}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{label}</span>
                      <span style={s.settingsDesc}>{desc}</span>
                    </span>
                    <span style={{ ...s.switchTrack, ...(turns[k] ? s.switchOn : {}) }}>
                      <span style={{ ...s.switchKnob, ...(turns[k] ? { left: 20 } : {}) }} />
                    </span>
                  </button>
                  {k === 'zones' && turns.zones && (
                    <div style={s.segRow}>
                      {[['sides', 'Sides'], ['whole', 'Whole page = next']].map(([m, l]) => (
                        <button key={m} data-chrome="1" style={{ ...s.segBtn, ...(turns.zoneMode === m ? s.segOn : {}) }}
                          onClick={(e) => { e.stopPropagation(); setTurn('zoneMode', m); }}>{l}</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <button data-chrome="1" style={{ ...s.settingsOpt, marginTop: 10, borderTop: '1px solid color-mix(in srgb, var(--om-base) 90%, white)', paddingTop: 10 }}
                onClick={(e) => { e.stopPropagation(); setShowSettings(false); reportProblem({ type: 'book', id: bookId, label: headline, kinds: ['file', 'metadata', 'other'] }); }}>
                <span style={{ fontWeight: 600 }}>⚑ Report a problem</span>
                <span style={s.settingsDesc}>Bad pages, a scan problem or wrong details on this issue.</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Opening the next issue ── */}
      {nextToast && (
        <div style={s.nextToast}>
          <span style={{ color: 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))', marginRight: 6 }}>Next →</span>
          {issueLine(nextToast)}
        </div>
      )}

      {/* ── End-of-issue card (after the last page) ──
          Follows the reading context: reading list, Timeline event, Top Shelf run, else series. */}
      {atEnd && !nextToast && (() => {
        const ctx = adjacent.context;
        const { next } = adjacent;
        const kind = ctx?.kind || 'series';
        const backLink = kind === 'list' ? `/reading-lists/${ctx.id}` : kind === 'event' ? `/events/${ctx.id}?minTier=${eventPath}` : kind === 'run' ? `/canon/run/${ctx.id}` : null;
        const alternatives = kind === 'event' ? eventAlternatives(adjacent, eventPath) : [];
        const endMessage = kind === 'event' ? pathEndMessage(ctx, completed) : null;
        return (
          <div style={s.endWrap} data-scroll-own="1" onClick={(e) => e.stopPropagation()}>
            <ComicReaderEndCard completed={completed} headline={headline} issueTitle={issueTitle} solicit={solicit}
              bookId={bookId} seriesName={seriesName} context={ctx} next={next}
              alternatives={alternatives} endMessage={endMessage}
              loading={adjacentLoading} onRead={openIssue} onLastPage={closeEnd}
              onBackContext={() => navigate(backLink)}
              onBackSeries={seriesId ? () => navigate(`/series/${seriesId}`, { replace: true }) : null}
              assistant={asst} onDiscuss={() => setAskOpen(true)} />
          </div>
        );
      })()}

      {/* ── Page overview ── */}
      {overviewOpen && (
        <div data-chrome="1" style={s.overview} onClick={(e) => e.stopPropagation()}>
          <div style={s.overviewHead}>
            <span style={{ ...s.ellipsis, color: 'var(--om-text)', fontWeight: 700, fontSize: 16 }}>Pages · {headline}</span>
            <button className="reader-bar-btn" style={s.barBtn} onClick={() => setOverviewOpen(false)}>✕ Close</button>
          </div>
          <div ref={overviewGridRef} style={{ ...s.overviewGrid, gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? 96 : 140}px, 1fr))` }}>
            {Array.from({ length: pageCount }, (_, n) => (
              <button key={n} data-page={n} style={{ ...s.thumbBtn, ...(n === page ? s.thumbCurrent : {}) }}
                onClick={() => { setOverviewOpen(false); goTo(n); }} title={`Page ${n + 1}`}>
                <img src={`/api/books/${bookId}/page-thumbs/${n}`} loading="lazy" alt="" style={s.thumbImg} draggable={false} />
                <span style={{ ...s.thumbNum, ...(n === page ? { background: 'var(--td-yellow)', color: '#000' } : {}) }}>{n + 1}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Bottom bar: progress bar + labeled buttons (overlay only) ── */}
      {pageCount > 0 && (
        <div data-chrome="1" style={{ ...s.bottomBar, ...barStyle('bottom') }} onPointerDown={showAndResetChrome}>
          <div style={s.scrubRow}>
            <span style={s.pageLabel}>Page {shownPage + 1} of {pageCount}</span>
            <div
              ref={scrubTrackRef}
              data-chrome="1"
              style={{ ...s.scrubTrack, cursor: scrubPreview != null ? 'grabbing' : 'pointer' }}
              onPointerDown={scrubDown}
              onPointerMove={scrubMove}
              onPointerUp={(e) => scrubEnd(e, true)}
              onPointerCancel={(e) => scrubEnd(e, false)}
              onPointerLeave={() => setScrubHover(null)}
              onClick={(e) => e.stopPropagation()}
              role="slider" aria-label="Page" aria-valuemin={1} aria-valuemax={pageCount} aria-valuenow={shownPage + 1}
            >
              <div style={s.scrubRail}><div style={{ ...s.scrubFill, width: `${barPct}%` }} /></div>
              <div style={{ ...s.scrubThumb, left: `${barPct}%`, ...(scrubPreview != null ? { width: 28, height: 28 } : {}) }} />
              {scrubPreview != null
                ? <div style={{ ...s.scrubTip, left: `${barPct}%` }}>Page {scrubPreview + 1}</div>
                : scrubHover && <div style={{ ...s.scrubTip, left: `${scrubHover.pct * 100}%` }}>Page {scrubHover.page + 1}</div>}
            </div>
          </div>
          <div style={s.btnRow}>
            <button className="reader-bar-btn" style={s.bigBtn}
              onClick={(e) => { e.stopPropagation(); setShowSettings(false); setOverviewOpen(true); }}
              title="All pages at a glance">
              ▦ Pages
            </button>
            <button className="reader-bar-btn" style={s.bigBtn} disabled={!book}
              onClick={(e) => { e.stopPropagation(); setShowSettings(false); setListOpen(true); }}
              title="Add this issue to one of your reading orders">
              ＋ {isMobile ? 'Box' : 'Add to a box'}
            </button>
            {asst?.enabled && (
              <button className="reader-bar-btn" style={{ ...s.bigBtn, color: 'var(--td-yellow)', borderColor: 'color-mix(in srgb, var(--td-yellow) 50%, transparent)' }}
                onClick={(e) => { e.stopPropagation(); setAskOpen(o => !o); }}
                title={`Ask ${asst.name || 'Comic Book Guy'} about this issue`}>
                {asst.avatar_url && (
                  // Same face crop as the chat panel header (the avatar is a full-body image).
                  <span style={{ flexShrink: 0, width: 28, height: 28, borderRadius: '50%', overflow: 'hidden', background: 'var(--td-yellow)', border: '2px solid #000' }}>
                    <img src={asst.avatar_url} alt="" style={{ width: '165%', height: 'auto', margin: '4% 0 0 -32.5%', display: 'block' }} />
                  </span>
                )}
                {isMobile ? 'Ask' : `Ask ${asst.name || 'Comic Book Guy'}`}
              </button>
            )}
            {fsSupported && (
              <button className="reader-bar-btn" style={s.bigBtn} onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} title="Fullscreen (F)">
                {isFullscreen ? '⤡ Exit fullscreen' : '⤢ Fullscreen'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
    {listOpen && book && (
      <AddToListModal target={{ kind: 'book', bookId: book.id, label: title }} onClose={() => setListOpen(false)} />
    )}
    {book && getToken() && (
      <AssistantBubble reader={{ bookId: book.id, page, pageCount, listId, eventId, runId: canonRunId, title, atEnd, open: askOpen, onOpenChange: setAskOpen }} />
    )}
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────
const s = {
  root: {
    position: 'fixed', inset: 0,
    background: '#0a0a0a',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
    userSelect: 'none',
  },
  loadingText: { color: 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', fontSize: 13 },
  imageWrap: {
    position: 'absolute', inset: 0,
    display: 'flex', justifyContent: 'center',
    zIndex: 1,
  },
  imgSpinner: {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%,-50%)',
    color: 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', fontSize: 13,
  },
  imgError: {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%,-50%)',
    color: '#cc5050', fontSize: 13,
  },
  // Click zones — pointer-events ON, cover left/center/right thirds
  // Width is controlled dynamically via isMobile — styles here are base/fallback only
  zoneLeft:   { position: 'absolute', left: 0,    top: 0, width: '20%', height: '100%', zIndex: 3, cursor: 'pointer', WebkitTapHighlightColor: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
  zoneCenter: { position: 'absolute', left: '20%', top: 0, width: '60%', height: '100%', zIndex: 3, cursor: 'default',  WebkitTapHighlightColor: 'transparent' },
  zoneRight:  { position: 'absolute', right: 0,   top: 0, width: '20%', height: '100%', zIndex: 3, cursor: 'pointer', WebkitTapHighlightColor: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'flex-start' },
  zoneArrowLeft:  { fontSize: 48, color: 'rgba(255,255,255,0.12)', lineHeight: 1, paddingRight: 12, userSelect: 'none', pointerEvents: 'none', transition: 'color 0.2s' },
  zoneArrowRight: { fontSize: 48, color: 'rgba(255,255,255,0.12)', lineHeight: 1, paddingLeft: 12, userSelect: 'none', pointerEvents: 'none', transition: 'color 0.2s' },
  // Overlay bars
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 14px', paddingTop: 'max(10px, env(safe-area-inset-top))',
    background: 'rgba(14,14,14,0.97)', borderBottom: '1px solid color-mix(in srgb, var(--om-base) 90%, white)',
    boxShadow: '0 4px 18px rgba(0,0,0,0.6)',
    transition: 'opacity 0.2s ease, transform 0.2s ease',
  },
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20,
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '12px 16px', paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
    background: 'rgba(14,14,14,0.97)', borderTop: '1px solid color-mix(in srgb, var(--om-base) 90%, white)',
    boxShadow: '0 -4px 18px rgba(0,0,0,0.6)',
    transition: 'opacity 0.2s ease, transform 0.2s ease',
  },
  barBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    minHeight: 42, padding: '0 14px', flexShrink: 0, whiteSpace: 'nowrap',
    background: 'color-mix(in srgb, var(--om-base) 95%, white)', border: '1px solid color-mix(in srgb, var(--om-base) 85%, white)', borderRadius: 8,
    color: 'var(--om-text)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  bigBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: 44, padding: '0 12px', flex: '1 1 0', minWidth: 0, maxWidth: 260,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    background: 'color-mix(in srgb, var(--om-base) 95%, white)', border: '1px solid color-mix(in srgb, var(--om-base) 85%, white)', borderRadius: 8,
    color: 'var(--om-text)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  btnRow: { display: 'flex', gap: 10, justifyContent: 'center' },
  titleBlock: { flex: 1, minWidth: 0, textAlign: 'center' },
  titleMain: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    color: 'var(--om-text)', fontSize: 16, fontWeight: 700, minWidth: 0,
  },
  titleSub: { color: 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', fontSize: 13, marginTop: 2 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  doneCheck: { color: '#4caa60', fontWeight: 700, flexShrink: 0 },
  rtlBadge: {
    flexShrink: 0, fontSize: 10, padding: '1px 5px', borderRadius: 3, fontWeight: 700, letterSpacing: '0.05em',
    background: 'rgba(64,170,128,0.2)', color: '#40aa80', border: '1px solid rgba(64,170,128,0.3)',
  },
  settingsDropdown: {
    position: 'absolute', top: 'calc(100% + 8px)', right: 0,
    background: 'var(--om-base)', border: '1px solid color-mix(in srgb, var(--om-base) 85%, white)',
    borderRadius: 8, padding: '8px 0',
    minWidth: 260, maxWidth: 'calc(100vw - 24px)', zIndex: 30,
    maxHeight: 'calc(100dvh - 90px)', overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
  },
  settingsHeading: {
    color: 'color-mix(in srgb, var(--om-text) 50%, var(--om-base))', fontSize: 11, fontWeight: 700,
    letterSpacing: '0.08em', textTransform: 'uppercase',
    padding: '2px 14px 6px',
  },
  settingsOpt: {
    display: 'flex', flexDirection: 'column', gap: 2, width: '100%',
    background: 'none', border: 'none',
    color: 'color-mix(in srgb, var(--om-text) 85%, var(--om-base))', cursor: 'pointer',
    fontSize: 14, padding: '9px 14px', textAlign: 'left',
  },
  settingsOptActive: { color: 'var(--td-yellow)', background: 'color-mix(in srgb, var(--td-yellow) 10%, transparent)' },
  settingsDesc: { color: 'color-mix(in srgb, var(--om-text) 50%, var(--om-base))', fontSize: 12, fontWeight: 400 },
  toggleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%',
    background: 'none', border: 'none', color: 'color-mix(in srgb, var(--om-text) 85%, var(--om-base))', cursor: 'pointer',
    fontSize: 14, padding: '8px 14px', textAlign: 'left',
  },
  switchTrack: { position: 'relative', flexShrink: 0, width: 40, height: 22, borderRadius: 11, background: 'color-mix(in srgb, var(--om-base) 85%, white)', transition: 'background 0.15s' },
  switchOn:    { background: 'var(--td-yellow)' },
  switchKnob:  { position: 'absolute', top: 2, left: 2, width: 18, height: 18, borderRadius: '50%', background: 'var(--om-text)', transition: 'left 0.15s' },
  segRow: { display: 'flex', gap: 6, padding: '0 14px 8px' },
  segBtn: { flex: 1, background: 'color-mix(in srgb, var(--om-base) 95%, white)', border: '1px solid color-mix(in srgb, var(--om-base) 85%, white)', borderRadius: 6, color: 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', fontSize: 12, fontWeight: 600, padding: '6px 4px', cursor: 'pointer' },
  segOn:  { color: '#000', background: 'var(--td-yellow)', borderColor: 'var(--td-yellow)' },
  // End-of-issue card
  endWrap: {
    position: 'absolute', inset: 0, zIndex: 25, overflowY: 'auto',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px 16px', background: 'rgba(8,8,8,0.94)',
  },
  overview: {
    position: 'absolute', inset: 0, zIndex: 40, background: '#0b0b0b',
    display: 'flex', flexDirection: 'column',
  },
  overviewHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '10px 14px', paddingTop: 'max(10px, env(safe-area-inset-top))',
    background: 'rgba(14,14,14,0.97)', borderBottom: '1px solid color-mix(in srgb, var(--om-base) 90%, white)', flexShrink: 0,
  },
  overviewGrid: {
    flex: 1, overflowY: 'auto', display: 'grid', gap: 12, alignContent: 'start',
    padding: '14px', paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
  },
  thumbBtn: {
    position: 'relative', background: 'var(--om-base)', border: '2px solid transparent', borderRadius: 6,
    padding: 0, cursor: 'pointer', overflow: 'hidden',
  },
  thumbCurrent: { borderColor: 'var(--td-yellow)' },
  thumbImg: { display: 'block', width: '100%', aspectRatio: '2 / 3', objectFit: 'contain', background: 'color-mix(in srgb, var(--om-base) 95%, white)' },
  thumbNum: {
    position: 'absolute', bottom: 4, left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.8)', color: 'var(--om-text)', fontSize: 12, fontWeight: 700,
    padding: '1px 8px', borderRadius: 10,
  },
  // Progress bar (bottom bar)
  scrubRow: { display: 'flex', alignItems: 'center', gap: 16 },
  pageLabel: {
    color: 'var(--om-text)', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
    minWidth: 118, fontVariantNumeric: 'tabular-nums',
  },
  scrubTrack: {
    position: 'relative', flex: 1, height: 40,
    display: 'flex', alignItems: 'center',
    touchAction: 'none',
  },
  scrubRail: {
    position: 'relative', width: '100%', height: 8, borderRadius: 4,
    background: 'color-mix(in srgb, var(--om-base) 85%, white)', overflow: 'hidden', pointerEvents: 'none',
  },
  scrubFill: { position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--td-yellow)' },
  scrubThumb: {
    position: 'absolute', top: '50%', width: 22, height: 22, borderRadius: '50%',
    background: 'var(--td-yellow)', border: '3px solid color-mix(in srgb, var(--om-base) 75%, black)', boxShadow: '0 0 0 1px var(--td-yellow)',
    transform: 'translate(-50%, -50%)', pointerEvents: 'none',
  },
  scrubTip: {
    position: 'absolute', bottom: 'calc(100% + 4px)', transform: 'translateX(-50%)',
    background: 'var(--td-yellow)', color: '#000', fontWeight: 700, fontSize: 13,
    padding: '4px 10px', borderRadius: 6, pointerEvents: 'none', whiteSpace: 'nowrap',
  },
  nextToast: {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'rgba(0,0,0,0.85)', border: '1px solid color-mix(in srgb, var(--om-base) 85%, white)',
    borderRadius: 8, color: 'var(--td-yellow)',
    fontSize: 14, padding: '14px 24px',
    zIndex: 50, pointerEvents: 'none',
    animation: 'fadeInOut 0.6s ease both',
    whiteSpace: 'nowrap', maxWidth: '80vw',
    overflow: 'hidden', textOverflow: 'ellipsis',
  },
};

