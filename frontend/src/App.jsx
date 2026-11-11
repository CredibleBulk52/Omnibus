import { HomeIcon, CollectionsIcon, MyBoxesIcon, PullBoxIcon, SeriesIcon, CanonIcon, EssentialsIcon, EventsIcon, OfflineIcon, DownloadMgrIcon, CVAdminIcon, SettingsIcon } from './components/NavigationIcons';
import PullBoxPage from './pages/PullBoxPage';
import Modal from './components/Modal';
import { prepareReaderSession, revokeSession } from './session.mjs';
import React, { useState, useEffect, useRef, createContext, useContext, useCallback, useSyncExternalStore } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, useParams, Navigate } from 'react-router-dom';
import './App.css';
import './adminUi.css';
import './comicAction.css';
import OmnibusLogo from './components/OmnibusLogo';
import { loadAppearance, clearAppearance } from './components/appearance';
import AppearancePage from './pages/AppearancePage';
import './findBox.css';
import './libraryToolbar.css';
import './theme'; // sets data-theme="comic" on <html> (CSS hook)
import { ConfirmProvider } from './components/Confirm';
import { useNavTrail } from './components/navTrail';
import HomePage from './pages/HomePage';
import SeriesPage from './pages/SeriesPage';
import CollectionsPage from './pages/CollectionsPage';
import EventsPage from './pages/EventsPage';
import EventDetail from './pages/EventDetail';
import CollectionDetail from './pages/CollectionDetail';
import SeriesDetail from './pages/SeriesDetail';
import SearchPage from './pages/SearchPage';
import CVAdminPage from './pages/CVAdminPage';
import LibraryAdminPage from './pages/LibraryAdminPage';
import { useLibraryBadge } from './components/LibraryHealth';
import DownloadManager, { DownloadProgressPanel } from './pages/DownloadManager';
import SettingsPage from './pages/SettingsPage';
import ReaderPage from './pages/ReaderPage';
import LoginPage, { AuthCallbackPage } from './pages/LoginPage';
import CanonPage from './pages/CanonPage';
import CanonRunDetail from './pages/CanonRunDetail';
import OfflineLibraryPage from './pages/OfflineLibraryPage';
import { EssentialsPage } from './pages/ReadingListsPage';
import ReadingListDetail from './pages/ReadingListDetail';
import { ScrollMemory } from './hooks/scrollMemory';
import ReadingListEditor from './pages/ReadingListEditor';
import InstallBanner from './components/InstallBanner';
import AssistantBubble from './components/AssistantBubble';
import TopbarSearch from './components/TopbarSearch';
import { ReportProblemHost, reportProblem } from './components/ReportProblem';
import MyRequestsPage from './pages/MyRequestsPage';
import AdminInboxPage from './pages/AdminInboxPage';
import AchievementsPage from './pages/AchievementsPage';
import AchievementToasts from './components/AchievementToasts';
import { AiActivity } from './components/AiInfo';

// ─── Auth helpers ─────────────────────────────────────────────────
export function getToken()    { return localStorage.getItem('omnibus_token'); }
export function getUser()     { try { return JSON.parse(localStorage.getItem('omnibus_user')); } catch { return null; } }
// View as user (2026-10-27): an admin can hide every admin control and see the app as a
// regular user does (Appearance page, or the "Viewing as user" pill in the top bar to undo).
// This browser only; the server still treats the account as an admin.
const VIEW_AS_USER_KEY = 'omnibus.viewAsUser';
const viewListeners = new Set();
let viewAsUserOn = (() => { try { return localStorage.getItem(VIEW_AS_USER_KEY) === '1'; } catch { return false; } })();
export function isRealAdmin() { return getUser()?.role === 'admin'; }
export function isAdmin()     { return isRealAdmin() && !viewAsUserOn; }
export function viewingAsUser() { return isRealAdmin() && viewAsUserOn; }
export function setViewAsUser(on) {
  viewAsUserOn = !!on;
  try { if (on) localStorage.setItem(VIEW_AS_USER_KEY, '1'); else localStorage.removeItem(VIEW_AS_USER_KEY); } catch {}
  viewListeners.forEach(l => l());
}
export function useViewAsUser() {
  return useSyncExternalStore(cb => { viewListeners.add(cb); return () => viewListeners.delete(cb); }, viewingAsUser, () => false);
}
export function authHeader()  { const t = getToken(); return t ? { Authorization: `Bearer ${t}` } : {}; }

