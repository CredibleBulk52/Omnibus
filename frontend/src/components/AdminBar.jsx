import React from 'react';
import '../adminBar.css';

// Catalog tools for admins (create, generate, refresh): one bar, one look, on every
// catalog page. What it holds stays per page. Buttons inside use className="admin-bar-btn"
// ("admin-bar-btn primary" for the main action).
export default function AdminBar({ label = 'Admin', children, below }) {
  return (
    <section className="admin-bar" aria-label={label === 'Admin' ? 'Admin tools' : label}>
      <div className="admin-bar-row"><span className="admin-bar-label">{label}</span>{children}</div>
      {below}
    </section>
  );
}
