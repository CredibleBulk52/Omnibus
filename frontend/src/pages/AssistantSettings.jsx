// ─── AssistantSettings ────────────────────────────────────────────
// Settings → "Comic Book Guy" tab: on/off, name, daily limit, avatar, and
// his usage: totals, by user, feedback, recent questions (cost by day, model and
// task is in Usage & results; the test set was removed 2026-10-23). His key and models (Quick Answers, Reading List Generator,
// Long Answers) are set in Settings → AI & Comic Book Guy, so nothing is configured twice.
import React, { useState, useEffect, useCallback } from 'react';

const KEYS = ['assistant_enabled', 'assistant_name', 'assistant_daily_limit', 'assistant_web_search', 'assistant_monthly_cap'];   // models: AI Models tab

export default function AssistantSettings({ compact = false }) {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState(null);
  const [days, setDays] = useState(14);
  const [report, setReport] = useState('user');
  const [avatarV, setAvatarV] = useState(Date.now());
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      setForm({
        assistant_enabled: s.assistant_enabled ?? 'true',
        assistant_name: s.assistant_name || 'Comic Book Guy',
        assistant_daily_limit: s.assistant_daily_limit ?? '20',
        assistant_web_search: s.assistant_web_search ?? 'true',
        assistant_monthly_cap: s.assistant_monthly_cap ?? '0',
        _hasKey: !!s.anthropic_api_key,
      });
    }).catch(e => setError(e.message));
  }, []);

  const loadUsage = useCallback(() => {
    fetch(`/api/assistant/usage?days=${days}`).then(r => r.json()).then(setUsage).catch(() => setUsage(null));
  }, [days]);
  useEffect(() => { loadUsage(); }, [loadUsage]);

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setSaved(false); };
  const save = async () => {
    setError('');
    try {
      const body = {};
      for (const k of KEYS) body[k] = String(form[k] ?? '');
      body.assistant_daily_limit = String(Math.max(0, parseInt(form.assistant_daily_limit, 10) || 0));
      body.assistant_monthly_cap = String(Math.max(0, Math.round((parseFloat(form.assistant_monthly_cap) || 0) * 100) / 100));
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Save failed (${r.status})`);
      setSaved(true); loadUsage();
    } catch (e) { setError(e.message); }
  };
  const upload = async (file) => {
    if (!file) return;
    setUploading(true); setError('');
    try {
      const r = await fetch('/api/assistant/avatar', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
      setAvatarV(Date.now());
    } catch (e) { setError(e.message); }
    setUploading(false);
  };
  const resetAvatar = async () => {
    await fetch('/api/assistant/avatar', { method: 'DELETE' }).catch(() => {});
    setAvatarV(Date.now());
  };

  if (!form) return <div className="settings-section">Loading…</div>;
  const name = form.assistant_name || 'Comic Book Guy';
  const money = n => `$${(n || 0).toFixed(n < 1 ? 3 : 2)}`;

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2 className="settings-section-title">{name}</h2>
            <div className="settings-section-sub">
              The in-app assistant. Visibility follows the assistant and access settings.
              He uses the key and models from Settings → AI & Comic Book Guy.
            </div>
          </div>
        </div>
        {!form._hasKey && (
          <div className="form-hint a-err a-mb-12">
            No Anthropic API key is set, so he stays hidden. Add one under Settings → AI & Comic Book Guy.
          </div>
        )}
        <div className="settings-two-col">
          <div className="settings-card">
            <div className="settings-card-title">General</div>
            <div className="form-group">
              <label className="form-label a-flex a-ai-c a-gap-8 a-ptr">
                <input type="checkbox" checked={form.assistant_enabled !== 'false'}
                  onChange={e => set('assistant_enabled', e.target.checked ? 'true' : 'false')} />
                Assistant is on
              </label>
              <p className="form-hint">Off hides the button for everyone.</p>
            </div>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" value={form.assistant_name} maxLength={60} onChange={e => set('assistant_name', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Daily questions per user</label>
              <input className="form-input" type="number" min="0" value={form.assistant_daily_limit} style={{ maxWidth: 120 }}
                onChange={e => set('assistant_daily_limit', e.target.value)} />
              <p className="form-hint">0 = no limit. Admins are never limited. Resets at midnight UTC.</p>
            </div>
            <div className="form-group">
              <label className="form-label">Monthly spending cap (USD)</label>
              <input className="form-input" type="number" min="0" step="1" value={form.assistant_monthly_cap} style={{ maxWidth: 120 }}
                onChange={e => set('assistant_monthly_cap', e.target.value)} />
              <p className="form-hint">
                0 = no cap. When the month's estimated cost reaches it, users get a "shop is closed" reply until the 1st; admins keep working.
                {usage?.month_cost != null && <> This month so far: <b>{money(usage.month_cost)}</b>.</>}
              </p>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card-title">Models &amp; web search</div>
            <p className="form-hint a-mt-0">
              His models (Quick Answers, Reading List Generator, Long Answers) are chosen under Settings → AI & Comic Book Guy.
            </p>
            <div className="form-group">
              <label className="form-label a-flex a-ai-c a-gap-8 a-ptr">
                <input type="checkbox" checked={form.assistant_web_search !== 'false'}
                  onChange={e => set('assistant_web_search', e.target.checked ? 'true' : 'false')} />
                Web search for reading orders
              </label>
              <p className="form-hint">Lets him check recent comics past his memory (about 1¢ per search, at most 3 per question). Reading-order model only.</p>
            </div>
          </div>

          <div className="settings-card">
            <div className="settings-card-title">Avatar</div>
            <div className="a-flex a-gap-16 a-ai-c">
              <div className="a-ovh a-noshrink" style={{ width: 84, height: 84, borderRadius: '50%', border: '3px solid var(--adm-g0)', boxShadow: '3px 3px 0 var(--adm-g0)', background: 'var(--td-yellow)' }}>
                <img src={`/api/assistant/avatar?v=${avatarV}`} alt="" className="a-block" style={{ width: '165%', marginLeft: '-32.5%', marginTop: '4%' }} />
              </div>
              <div className="a-flex a-col a-gap-8">
                <label className="adm-btn a-fs-13 a-ptr">
                  {uploading ? 'Uploading…' : 'Upload image'}
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => upload(e.target.files?.[0])} />
                </label>
                <button className="adm-btn adm-btn-ghost a-fs-13" onClick={resetAvatar}>Use default</button>
              </div>
            </div>
            <p className="form-hint">Resized to 512 px. The button zooms in on the top of the image, so a full figure or a head shot both work.</p>
          </div>
        </div>
        <div className="a-flex a-gap-12 a-ai-c a-mt-12">
          <button className="adm-btn adm-btn-primary" onClick={save}>Save</button>
          {saved && <span className="form-hint a-accent">Saved. Users see changes on their next page load.</span>}
          {error && <span className="form-hint a-err">{error}</span>}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2 className="settings-section-title">{compact ? 'Usage & feedback' : 'Usage'}</h2>
            <div className="settings-section-sub">Questions, who asked them and how they were rated. Cost by day, model and task: Usage &amp; results.</div>
          </div>
          <select className="form-input" style={{ width: 'auto' }} value={days} onChange={e => setDays(parseInt(e.target.value, 10))}>
            {[7, 14, 30, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </div>
        {!usage ? <div className="form-hint">Loading…</div> : (
          <>
            <div className="home-stats a-mb-12">
              <div className="home-stat"><div className="home-stat-n">{usage.total.questions}</div><div className="home-stat-l">Questions</div></div>
              <div className="home-stat"><div className="home-stat-n">{money(usage.total.cost)}</div><div className="home-stat-l">Est. cost</div></div>
              <div className="home-stat"><div className="home-stat-n">{usage.total.escalated}</div><div className="home-stat-l">Big model</div></div>
              <div className="home-stat"><div className="home-stat-n">{usage.total.web_searches || 0}</div><div className="home-stat-l">Web searches</div></div>
              <div className="home-stat"><div className="home-stat-n">{usage.total.errors}</div><div className="home-stat-l">Errors</div></div>
            </div>
            {compact && <label className="form-label">Report<select className="form-input" value={report} onChange={e => setReport(e.target.value)}><option value="user">By user</option><option value="feedback">Feedback</option><option value="recent">Recent questions</option></select></label>}
            {(!compact || report === 'user') && <UsageTable title="By user" rows={usage.by_user} money={money} />}
            {(!compact || report === 'feedback') && usage.feedback && <FeedbackCard fb={usage.feedback} />}
            {(!compact || report === 'recent') && usage.recent?.length > 0 && <RecentQuestions rows={usage.recent} money={money} />}
          </>
        )}
      </div>
    </>
  );
}

function UsageTable({ title, rows, money }) {
  return (
    <div className="settings-card">
      <div className="settings-card-title">{title}</div>
      {!rows.length ? <div className="form-hint">No questions yet.</div> : (
        <table className="a-w100 a-fs-13" style={{ borderCollapse: 'collapse' }}>
          <thead><tr className="a-muted a-ta-l"><th>{title.replace('By ', '')}</th><th>Qs</th><th>Err</th><th className="a-ta-r">Est.</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <td className="a-ovh a-ellip a-nowrap" style={{ padding: '4px 6px 4px 0', maxWidth: 180 }}>{r.key}</td>
                <td>{r.questions}</td><td>{r.errors || ''}</td><td className="a-ta-r">{money(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Where the money went: one row per cost component, largest first.
const kTok = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
function RecentQuestions({ rows, money }) {
  const th = { padding: '4px 8px 4px 0', fontWeight: 500 };
  const td = { padding: '4px 8px 4px 0', whiteSpace: 'nowrap' };
  return (
    <div className="settings-card a-mt-12" style={{ overflowX: 'auto' }}>
      <div className="settings-card-title">Recent questions</div>
      <p className="form-hint a-mt-0">One row per question. Calls = model round trips; tokens are summed over all calls.</p>
      <table className="a-w100 a-fs-12" style={{ borderCollapse: 'collapse' }}>
        <thead><tr className="a-muted a-ta-l">
          <th style={th}>When</th><th style={th}>User</th><th style={th}>Type</th><th style={th}>Model</th>
          <th style={th}>Calls</th><th style={th}>Tools</th><th style={th}>Web</th>
          <th style={th} title="Fresh input at full price">Input</th><th style={th}>Cache write</th><th style={th}>Cache read</th><th style={th}>Output</th>
          <th style={{ ...th, textAlign: 'right' }}>Est.</th><th style={th} title="Rating">±</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--border-subtle)', color: r.ok ? undefined : '#ff7a6a' }} title={r.error || ''}>
              <td style={td}>{String(r.at || '').slice(5, 16).replace('T', ' ')}</td>
              <td style={{ ...td, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.user}</td>
              <td style={td}>{r.ok ? (r.kind || '—') + (r.escalated && r.kind !== 'list' ? ' ↑' : '') : 'error'}</td>
              <td style={td}>{String(r.model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '')}</td>
              <td style={td}>{r.calls}</td><td style={td}>{r.tools}</td><td style={td}>{r.web || ''}</td>
              <td style={td}>{kTok(r.input)}</td><td style={td}>{kTok(r.cache_write)}</td><td style={td}>{kTok(r.cache_read)}</td><td style={td}>{kTok(r.output)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{money(r.cost)}</td>
              <td style={td}>{r.rating === 1 ? '👍' : r.rating === -1 ? '👎' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeedbackCard({ fb }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="settings-card a-mt-12">
      <div className="settings-card-title">Feedback · 👍 {fb.up} · 👎 {fb.down}</div>
      {!fb.recent_down?.length ? <div className="form-hint">No thumbs-down yet. Users rate his answers with 👍 / 👎 under each reply; a 👎 sends the question and answer here.</div> : (
        <div className="a-fs-13">
          {fb.recent_down.map(f => (
            <div key={f.usage_id} style={{ borderTop: '1px solid var(--border-subtle)', padding: '6px 0' }}>
              <div className="a-flex a-gap-8 a-ptr" onClick={() => setOpen(o => (o === f.usage_id ? null : f.usage_id))}>
                <span className="a-muted a-nowrap">{String(f.created_at || '').slice(5, 16)} · {f.username || '?'}{f.page ? ` · ${f.page}` : ''}</span>
                <span className="a-grow">{f.question}</span>
                <span className="a-accent">{open === f.usage_id ? '▾' : '▸'}</span>
              </div>
              {open === f.usage_id && <div className="a-prewrap a-mt-6 a-muted">{f.answer}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