// ─── Reusable info tooltip ────────────────────────────────────────
export function InfoTip({ text, position = 'top', width = 240 }) {
  const [visible, setVisible] = React.useState(false);
  const posStyles = {
    top:    { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6 },
    bottom: { top: '100%',   left: '50%', transform: 'translateX(-50%)', marginTop: 6 },
    left:   { right: '100%', top: '50%',  transform: 'translateY(-50%)', marginRight: 6 },
    right:  { left: '100%',  top: '50%',  transform: 'translateY(-50%)', marginLeft: 6 },
  };
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' }}>
      <button
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onClick={e => { e.stopPropagation(); setVisible(v => !v); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px',
          color: 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', fontSize: 12, lineHeight: 1, display: 'inline-flex', alignItems: 'center' }}
        title={text}
      >ⓘ</button>
      {visible && (
        <div style={{
          position: 'absolute', zIndex: 9999, width,
          background: 'var(--om-base)', border: '1px solid color-mix(in srgb, var(--om-base) 85%, white)',
          borderRadius: 6, padding: '8px 10px',
          fontSize: 12, color: 'color-mix(in srgb, var(--om-text) 75%, var(--om-base))', lineHeight: 1.5,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          pointerEvents: 'none', whiteSpace: 'normal',
          ...posStyles[position],
        }}>
          {text}
        </div>
      )}
    </span>
  );
}
let logoutPending = false;
export async function doLogout(nav, localOnly = false) {
  if (logoutPending) return;
  logoutPending = true;
  try {
    const token = getToken();
    // Always sign out on this device; a server failure only means the session
    // could not be ended remotely, so tell the user instead of keeping them in.
    let serverFailed = false;
    if (token && !localOnly) {
      try { await revokeSession(token); } catch { serverFailed = true; }
    }
    localStorage.removeItem('omnibus_token');
    localStorage.removeItem('omnibus_user');
    clearAppearance();
    setViewAsUser(false);
    if (serverFailed) window.alert('You are signed out on this device, but the server could not be reached to end the session. It will expire on its own.');
    if (nav) nav('/login', { replace: true });
    else window.location.href = '/login';
  } finally { logoutPending = false; }
}

// Establish the image cookie before mounting pages, including existing sessions.
// Offline startup still permits intentionally downloaded comics on this device.
function RequireAuth({ children }) {
  const token = getToken();
  const loc = useLocation();
  const [session, setSession] = useState(null);
  useEffect(() => {
    let active = true;
    if (token) prepareReaderSession(token).then(status => {
      if (!active) return;
      if (status === 'invalid') { doLogout(undefined, true); return; }
      if (status === 'ready') loadAppearance(token);
      setSession({ token, status });
    });
    return () => { active = false; };
  }, [token]);
  useEffect(() => {
    let active = true;
    const reconnect = () => { if (token) prepareReaderSession(token).then(status => {
      if (!active) return;
      if (status === 'invalid') doLogout(undefined, true);
      else if (status === 'ready') { loadAppearance(token); setSession({ token, status }); }
    }); };
    window.addEventListener('online', reconnect);
    return () => { active = false; window.removeEventListener('online', reconnect); };
  }, [token]);
  if (!token) return <Navigate to="/login" state={{ from: loc }} replace />;
  if (session?.token !== token) return <div role="status">Opening your library…</div>;
  return <React.Fragment key={session.status}>{children}</React.Fragment>;
}

function RequireAdmin({ children }) {
  const token = getToken();
  const loc   = useLocation();
  if (!token)     return <Navigate to="/login" state={{ from: loc }} replace />;
  if (!isAdmin()) return (
    <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: '2rem', marginBottom: 12 }}>🔒</div>
      <div style={{ fontSize: '1.1rem', color: 'var(--om-text)', marginBottom: 8 }}>Admin access required</div>
      <div style={{ fontSize: '0.85rem' }}>Ask an admin to promote your account in Settings → Users.</div>
    </div>
  );
  return children;
}

