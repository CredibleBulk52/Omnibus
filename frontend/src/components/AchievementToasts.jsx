import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AchievementBadge from './AchievementBadge';
import { getUser } from '../App';
import '../achievements.css';

// ─── Achievement toasts (2026-11-10) ──────────────────────────────────────────
// Wherever the reader is: asks for achievements not shown yet every 2 minutes, on page
// changes, and at once when the reader reports a finished issue ('omnibus:achievements').
// Shows up to three at a time ("+N more"), marks them seen, and opens the Achievements
// page when clicked.
const POLL_MS = 120000, SHOW_MS = 7000;

export default function AchievementToasts() {
  const [items, setItems] = useState([]);
  const navigate = useNavigate();
  const location = useLocation();
  const signedIn = !!getUser() && !location.pathname.startsWith('/login');
  const busy = useRef(false), timer = useRef(null);
  const check = useCallback(() => {
    if (!signedIn || busy.current) return;
    busy.current = true;
    fetch('/api/achievements/unseen').then(r => (r.ok ? r.json() : { items: [] })).then(d => {
      const fresh = Array.isArray(d.items) ? d.items : [];
      if (!fresh.length) return;
      setItems(cur => [...cur, ...fresh.filter(f => !cur.some(c => c.id === f.id))]);
      fetch('/api/achievements/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: fresh.map(f => f.id) }) }).catch(() => {});
    }).catch(() => {}).finally(() => { busy.current = false; });
  }, [signedIn]);
  useEffect(() => {
    if (!signedIn) return undefined;
    check();
    const t = setInterval(check, POLL_MS);
    const now = () => check();
    window.addEventListener('omnibus:achievements', now);
    return () => { clearInterval(t); window.removeEventListener('omnibus:achievements', now); };
  }, [signedIn, check]);
  useEffect(() => { check(); }, [location.pathname, check]);
  useEffect(() => {
    if (!items.length) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setItems(cur => cur.slice(3)), SHOW_MS);
    return () => clearTimeout(timer.current);
  }, [items]);
  if (!items.length) return null;
  const shown = items.slice(0, 3), more = items.length - shown.length;
  const open = () => { setItems([]); navigate('/achievements'); };
  return (
    <div className="ach-toasts" aria-live="polite">
      {shown.map((i, k) => (
        <button key={i.id} type="button" className="ach-toast" onClick={open} title="Open your achievements">
          <AchievementBadge item={i} size={56} />
          <span className="ach-toast-text">
            <span className="ach-toast-kicker">Achievement unlocked!</span>
            <span className="ach-toast-name" style={{ display: 'block' }}>{i.name}</span>
            {k === shown.length - 1 && more > 0 && <span className="ach-toast-more">+{more} more</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
