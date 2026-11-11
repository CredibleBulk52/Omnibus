import React, { useEffect, useRef, useState, useCallback } from 'react';

// ─── AdminGroup ───────────────────────────────────────────────────
// One group on an admin page (Library, Settings) that opens in place instead
// of another row of tabs (2026-10-16 reorganization, claude/ADMIN_REORG.md).
// A closed group renders nothing inside, so it makes no requests.
export default function AdminGroup({ id, title, sub, open, onToggle, actions = null, children }) {
  const ref = useRef(null);
  useEffect(() => {
    // Opened from a link (?group=…): bring it into view once.
    if (open && new URLSearchParams(window.location.search).get('group') === id) {
      ref.current?.scrollIntoView({ block: 'start' });
    }
  }, []); // mount only
  return (
    <section className={`admin-group${open ? ' admin-group--open' : ''}`} id={`group-${id}`} ref={ref}>
      <div className="admin-group-head">
        <button type="button" className="admin-group-toggle" aria-expanded={open} aria-controls={`group-body-${id}`} onClick={() => onToggle(id)}>
          <span className="admin-group-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="admin-group-text">
            <span className="admin-group-title">{title}</span>
            {sub && <span className="admin-group-sub">{sub}</span>}
          </span>
        </button>
        {actions && <div className="admin-group-actions">{actions}</div>}
      </div>
      {open && <div className="admin-group-body" id={`group-body-${id}`}>{children}</div>}
    </section>
  );
}

// Open groups: the one named in the URL (?group=…) or the defaults.
export function useOpenGroups(defaults = []) {
  const [open, setOpen] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('group');
    return new Set(fromUrl ? [fromUrl] : defaults);
  });
  const toggle = useCallback(id => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  // Open one group (leaving the others as they are) and bring it into view.
  const openGroup = useCallback(id => {
    setOpen(prev => new Set(prev).add(id));
    requestAnimationFrame(() => document.getElementById(`group-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);
  return [open, toggle, openGroup];
}

export function AdminGroupStyles() {
  return <style>{`
    .admin-groups { display: flex; flex-direction: column; gap: 10px; padding-top: 20px; }
    .admin-groups-note { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 6px; }
    .admin-groups-note a { color: var(--td-yellow, var(--color-primary)); }
    .admin-group { border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-card); }
    .admin-group--open { border-color: var(--border-active, var(--border-subtle)); }
    .admin-group-head { display: flex; align-items: center; gap: 12px; padding-right: 14px; }
    .admin-group-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 14px 16px;
      background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .admin-group-caret { color: var(--td-yellow, var(--color-primary)); font-size: 0.9rem; width: 12px; }
    .admin-group-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .admin-group-title { font-family: 'Boogaloo', cursive; font-size: 1.15rem; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--td-yellow, var(--text-primary)); }
    .admin-group-sub { font-size: 0.8rem; color: var(--text-muted); }
    .admin-group-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .admin-group-body { padding: 0 18px 8px; border-top: 1px solid var(--border-subtle); }
    .admin-group-body > .settings-section:last-child { border-bottom: none; }
    @media (max-width: 767px) { .admin-group-head { flex-wrap: wrap; padding: 0 0 10px; } .admin-group-actions { padding: 0 16px; } .admin-group-body { padding: 0 12px 8px; } }
  `}</style>;
}