// ─── Auto-attach auth header to all /api fetch calls ─────────────
const _origFetch = window.fetch;
window.fetch = function(url, opts = {}) {
  if (typeof url === 'string' && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    const token = getToken();
    if (token) {
      opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
    }
  }
  return _origFetch(url, opts).then(res => {
    if (res.status === 401 && !(typeof url === 'string' && url.startsWith('/api/auth/'))) {
      const loc = window.location.pathname;
      if (loc !== '/login' && loc !== '/auth-callback') doLogout(undefined, true);
    }
    return res;
  });
};

export const LibraryContext = createContext({ libraries:[], activeLibrary:null, setActiveLibrary:()=>{} });
export const useLibrary = () => useContext(LibraryContext);
export const AppSettingsContext = createContext({});
export const useAppSettings = () => useContext(AppSettingsContext);
// Records each history step's page for the shared back button (components/BackLink).
function NavTrail() { useNavTrail(); return null; }

// Retired pages (2026-10-26): Events Admin and Canon Admin (replaced by the shared editor,
// + New event and the Top Shelf admin bar), Authors and Characters (the Series page filters
// by creator and by character). Their old addresses lead to the new places.
function Moved({ to }) {
  const { id } = useParams();
  const query = new URLSearchParams(useLocation().search);
  return <Navigate to={typeof to === 'function' ? to(id, query) : to} replace />;
}

// ─── Series data cache (survives tab switches for 5 minutes) ──────
const SeriesCacheContext = createContext(null);
export function useSeriesCache() { return useContext(SeriesCacheContext); }

const CACHE_TTL = 60 * 1000; // 1 minute — keeps UI snappy without serving very stale ratings

function SeriesCacheProvider({ children }) {
  // cache: Map<cacheKey, { data, ts, loading, callbacks[] }>
  const cache = useRef(new Map());

  const fetchSeries = useCallback(async (libraryId, _attempt = 0) => {
    const key = libraryId?.id || '__all__';
    const hit = cache.current.get(key);

    // Return cached data if fresh
    if (hit && hit.data && hit.data.length > 0 && (Date.now() - hit.ts) < CACHE_TTL) {
      return hit.data;
    }

    // Deduplicate in-flight requests
    if (hit && hit.loading) {
      return new Promise(resolve => hit.callbacks.push(resolve));
    }

    // Start a new fetch
    const entry = { data: null, ts: 0, loading: true, callbacks: [] };
    cache.current.set(key, entry);

    try {
      let url = '/api/series?enrich=true';
      if (libraryId) url += `&libraryId=${libraryId.id}`;
      const r = await fetch(url);
      const d = await r.json();
      const data = d.content || [];

      // If empty and we haven't retried yet, server may still be starting —
      // wait 1.5s and try once more before giving up.
      if (data.length === 0 && _attempt < 2) {
        entry.loading = false;
        cache.current.delete(key);
        await new Promise(res => setTimeout(res, 1500));
        return fetchSeries(libraryId, _attempt + 1);
      }

      entry.data = data;
      entry.ts = data.length > 0 ? Date.now() : 0;
      entry.loading = false;
      entry.callbacks.forEach(cb => cb(data));
      entry.callbacks = [];
      return data;
    } catch (e) {
      // Network error — server likely still starting, retry up to 2 times
      entry.loading = false;
      cache.current.delete(key);
      if (_attempt < 2) {
        await new Promise(res => setTimeout(res, 1500));
        return fetchSeries(libraryId, _attempt + 1);
      }
      entry.callbacks.forEach(cb => cb([]));
      entry.callbacks = [];
      throw e;
    }
  }, []);

  const invalidate = useCallback((libraryId) => {
    const key = libraryId?.id || '__all__';
    cache.current.delete(key);
  }, []);

  return (
    <SeriesCacheContext.Provider value={{ fetchSeries, invalidate }}>
      {children}
    </SeriesCacheContext.Provider>
  );
}

