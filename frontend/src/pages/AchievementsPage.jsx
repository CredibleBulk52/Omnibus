import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import AchievementBadge from '../components/AchievementBadge';
import { Loading, ErrorNote } from '../components/StateMessage';
import '../curatedPage.css';
import '../achievements.css';

// ─── Achievements (2026-11-10, pass 1; claude/ACHIEVEMENTS_DESIGN.md) ─────────
// A reader's trophy case: their count, latest badges, the ones closest to earning,
// the household leaderboard, and every achievement by group as comic panels.
// /achievements is your own; /achievements/:userId another reader's.
const fmtDate = s => { const d = new Date(String(s).replace(' ', 'T') + 'Z'); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };

function Holders({ item, readers }) {
  if (!readers) return null;
  const rare = item.holders > 0 && item.holders <= 2 && readers > 4;
  return (
    <span className="ach-holders">
      {item.holders} of {readers} reader{readers === 1 ? '' : 's'}
      {rare && <span className="ach-rare">Rare</span>}
    </span>
  );
}

function Card({ item, readers, mine }) {
  const earned = !!item.earned_at;
  const pct = item.need ? Math.round((100 * (item.have || 0)) / item.need) : 0;
  return (
    <div className={`ach-card${earned ? ' earned' : ''}${item.hidden && !earned ? ' secret' : ''}`}>
      <AchievementBadge item={item} size={78} locked={!earned} />
      <div className="ach-card-body">
        <div className="ach-card-name">{item.name}</div>
        <div className="ach-card-desc">{item.desc}{item.note && !earned ? ` (${item.note})` : ''}</div>
        {earned
          ? <div className="ach-card-when">Earned {fmtDate(item.earned_at)}</div>
          : item.need > 1 && item.have != null && (
            <div className="ach-progress" title={`${item.have} of ${item.need}`} aria-label={`${item.have} of ${item.need}`}>
              <span style={{ width: `${pct}%` }} /><em>{item.have} / {item.need}</em>
            </div>)}
        <Holders item={item} readers={readers} />
      </div>
    </div>
  );
}

export default function AchievementsPage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null), [err, setErr] = useState('');
  const [show, setShow] = useState('all');   // all | earned | todo
  useEffect(() => {
    let live = true; setData(null); setErr('');
    fetch(`/api/achievements${userId ? `?user=${encodeURIComponent(userId)}` : ''}`)
      .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`); return b; })
      .then(d => { if (live) setData(d); }).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [userId]);
  const groups = useMemo(() => (data?.groups || []).map(g => ({
    ...g, earned: g.items.filter(i => i.earned_at).length,
    items: g.items.filter(i => (show === 'earned' ? i.earned_at : show === 'todo' ? !i.earned_at : true)),
  })), [data, show]);

  const title = data && !data.me ? `${data.user.username.toUpperCase()}'S TROPHY CASE` : 'ACHIEVEMENTS';
  return (
    <div className="ach-page">
      <PageHeader title={title} borderSeed={3} note={data ? `${data.earned} / ${data.total}` : null} />
      <div className="curated-page ach-wrap">
        {err && <ErrorNote>{err}</ErrorNote>}
        {!data && !err && <Loading label="Opening the trophy case…" />}
        {data && <>
          <div className="ach-top">
            <section className="ach-panel ach-score">
              <div className="ach-burst"><b>{data.earned}</b><span>of {data.total}</span></div>
              <div className="ach-score-text">
                <h2>{data.me ? 'Your trophy case' : `${data.user.username}'s trophy case`}</h2>
                <p>Counting since {fmtDate(data.since)}. Read an issue to its last page to count it.</p>
                {data.recent.length > 0 && <>
                  <div className="ach-mini-label">Latest</div>
                  <div className="ach-mini-row">{data.recent.map(i => <AchievementBadge key={i.id} item={i} size={52} />)}</div>
                </>}
              </div>
            </section>
            <section className="ach-panel ach-board" aria-label="Household leaderboard">
              <div className="ach-banner"><span>Top of the Stack</span></div>
              <ol>
                {data.leaderboard.map((r, i) => (
                  <li key={r.id} className={r.id === data.user.id ? 'you' : ''}>
                    <span className="ach-rank">{i + 1}</span>
                    <Link to={r.id === data.user.id && data.me ? '/achievements' : `/achievements/${encodeURIComponent(r.id)}`}>{r.username}</Link>
                    <span className="ach-count">{r.count}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          {data.me && data.closest.length > 0 && (
            <section className="ach-panel ach-closest">
              <div className="ach-banner"><span>Almost There</span></div>
              <div className="ach-grid">{data.closest.map(i => <Card key={i.id} item={i} readers={data.readers} mine />)}</div>
            </section>
          )}

          <div className="ach-filter" role="group" aria-label="Show">
            {[['all', 'All'], ['earned', 'Earned'], ['todo', 'Not yet']].map(([k, l]) => (
              <button key={k} type="button" className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{l}</button>
            ))}
            {!data.me && <button type="button" onClick={() => navigate('/achievements')}>My trophy case</button>}
          </div>

          {groups.map(g => g.items.length > 0 && (
            <section key={g.id} className={`ach-panel ach-group ach-group-${g.id}`}>
              <div className="ach-banner"><span>{g.title}</span><small>{g.earned} / {data.groups.find(x => x.id === g.id).items.length}</small></div>
              <p className="ach-blurb">{g.blurb}</p>
              <div className="ach-grid">{g.items.map(i => <Card key={i.id} item={i} readers={data.readers} mine={data.me} />)}</div>
            </section>
          ))}
        </>}
      </div>
    </div>
  );
}
