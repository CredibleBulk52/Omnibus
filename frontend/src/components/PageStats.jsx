import React, { useState, useEffect } from 'react';

const fmt = n => {
  if (typeof n !== 'number') return n;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
};

// Fetches /api/stats/page?page=...&libraryId=... and renders the stats inline.
// Reuses .home-stats / .home-stat-n / .home-stat-l classes for visual consistency.
export default function PageStats({ page, libraryId, extra }) {
  const [stats, setStats] = useState([]);

  useEffect(() => {
    const libParam = libraryId ? `&libraryId=${libraryId}` : '';
    fetch(`/api/stats/page?page=${page}${libParam}`)
      .then(r => r.json())
      .then(d => setStats(d.stats || []))
      .catch(() => setStats([]));
  }, [page, libraryId]);

  const merged = [...stats, ...(extra || [])];
  if (!merged.length) return null;

  return (
    <div className="home-stats">
      {merged.map((s, i) => (
        <div className="home-stat" key={i}>
          <div className="home-stat-n">{fmt(s.n)}</div>
          <div className="home-stat-l">{s.l}</div>
        </div>
      ))}
    </div>
  );
}