export default function App() {
  // The app accent is always Comic yellow (App.css :root). Until 2026-10-26 it started as
  // Wood gold and was re-tinted app-wide from the last series cover opened.
  const [libraries, setLibraries] = useState([]);
  const [activeLibrary, setActiveLibrary] = useState(null);
  const [appSettings, setAppSettings] = useState({});

  useEffect(() => {
    if (!getToken()) return;
    // Use a short timeout so offline startup doesn't hang waiting for
    // network requests that will never complete. 4s is enough for a slow
    // home server; fast enough to not feel broken when offline.
    const fetchWithTimeout = (url, ms = 4000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      return fetch(url, { signal: controller.signal })
        .finally(() => clearTimeout(timer));
    };
    fetchWithTimeout('/api/libraries').then(r => r.json())
      .then(d => setLibraries(Array.isArray(d) ? d : (d.content || [])))
      .catch(() => {}); // silently fail offline — no libraries shown
    fetchWithTimeout('/api/settings').then(r => r.json())
      .then(d => setAppSettings({ ...(d || {}), __loaded: true }))
      .catch(() => setAppSettings(s => ({ ...s, __loaded: true }))); // silently fail offline — use defaults
  }, []);

  return (
    <LibraryContext.Provider value={{ libraries, activeLibrary, setActiveLibrary }}>
      <AppSettingsContext.Provider value={appSettings}>
        <ConfirmProvider>
        <SeriesCacheProvider>
          {/* React Router 7 (2026-11-04; its behaviour was switched on in v6 on 2026-11-03). */}
          <BrowserRouter>
            <NavTrail />
            <AchievementToasts />
            <ScrollMemory />
            <ReportProblemHost />
            <Routes>
              <Route path="/login"         element={<LoginPage />} />
              <Route path="/auth-callback" element={<AuthCallbackPage />} />
              <Route path="/read/:bookId"  element={<RequireAuth><ReaderPage /></RequireAuth>} />
              <Route path="/*"             element={<RequireAuth><Shell /></RequireAuth>} />
            </Routes>
          </BrowserRouter>
        </SeriesCacheProvider>
        </ConfirmProvider>
      </AppSettingsContext.Provider>
    </LibraryContext.Provider>
  );
}

function Shell() {
  const asUser = useViewAsUser();
  const [splashDone, setSplashDone] = React.useState(false);
  React.useEffect(() => {
    // Show splash for minimum 1.2s then fade out
    const t = setTimeout(() => setSplashDone(true), 1200);
    return () => clearTimeout(t);
  }, []);

  if (!splashDone) return (
    <div className="app-splash">
      <OmnibusLogo className="app-splash-logo" />
      <span className="app-splash-text">Omnibus</span>
    </div>
  );

  // Switching View as user remounts the shell so every page re-reads isAdmin().
  return (
    <div className="app" key={asUser ? 'as-user' : 'as-admin'}>
      <Sidebar />
      <div className="app-body">
        <TopBar />
        <main className="main-content">
          <Routes>
            <Route path="/"                element={<HomePage />} />
            <Route path="/series"          element={<SeriesPage />} />
            <Route path="/collections"     element={<CollectionsPage key="all" />} />
            <Route path="/my-boxes"        element={<CollectionsPage key="mine" mine />} />
            <Route path="/collections/:id" element={<CollectionDetail />} />
            <Route path="/series/:id"      element={<SeriesDetail />} />
            <Route path="/authors"         element={<Moved to={(id, q) => (q.get('creator') ? `/series?creator=${encodeURIComponent(q.get('creator'))}` : '/series')} />} />
            <Route path="/characters"      element={<Moved to="/series" />} />
            <Route path="/search"          element={<SearchPage />} />
            <Route path="/events"              element={<EventsPage />} />
            <Route path="/events/new"          element={<Navigate to="/events?new=1" replace />} />
            <Route path="/events/:id"          element={<EventDetail />} />
            <Route path="/events/:id/edit"     element={<RequireAdmin><ReadingListEditor kind="event" /></RequireAdmin>} />
            <Route path="/events-admin"        element={<Moved to="/events" />} />
            <Route path="/events-admin/:id"    element={<Moved to={id => `/events/${id}`} />} />
            <Route path="/canon"            element={<CanonPage />} />
            <Route path="/canon/:category"  element={<CanonPage />} />
            <Route path="/canon/run/:id"    element={<CanonRunDetail />} />
            <Route path="/canon/run/:id/edit" element={<RequireAdmin><ReadingListEditor kind="run" /></RequireAdmin>} />
            <Route path="/canon-admin"      element={<Moved to="/canon" />} />
            <Route path="/canon-admin/:id"  element={<Moved to={id => `/canon/run/${id}`} />} />
            <Route path="/canon-admin/:id/edit" element={<Moved to={id => `/canon/run/${id}/edit`} />} />
            <Route path="/cv-admin"        element={<RequireAdmin><CVAdminPage /></RequireAdmin>} />
            <Route path="/library"         element={<RequireAdmin><LibraryAdminPage /></RequireAdmin>} />
            <Route path="/downloads"       element={<RequireAuth><DownloadManager /></RequireAuth>} />
            <Route path="/settings"        element={<RequireAdmin><SettingsPage /></RequireAdmin>} />
            <Route path="/my-pull-box" element={<RequireAuth><PullBoxPage /></RequireAuth>} />
            <Route path="/offline"         element={<OfflineLibraryPage />} />
            <Route path="/appearance"      element={<RequireAuth><AppearancePage /></RequireAuth>} />
            <Route path="/my-requests"     element={<RequireAuth><MyRequestsPage /></RequireAuth>} />
            <Route path="/achievements"    element={<RequireAuth><AchievementsPage /></RequireAuth>} />
            <Route path="/achievements/:userId" element={<RequireAuth><AchievementsPage /></RequireAuth>} />
            <Route path="/admin/requests"  element={<RequireAdmin><AdminInboxPage key="requests" kind="requests" /></RequireAdmin>} />
            <Route path="/admin/reports"   element={<RequireAdmin><AdminInboxPage key="reports" kind="reports" /></RequireAdmin>} />
            <Route path="/reading-lists"     element={<Navigate to="/collections" replace />} />
            <Route path="/essentials"        element={<EssentialsPage />} />
            <Route path="/reading-lists/:id" element={<ReadingListDetail />} />
            <Route path="/reading-lists/:id/edit" element={<ReadingListEditor />} />
            <Route path="/essentials/:id/edit" element={<ReadingListEditor />} />
            <Route path="/essentials/:id"    element={<ReadingListDetail />} />
          </Routes>
        </main>
      </div>
      <BottomNav />
      {/* Global download progress panel — renders bottom-left toasts for any
          active download, regardless of which page the user is on. Only
          mounted for authenticated users so the EventSource doesn't fire
          on the login screen. */}
      {getToken() && <DownloadProgressPanel />}
      <InstallBanner />
      {/* Comic Book Guy: floating chat on every Shell page (the reader is outside Shell) */}
      {getToken() && <AssistantBubble />}
    </div>
  );
}

function Sidebar() {
  const location = useLocation();
  const libraryBadge = useLibraryBadge(isAdmin());
  const isActive = path => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
  const appSettings = useAppSettings();
  const dlAdminOnly = appSettings.download_manager_admin_only === 'true';

  const {homeGroup,browseGroup,curatedGroup,myReadingGroup,toolsGroup}=navigationGroups(dlAdminOnly,libraryBadge);

  const NavGroup = ({ items, title }) => (
    <div className="sidebar-group">
      {title && <div className="sidebar-group-title"><span>{title}</span></div>}
      {items.map(({ path, icon, label, badge }) => (
        <Link key={path} to={path} className={`sidebar-item ${isActive(path) ? 'active' : ''}`} style={badge ? { position: 'relative' } : undefined}
          title={badge ? `${label}: ${badge} need${badge === 1 ? 's' : ''} you` : undefined}>
          {badge ? <span style={navBadgeStyle}>{badge > 99 ? '99+' : badge}</span> : null}
          <span className="sidebar-icon">{icon}</span>
          <span className="sidebar-tooltip">{label}</span>
        </Link>
      ))}
    </div>
  );

  return (
    <aside className="sidebar">
      <Link to="/" className="sidebar-logo">
        <OmnibusLogo size="sm" className="sidebar-logo-mark" />
        <span className="sidebar-logo-text">Omnibus</span>
      </Link>
      <nav className="sidebar-nav">
        <NavGroup items={homeGroup} />
        <NavGroup items={browseGroup} title="Browse" />
        <NavGroup items={curatedGroup} title="Must Reads" />
        <NavGroup items={myReadingGroup} title="My Stuff" />
        {toolsGroup.length > 0 && <NavGroup items={toolsGroup} title="Tools" />}
      </nav>
      <div className="sidebar-footer">
        <span className="sidebar-version">v2.0</span>
      </div>
    </aside>
  );
}

function TopBar() {
  const navigate = useNavigate();
  const { libraries, activeLibrary, setActiveLibrary } = useLibrary();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef(null);
  const searchToggle = useRef(null);
  const libraryToggle = useRef(null);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  const closeSearch = () => { setSearchOpen(false); if (searchOpen) requestAnimationFrame(() => searchToggle.current?.focus()); };

  useEffect(() => {
    const close = () => setOpen(false);
    if (open) document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const select = lib => { setActiveLibrary(lib); setOpen(false); libraryToggle.current?.focus(); };

  return (
    <div className={`topbar library-toolbar${searchOpen ? ' search-open' : ''}`}>
      <div className="lib-selector" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); libraryToggle.current?.focus(); } }}>
        <button type="button" className="lib-trigger" ref={libraryToggle} aria-expanded={open} aria-controls="library-options" aria-label={`Library: ${activeLibrary?.name || 'All Libraries'}`} onClick={() => setOpen(value => !value)}>
        <span className="lib-selector-label">Library</span>
        <div className="lib-selector-row">
          <LibraryIcon />
          <span className="lib-name">{activeLibrary?.name || 'All Libraries'}</span>
          <span className={`lib-caret ${open ? 'open' : ''}`}>▾</span>
        </div>
        </button>
        {open && (
          <div id="library-options" className="lib-dropdown" onClick={e => e.stopPropagation()}>
            <button type="button" className={`lib-option ${!activeLibrary ? 'active' : ''}`} onClick={() => select(null)}>
              <LibraryIcon /> All Libraries
            </button>
            <div className="lib-divider" />
            {libraries.map(lib => (
              <button type="button" key={lib.id} className={`lib-option ${activeLibrary?.id === lib.id ? 'active' : ''}`} onClick={() => select(lib)}>
                <span className="lib-dot">▸</span> {lib.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" ref={searchToggle} className="search-toggle" aria-label="Open search" aria-expanded={searchOpen} onClick={() => { setOpen(false); setSearchOpen(true); }}><SearchIcon /><span>Search</span></button>
      <TopbarSearch query={query} setQuery={setQuery} inputRef={searchInput} libraryId={activeLibrary?.id || null}
        onClose={closeSearch} onDone={() => setSearchOpen(false)} icon={<SearchIcon />} />
      <div className="toolbar-account"><UserBadge /></div>
    </div>
  );
}

function UserBadge() {
  const navigate = useNavigate();
  const user     = getUser();
  const [open, setOpen] = useState(false);
  // Admins: open requests and reports, counted when the menu opens (2026-11-10: moved here from
  // the Download Manager's tabs).
  const [inbox, setInbox] = useState({ requests: 0, reports: 0 });
  useEffect(() => {
    if (!open || !isAdmin()) return;
    fetch('/api/download-requests/count').then(r => r.json()).then(d => setInbox(x => ({ ...x, requests: d.open || 0 }))).catch(() => {});
    fetch('/api/reports/count').then(r => r.json()).then(d => setInbox(x => ({ ...x, reports: d.open || 0 }))).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  if (!user) return null;
  return (<>
    {viewingAsUser() && (
      <button type="button" className="view-as-user-pill" onClick={() => setViewAsUser(false)}
        title="Admin controls are hidden in this browser. Click to show them again.">
        Viewing as user <span aria-hidden="true">✕</span>
      </button>
    )}
    <AiActivity />
    <div style={{ position: 'relative', marginLeft: 8 }} onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%', cursor: 'pointer',
        background: 'var(--color-primary, var(--td-yellow))', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: '0.8rem', fontWeight: 700, color: 'var(--om-base)',
        userSelect: 'none',
      }}>
        {user.username[0].toUpperCase()}
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: 38, right: 0, minWidth: 210, zIndex: 200,
          background: 'var(--bg-card, var(--om-base))', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden',
        }} onClick={e => e.stopPropagation()}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--om-text)', fontWeight: 600 }}>{user.username}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{user.role}</div>
          </div>
          <div style={dropItemStyle} onClick={() => { setOpen(false); navigate('/achievements'); }}>Achievements</div>
          <div style={dropItemStyle} onClick={() => { setOpen(false); navigate('/appearance'); }}>Appearance</div>
          <div style={dropItemStyle} onClick={() => { setOpen(false); navigate('/offline'); }}>Offline comics</div>
          {isAdmin() ? <>
            <div style={dropItemStyle} onClick={() => { setOpen(false); navigate('/admin/requests'); }}>Requests{inbox.requests > 0 && <span style={menuCountStyle}>{inbox.requests}</span>}</div>
            <div style={dropItemStyle} onClick={() => { setOpen(false); navigate('/admin/reports'); }}>Problem reports{inbox.reports > 0 && <span style={menuCountStyle}>{inbox.reports}</span>}</div>
          </> : <>
            <div style={dropItemStyle} onClick={() => { setOpen(false); navigate('/my-requests'); }}>My requests</div>
            <div style={dropItemStyle} onClick={() => { setOpen(false); reportProblem({ type: 'page' }); }}>⚑ Report a problem</div>
          </>}
          {isAdmin() && (
            <div style={dropItemStyle} onClick={() => { setOpen(false); navigate('/settings?group=people'); }}>
              Manage users
            </div>
          )}
          <div style={{ ...dropItemStyle, color: '#e88' }} onClick={() => doLogout(navigate)}>
            Sign out
          </div>
        </div>
      )}
    </div>
  </>);
}
// Count of open requests / reports beside an account-menu item (admins).
const menuCountStyle = { marginLeft: 8, padding: '0 6px', borderRadius: 9, background: 'var(--td-red)', color: 'var(--om-text)', fontSize: 11, fontWeight: 700, lineHeight: '17px', display: 'inline-block' };
// Count bubble on a sidebar button (Library: things that need you).
const navBadgeStyle = { position: 'absolute', top: 4, right: 4, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
  background: 'var(--td-red)', color: 'var(--om-text)', fontSize: 11, fontWeight: 700, lineHeight: '18px', textAlign: 'center', border: '1.5px solid #000', zIndex: 1 };
const dropItemStyle = { padding: '9px 14px', fontSize: '0.83rem', color: 'color-mix(in srgb, var(--om-text) 70%, var(--om-base))', cursor: 'pointer' };

// ─── BottomNav ────────────────────────────────────────────────────
function navigationGroups(dlAdminOnly, libraryBadge) {
  // Labeled groups: Browse (the whole library), Must Reads (admin-picked
  // reading), My Stuff (the user's own), then Tools.
  const homeGroup = [
    { path: '/',            icon: <HomeIcon />,        label: 'Home'             },
  ];
  const browseGroup = [
    { path: '/collections', icon: <CollectionsIcon />, label: 'Comic Box'        },
    { path: '/series',      icon: <SeriesIcon />,      label: 'Series'           },
  ];
  const curatedGroup = [
    { path: '/canon',       icon: <CanonIcon />,       label: 'Top Shelf'        },
    { path: '/events',      icon: <EventsIcon />,      label: 'Timeline'         },
    { path: '/essentials',  icon: <EssentialsIcon />,  label: 'Essentials'       },
  ];
  const myReadingGroup = [
    {path:'/my-pull-box',icon:<PullBoxIcon />,label:'My Pull Box'},
    {path:'/offline',icon:<OfflineIcon />,label:'Offline'},
    // Reading Lists retired 2026-11-03: reading orders are boxes (claude/BOXES_UNIFIED_PLAN.md).
    {path:'/my-boxes',icon:<MyBoxesIcon />,label:'My Comic Boxes'},
  ];
  const toolsGroup = [
    ...(!dlAdminOnly || isAdmin() ? [{ path: '/downloads', icon: <DownloadMgrIcon />, label: 'Downloads' }] : []),
    ...(isAdmin() ? [
      { path: '/library',      icon: <CVAdminIcon />, label: 'Library', badge: libraryBadge },
      { path: '/settings',     icon: <SettingsIcon />, label: 'Settings'   },
    ] : []),
  ];

  return {homeGroup,browseGroup,curatedGroup,myReadingGroup,toolsGroup};
}

function BottomNav() {
  const location=useLocation();
  const libraryBadge=useLibraryBadge(isAdmin());
  const settings=useAppSettings();
  const groups=navigationGroups(settings.download_manager_admin_only==='true',libraryBadge);
  const [open,setOpen]=useState(null);
  useEffect(()=>setOpen(null),[location.pathname]);
  const mine=groups.myReadingGroup;
  const more=[...groups.toolsGroup,{path:'/appearance',icon:<SettingsIcon />,label:'Appearance'},{path:'/my-requests',icon:<ReadingListIcon />,label:'My requests'}];
  const sections=[{label:'Browse',icon:<SeriesIcon />,items:groups.browseGroup},{label:'Must Reads',icon:<CanonIcon />,items:groups.curatedGroup},{label:'My Stuff',icon:<MyBoxesIcon />,items:mine},{label:'More',icon:<MoreIcon />,items:more}];
  const explanations={'My Pull Box':'Series you follow, across all libraries','Comic Box':'Explore eras, worlds, and collections','Series':'Browse the entire library','Top Shelf':'Great runs, award winners, and staff picks','Essentials':'Guided character journeys','Timeline':'Events and their reading orders','My Comic Boxes':'Your boxes, reading orders, and the ones you follow','Offline':'Comics saved to this device'};
  const current=sections.find(group=>group.items.some(item=>!item.path.includes('#') && location.pathname.startsWith(item.path)));
  const chosen=sections.find(group=>group.label===open);
  return <>
    {chosen && <Modal title={chosen.label} onClose={()=>setOpen(null)} className="mobile-group-dialog"><div className="mobile-group-links">{chosen.items.map(item=><Link key={item.path} to={item.path} onClick={()=>setOpen(null)}><span>{item.icon}</span><div><strong>{item.label}{item.badge ? ' ('+item.badge+')' : ''}</strong>{explanations[item.label] && <small>{explanations[item.label]}</small>}</div></Link>)}</div></Modal>}
    <nav className="bottom-nav hp-bottom-nav" aria-label="Main navigation"><Link to="/" className={'bottom-nav-item '+(location.pathname==='/'?'active':'')}><span className="bottom-nav-icon"><HomeIcon /></span><span className="bottom-nav-label">Home</span></Link>{sections.map(group=><button key={group.label} className={'bottom-nav-item '+((open?open===group.label:current===group)?'active':'')} aria-expanded={open===group.label} aria-haspopup="dialog" onClick={()=>setOpen(open===group.label?null:group.label)}><span className="bottom-nav-icon">{group.icon}</span><span className="bottom-nav-label">{group.label}</span></button>)}</nav>
  </>;
}

// ─── Icons ────────────────────────────────────────────────────────
const MoreIcon     = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/></svg>);
const LibraryIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>);
const SearchIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>);
const ReadingListIcon = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 5.5l1 1 2-2"/><path d="M4 11.5l1 1 2-2"/><circle cx="5" cy="18" r="1"/></svg>);
