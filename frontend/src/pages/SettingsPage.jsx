import { BrandingEditor } from '../components/BrandingSettings';
import { useConfirm } from '../components/Confirm';
import '../comicSettings.css';
import { Navigate, Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { InfoTip, isAdmin, authHeader } from '../App';
import AssistantSettings from './AssistantSettings';
import AiModelsSettings from './AiModelsSettings';
import CvUsagePanel from './CvUsagePanel';
import BackupsSection from './BackupsSection';
import AdminGroup, { useOpenGroups, AdminGroupStyles } from '../components/AdminGroup';

// ─── Icons ────────────────────────────────────────────────────────
const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
  </svg>
);

const ScanIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/>
    <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/>
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
    <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

// ─── Directory Picker Modal ───────────────────────────────────────
function DirectoryPicker({ onSelect, onClose }) {
  const [currentPath, setCurrentPath] = useState('/comics');
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);

  const browse = useCallback(async (p) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/filesystem/browse?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (!d.error) { setCurrentPath(d.path); setDirs(d.dirs); }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { browse('/comics'); }, [browse]);

  const navigate = (p) => { setHistory(h => [...h, currentPath]); browse(p); };
  const goUp = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    browse(prev);
  };

  return (
    <Modal title="Browse Filesystem" onClose={onClose} width={520}
      footer={<>
          <button className="adm-btn" onClick={() => onSelect(currentPath)}>
            Select: <code className="a-accent a-ml-6 a-fs-11">{currentPath.split('/').pop()}/</code>
          </button>
          <button className="adm-btn adm-btn-ghost" onClick={onClose}>Cancel</button>
      </>}>
      <div className="adm-modal-content">
        <div style={{ padding: '10px 22px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}>
          <code className="a-fs-12 a-accent" style={{ opacity: 0.8 }}>{currentPath}</code>
        </div>

        <div className="a-grow" style={{ overflowY: 'auto', padding: '8px 0' }}>
          {history.length > 0 && (
            <button onClick={goUp} style={pickerRowStyle}>
              <FolderIcon />
              <span style={{ color: 'var(--color-accent)' }}>← Back</span>
            </button>
          )}
          {loading && <div className="a-muted a-ta-c" style={{ padding: 20 }}>Loading…</div>}
          {!loading && dirs.length === 0 && (
            <div className="a-muted a-ta-c a-fs-15" style={{ padding: 20 }}>No subdirectories</div>
          )}
          {dirs.map(d => (
            <div key={d.path} className="a-flex a-ai-c" style={{ padding: '0 8px' }}>
              <button style={pickerRowStyle} onClick={() => navigate(d.path)}>
                <FolderIcon />
                <span className="a-grow a-ta-l">{d.name}</span>
                <span className="a-muted a-fs-12">›</span>
              </button>
              <button
                onClick={() => onSelect(d.path)}
                className="a-noshrink a-ptr a-fs-10 a-fw7 a-ml-6" style={{ background: 'transparent', border: '1px solid var(--border-active)', borderRadius: 3, color: 'var(--color-accent)', padding: '2px 8px', letterSpacing: '0.04em' }}>
                Use
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

const pickerRowStyle = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
  background: 'none', border: 'none', color: 'var(--text-secondary)',
  fontSize: 13, padding: '7px 10px', cursor: 'pointer', borderRadius: 4,
  transition: 'color 0.15s', fontFamily: 'inherit',
};

// ─── Libraries Section ────────────────────────────────────────────
// ─── Users Section ────────────────────────────────────────────────
export function UsersSection() {
  const confirm = useConfirm();
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ username:'', email:'', password:'', role:'user' });
  const [editId, setEditId]     = useState(null);
  const [editForm, setEditForm] = useState({});
  const [msg, setMsg]           = useState('');

  const load = () => {
    setLoading(true);
    fetch('/api/users').then(r => r.json()).then(d => { setUsers(d); setLoading(false); }).catch(() => setLoading(false));
  };
  useEffect(load, []);

  const createUser = async e => {
    e.preventDefault();
    const res = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(form) });
    const d   = await res.json();
    if (!res.ok) { setMsg(`Error: ${d.error}`); return; }
    setMsg('User created'); setShowAdd(false); setForm({ username:'', email:'', password:'', role:'user' }); load();
  };

  const saveEdit = async e => {
    e.preventDefault();
    const res = await fetch(`/api/users/${editId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(editForm) });
    const d   = await res.json();
    if (!res.ok) { setMsg(`Error: ${d.error}`); return; }
    setMsg('Saved'); setEditId(null); setEditForm({}); load();
  };

  const deleteUser = async (id, username) => {
    if (!(await confirm({ message: `Delete user "${username}"? Their read progress will be lost.`, title: 'Delete user?', confirmLabel: 'Delete user', danger: true }))) return;
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    load();
  };

  const fs = { padding:'7px 10px', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:5, color: 'var(--om-text)', fontSize:12, width:'100%', boxSizing:'border-box' };

  return (
    <section style={{ padding:'32px 40px', maxWidth:760 }}>
      <div className="a-flex a-ai-c a-jc-b a-mb-20">
        <div>
          <h2 className="a-m0 a-fs-15 a-text">Users</h2>
          <p className="a-fs-13 a-faint" style={{ margin:'4px 0 0' }}>
            Local accounts and Authentik SSO users. Authentik users are created automatically on first login.
          </p>
        </div>
        <button onClick={() => setShowAdd(s => !s)} className="a-ptr a-fw6 a-fs-12" style={{ padding:'7px 14px', background: 'var(--td-yellow)', color: 'var(--adm-g1)', border:'none', borderRadius:6 }}>
          + Add User
        </button>
      </div>

      {msg && <div className="a-mb-12 a-ok a-fs-12" style={{ padding:'8px 12px', background:'rgba(100,180,100,0.15)', borderRadius:5 }}>{msg}</div>}

      {showAdd && (
        <form onSubmit={createUser} className="a-mb-20 a-grid a-gap-10" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:8, padding:18, gridTemplateColumns:'1fr 1fr' }}>
          <div><label className="a-fs-11 a-muted a-block a-mb-2">Username *</label><input style={fs} value={form.username} onChange={e => setForm(f=>({...f,username:e.target.value}))} required /></div>
          <div><label className="a-fs-11 a-muted a-block a-mb-2">Email</label><input style={fs} type="email" value={form.email} onChange={e => setForm(f=>({...f,email:e.target.value}))} /></div>
          <div><label className="a-fs-11 a-muted a-block a-mb-2">Password *</label><input style={fs} type="password" value={form.password} onChange={e => setForm(f=>({...f,password:e.target.value}))} required /></div>
          <div><label className="a-fs-11 a-muted a-block a-mb-2">Role</label>
            <select style={fs} value={form.role} onChange={e => setForm(f=>({...f,role:e.target.value}))}>
              <option value="user">User</option><option value="admin">Admin</option>
            </select>
          </div>
          <div className="a-flex a-gap-8 a-jc-e a-mt-4" style={{ gridColumn:'1/-1' }}>
            <button type="button" onClick={() => setShowAdd(false)} className="a-text2 a-ptr a-fs-12" style={{ padding:'6px 14px', background:'transparent', border: '1px solid var(--adm-g5)', borderRadius:5 }}>Cancel</button>
            <button type="submit" className="a-ptr a-fw6 a-fs-12" style={{ padding:'6px 14px', background: 'var(--td-yellow)', color: 'var(--adm-g1)', border:'none', borderRadius:5 }}>Create</button>
          </div>
        </form>
      )}

      {loading ? <div className="a-faint a-fs-13">Loading…</div> : (
        <div className="a-flex a-col a-gap-8">
          {users.map(u => (
            <div key={u.id} style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:8, padding:'12px 16px' }}>
              {editId === u.id ? (
                <form onSubmit={saveEdit} className="a-grid a-gap-8" style={{ gridTemplateColumns:'1fr 1fr' }}>
                  <div><label className="a-fs-11 a-muted a-block a-mb-2">Username</label><input style={fs} value={editForm.username||''} onChange={e => setEditForm(f=>({...f,username:e.target.value}))} /></div>
                  <div><label className="a-fs-11 a-muted a-block a-mb-2">Email</label><input style={fs} type="email" value={editForm.email||''} onChange={e => setEditForm(f=>({...f,email:e.target.value}))} /></div>
                  <div><label className="a-fs-11 a-muted a-block a-mb-2">New Password</label><input style={fs} type="password" placeholder="leave blank to keep" value={editForm.password||''} onChange={e => setEditForm(f=>({...f,password:e.target.value}))} /></div>
                  <div><label className="a-fs-11 a-muted a-block a-mb-2">Role</label>
                    <select style={fs} value={editForm.role||u.role} onChange={e => setEditForm(f=>({...f,role:e.target.value}))}>
                      <option value="user">User</option><option value="admin">Admin</option>
                    </select>
                  </div>
                  <div className="a-flex a-gap-8 a-jc-e" style={{ gridColumn:'1/-1' }}>
                    <button type="button" onClick={() => setEditId(null)} className="a-text2 a-ptr a-fs-11" style={{ padding:'5px 12px', background:'transparent', border: '1px solid var(--adm-g5)', borderRadius:5 }}>Cancel</button>
                    <button type="submit" className="a-ptr a-fw6 a-fs-11" style={{ padding:'5px 12px', background: 'var(--td-yellow)', color: 'var(--adm-g1)', border:'none', borderRadius:5 }}>Save</button>
                  </div>
                </form>
              ) : (
                <div className="a-flex a-ai-c a-gap-12">
                  <div className="a-flex a-ai-c a-jc-c a-fs-13 a-fw7 a-noshrink" style={{ width:32, height:32, borderRadius:'50%', background: u.role==='admin' ? 'var(--td-yellow)' : '#3a5a8a', color: u.role==='admin' ? 'var(--om-base)' : 'var(--om-text)' }}>
                    {u.username[0].toUpperCase()}
                  </div>
                  <div className="a-grow a-min0">
                    <div className="a-fs-15 a-text a-fw6">{u.username}
                      {u.authentik_id && <span className="a-ml-8 a-fs-10 a-muted" style={{ background:'rgba(255,255,255,0.07)', padding:'1px 6px', borderRadius:3 }}>SSO</span>}
                    </div>
                    <div className="a-fs-12 a-faint a-mt-0">{u.email || '—'} · {u.role} · last login: {u.last_login ? new Date(u.last_login).toLocaleDateString() : 'never'}</div>
                  </div>
                  <div className="a-flex a-gap-6">
                    <button onClick={() => { setEditId(u.id); setEditForm({ username:u.username, email:u.email||'', role:u.role }); }} className="a-text2 a-ptr a-fs-11" style={{ padding:'4px 10px', background:'transparent', border: '1px solid var(--adm-g5)', borderRadius:5 }}>Edit</button>
                    <button onClick={() => deleteUser(u.id, u.username)} className="a-err a-ptr a-fs-11" style={{ padding:'4px 10px', background:'transparent', border:'1px solid rgba(200,60,60,0.4)', borderRadius:5 }}>Delete</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="a-mt-20 a-fs-12 a-faint" style={{ lineHeight:1.5 }}>
        Default admin credentials: <code className="a-muted">admin / admin</code> — change immediately after first login.
        Authentik SSO users are created automatically on first login and can be promoted to admin here.
      </p>
    </section>
  );
}

export function LibrariesSection({ compact = false, scanRefresh = 0, onCount } = {}) {
  const confirm = useConfirm();
  const [showAll, setShowAll] = useState(false);
  const [libraries, setLibraries]   = useState([]);
  const [scanStatus, setScanStatus] = useState(null);
  const [showAdd, setShowAdd]       = useState(false);
  const [addName, setAddName]       = useState('');
  const [addPath, setAddPath]       = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [scanningId, setScanningId] = useState(null);
  const [cbrStatus, setCbrStatus]   = useState(null); // { running, total, cached, remaining }
  const [cbrRunning, setCbrRunning] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(() => {
    fetch('/api/libraries').then(r => r.json())
      .then(d => setLibraries(Array.isArray(d) ? d : []))
      .catch(console.error);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearInterval(pollRef.current), []);

  const startPoll = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch('/api/scan/status');
        const d = await r.json();
        setScanStatus(d);
        if (!d.running) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setScanningId(null);
          load();
        }
      } catch {}
    }, 800);
  }, [load]);

  useEffect(() => { onCount?.(libraries.length); }, [libraries, onCount]);
  useEffect(() => {
    if (!compact) return;
    let live = true;
    fetch('/api/scan/status').then(r => r.ok ? r.json() : null).then(d => {
      if (!live || !d) return;
      setScanStatus(d);
      if (d.running) startPoll();
    }).catch(() => {});
    return () => { live = false; };
  }, [compact, scanRefresh, startPoll]);

  const fetchCbrStatus = async () => {
    try {
      const d = await fetch('/api/admin/cbr-queue/status').then(r => r.json());
      setCbrStatus(d);
      setCbrRunning(d.running);
    } catch {}
  };

  useEffect(() => { fetchCbrStatus(); }, []);

  const triggerCbrQueue = async () => {
    setCbrRunning(true);
    const d = await fetch('/api/admin/cbr-queue', { method: 'POST' }).then(r => r.json());
    setCbrStatus(s => ({ ...s, running: true }));
    // Poll until done
    const iv = setInterval(async () => {
      const s = await fetch('/api/admin/cbr-queue/status').then(r => r.json());
      setCbrStatus(s);
      setCbrRunning(s.running);
      if (!s.running) clearInterval(iv);
    }, 5000);
  };

  const scanOne = async (lib) => {
    setScanningId(lib.id);
    await fetch(`/api/libraries/${lib.id}/scan`, { method: 'POST' });
    setScanStatus({ running: true, libraryId: lib.id, progress: 0, total: 0, currentPath: '' });
    startPoll();
  };

  const updateInterval = async (lib, hours) => {
    await fetch(`/api/libraries/${lib.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan_interval_hours: parseInt(hours) }),
    });
    load();
  };

  const scanAll = async () => {
    setScanningId('all');
    await fetch('/api/libraries/scan-all', { method: 'POST' });
    setScanStatus({ running: true, libraryId: null, progress: 0, total: 0, currentPath: '' });
    startPoll();
  };

  const deleteLib = async (id) => {
    if (!(await confirm({ message: 'Remove this library from Omnibus?\n\nScanned series will be removed from the database. Files on disk are not touched.', title: 'Remove library?', confirmLabel: 'Remove library', danger: true }))) return;
    await fetch(`/api/libraries/${id}`, { method: 'DELETE' });
    load();
  };

  const addLibrary = async () => {
    if (!addName.trim() || !addPath.trim()) return;
    setSaving(true);
    const r = await fetch('/api/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: addName.trim(), path: addPath.trim() }),
    });
    const d = await r.json();
    setSaving(false);
    if (d.error) { alert(d.error); return; }
    setAddName(''); setAddPath(''); setShowAdd(false);
    load();
    // Kick off initial scan automatically
    setScanningId(d.id);
    await fetch(`/api/libraries/${d.id}/scan`, { method: 'POST' });
    setScanStatus({ running: true, libraryId: d.id, progress: 0, total: 0, currentPath: '' });
    startPoll();
  };

  const isScanning = !!scanStatus?.running;
  const scanPct = scanStatus?.total > 0
    ? Math.round((scanStatus.progress / scanStatus.total) * 100)
    : null;

  // Assign a deterministic color to each library from a palette
  const palette = ['#f5c518', '#6b9ec7', '#a06bb8', '#5aaa7a', '#c96b6b', '#c98c4c'];
  const libColor = (idx) => palette[idx % palette.length];

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Libraries <InfoTip text="Libraries are root folders Omnibus scans for comics. Each subfolder inside a library is treated as a separate series. Add one library per publisher folder (e.g. /comics/DC Comics) or one root library for everything." /></h2>
          <p className="settings-section-sub">Each library is a root folder on disk. The library dropdown in the top bar filters the whole app by library.</p>
        </div>
        <div className="a-flex a-gap-8 a-noshrink">
          {!compact && libraries.length > 0 && (
            <button className="adm-btn" onClick={scanAll} disabled={isScanning}>
              <ScanIcon /> {isScanning && scanningId === 'all' ? 'Scanning…' : 'Scan All'}
            </button>
          )}
          <button className="adm-btn adm-btn-primary" onClick={() => setShowAdd(v => !v)}>
            {showAdd ? 'Cancel' : '+ Add Library'}
          </button>
          {!compact && <button
            className="adm-btn"
            onClick={triggerCbrQueue}
            disabled={cbrRunning}
            title={cbrStatus ? `${cbrStatus.cached}/${cbrStatus.total} series have CBR ratings` : 'Fetch critic scores from Comic Book Roundup'}
          >
            {cbrRunning ? '⏳ Fetching Scores…' : '★ Fetch CBR Scores'}
          </button>}
        </div>
      </div>

      {/* Scan progress */}
      {isScanning && (
        <div className="scan-progress">
          <div className="scan-progress-meta">
            <span className="scan-progress-label">
              {scanStatus.currentPath
                ? scanStatus.currentPath.split('/').slice(-2).join('/')
                : 'Starting…'}
            </span>
            <span className="scan-progress-pct">
              {scanPct !== null ? `${scanStatus.progress} / ${scanStatus.total}` : ''}
            </span>
          </div>
          <div className="scan-track">
            <div className="scan-fill" style={{
              width: scanPct !== null ? `${scanPct}%` : '20%',
              animation: scanPct === null ? 'pulse 1.4s ease-in-out infinite' : 'none',
            }} />
          </div>
          {scanStatus.errors?.length > 0 && (
            <div className="a-mt-6 a-fs-12 a-err">
              ⚠ {scanStatus.errors.length} folder{scanStatus.errors.length > 1 ? 's' : ''} had errors during scan
            </div>
          )}
        </div>
      )}

      {/* Add library form */}
      {showAdd && (
        <div className="add-library-form">
          <div className="form-group">
            <label className="form-label">Library Name</label>
            <input
              className="form-input"
              placeholder="e.g. DC Comics"
              value={addName}
              onChange={e => setAddName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">Root Path</label>
            <div className="a-flex a-gap-8">
              <input
                className="form-input a-grow a-mono a-fs-13"
                placeholder="/comics/DC Comics"
                value={addPath}
                onChange={e => setAddPath(e.target.value)}
              />
              <button className="adm-btn" onClick={() => setShowPicker(true)}>Browse</button>
            </div>
            <p className="form-hint">Container path. A scan starts automatically after adding.</p>
          </div>
          <div className="a-flex a-gap-8 a-mt-4">
            <button
              className="adm-btn adm-btn-primary"
              onClick={addLibrary}
              disabled={saving || !addName.trim() || !addPath.trim()}
              style={{ opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Adding…' : 'Add & Scan'}
            </button>
            <button className="adm-btn adm-btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Library list */}
      {libraries.length === 0 && !showAdd ? (
        <div className="empty-state" style={{ minHeight: 120 }}>
          <div className="empty-icon">📚</div>
          <div className="empty-title">No libraries yet</div>
          <p className="a-fs-13 a-muted">Add a library to start scanning your comics.</p>
        </div>
      ) : (
        <div className="library-list">
          {compact && <div className="library-column-head"><span>Library</span><span>Series</span><span>Auto-scan</span><span>Actions</span></div>}
          {(compact && !showAll && !isScanning ? libraries.slice(0, 3) : libraries).map((lib, idx) => {
            const color = libColor(idx);
            const thisScanning = isScanning && (scanStatus.libraryId === lib.id || scanningId === lib.id || scanningId === 'all');
            return (
              <div key={lib.id} className={`library-row ${thisScanning ? 'library-row--scanning' : ''}`}>
                <div className="library-color-dot" style={{ background: color }} />
                <div className="library-info">
                  <div className="library-name">{lib.name}</div>
                  <code className="library-path">{lib.path}</code>
                </div>
                <div className="library-meta">
                  <span className="library-count">
                    {lib.seriesCount != null ? `${lib.seriesCount} series` : '—'}
                  </span>
                  {/* Scan interval selector */}
                  <select
                    value={lib.scan_interval_hours || 0}
                    onChange={e => updateInterval(lib, e.target.value)}
                    disabled={isScanning}
                    title="Auto-scan frequency"
                    className="a-muted a-fs-12 a-ptr" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 5, padding: '3px 6px', fontFamily: 'inherit' }}>
                    <option value={0}>Manual</option>
                    <option value={3}>Every 3 h</option>
                    <option value={6}>Every 6 h</option>
                    <option value={12}>Every 12 h</option>
                    <option value={24}>Every 24 h</option>
                    <option value={48}>Every 2 d</option>
                    <option value={168}>Every week</option>
                  </select>
                  <button
                    className="adm-btn a-fs-12 a-gap-4"
                    style={{ padding: '4px 10px' }}
                    onClick={() => scanOne(lib)}
                    disabled={isScanning}
                    title="Rescan this library">
                    <ScanIcon /> {thisScanning ? 'Scanning…' : 'Scan'}
                  </button>
                  {compact ? <details className="library-row-menu"><summary aria-label={`Actions for ${lib.name}`}>⋯</summary><button className="adm-btn adm-btn-ghost" onClick={() => deleteLib(lib.id)} disabled={isScanning}>Remove library</button></details> : <button
                    className="adm-btn adm-btn-ghost a-err"
                    style={{ padding: '4px 8px' }}
                    onClick={() => deleteLib(lib.id)}
                    disabled={isScanning}
                    title="Remove library">
                    <TrashIcon />
                  </button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {compact && libraries.length > 3 && !isScanning && <button className="adm-btn adm-btn-ghost library-show-all" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer libraries ▴' : `Show all ${libraries.length} libraries ▾`}</button>}
      {compact && <div className="library-scores"><div><strong>Comic Book Roundup</strong>{cbrStatus && <small>{cbrStatus.cached} of {cbrStatus.total} series have ratings</small>}</div><button className="adm-btn" onClick={triggerCbrQueue} disabled={cbrRunning}>{cbrRunning ? 'Fetching scores…' : 'Fetch scores'}</button></div>}
      {showPicker && (
        <DirectoryPicker
          onSelect={p => { setAddPath(p); setShowPicker(false); }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </section>
  );
}

// ─── Connections Section ──────────────────────────────────────────
export function ConnectionsSection({ compact = false } = {}) {
  const [settings, setSettings] = useState({});
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [testing, setTesting]   = useState({});
  const [results, setResults]   = useState({});

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings);
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // AI key/models are saved by the AI Models tab; never send stale copies.
      body: JSON.stringify(Object.fromEntries(Object.entries(settings).filter(([k]) => !/^(ai_|anthropic_|assistant_(list_)?model$)/.test(k)))),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const test = async (svc, queryString = '') => {
    // queryString: optional querystring (e.g. 'which=comic') so test endpoints
    // can vary their behaviour. Result is keyed by svc + queryString so manga
    // and comic qBit pills don't overwrite each other.
    const resultKey = queryString ? `${svc}?${queryString}` : svc;
    setTesting(t => ({ ...t, [resultKey]: true }));
    const r = await fetch(`/api/settings/test/${svc}${queryString ? '?' + queryString : ''}`);
    const d = await r.json();
    setResults(t => ({ ...t, [resultKey]: d }));
    setTesting(t => ({ ...t, [resultKey]: false }));
  };

  const field = (key, label, type = 'text', hint = '') => (
    <div className="form-group" key={key}>
      <label className="form-label">{label}</label>
      <input
        className="form-input"
        type={type}
        value={settings[key] || ''}
        onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))}
      />
      {hint && <p className="form-hint">{hint}</p>}
    </div>
  );

  const TestPill = ({ svc }) => {
    const r = results[svc];
    if (!r) return null;
    // Three states:
    //   - error  (red)    — r.ok=false, show r.error
    //   - warn   (yellow) — r.ok=true but r.warning is set, show warning
    //   - ok     (green)  — r.ok=true and no warning
    const hasWarning = r.ok && r.warning;
    // qBit comic/manga test: when ok, show "Connected — category ✓, path ✓"
    // so the user sees all three checks passed at a glance.
    let label;
    if (r.ok && (r.expectedCategory || r.expectedCompletedPath)) {
      const parts = [r.version || 'Connected'];
      if (r.categoryExists)        parts.push(`category "${r.expectedCategory}" ✓`);
      if (r.completedPathExists)   parts.push('path ✓');
      label = parts.join(' · ');
    } else if (r.ok) {
      label = r.version || (r.indexers != null ? `${r.indexers} indexers` : 'Connected');
    } else {
      label = r.error || 'Failed';
    }
    const palette = hasWarning
      ? { bg: 'color-mix(in srgb, var(--td-yellow) 12%, transparent)', border: 'color-mix(in srgb, var(--td-yellow) 30%, transparent)', color: 'var(--td-yellow)' }
      : r.ok
      ? { bg: 'rgba(76,170,96,0.12)', border: 'rgba(76,170,96,0.3)', color: '#5acc72' }
      : { bg: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 12%, transparent)', border: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 30%, transparent)', color: 'color-mix(in srgb, var(--td-red) 70%, white)' };
    return (
      <div className="a-flex a-col a-gap-4">
        <span className="a-iflex a-ai-c a-gap-4 a-fs-12" style={{ padding: '3px 8px', borderRadius: 20, background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color, width: 'fit-content' }}>
          {hasWarning ? '⚠' : (r.ok ? <CheckIcon /> : '✗')}
          {label}
        </span>
        {hasWarning && (
          <div className="a-fs-12 a-accent" style={{ lineHeight: 1.4, padding: '4px 8px', background: 'color-mix(in srgb, var(--td-yellow) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--td-yellow) 20%, transparent)', borderRadius: 4, maxWidth: 540 }}>
            {r.warning}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Connections <InfoTip text="API keys and URLs for external services. Values saved here take priority over environment variables." /></h2>
          <p className="settings-section-sub">Service addresses and credentials for metadata and downloads. Save changes before testing a connection.</p>
        </div>
        <button
          className="adm-btn adm-btn-primary a-noshrink"
          onClick={save}
          disabled={saving}
          style={{ opacity: saving ? 0.6 : 1 }}>
          {saved ? <><CheckIcon /> Saved</> : saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      <div className="settings-two-col">
        {/* ComicVine */}
        <div className="settings-card">
          <div className="settings-card-title">ComicVine <InfoTip text="Comic Vine is the metadata source for series info, issue lists, cover art, and character data. Get a free API key at comicvine.gamespot.com/api." position="right" /></div>
          {field('cv_api_key', 'API Key', 'password', 'comicvine.gamespot.com/api → get key')}
          <div className="a-flex a-ai-c a-gap-10 a-mt-4">
            <button className="adm-btn a-fs-13"
              onClick={() => test('comicvine')} disabled={testing.comicvine}>
              {testing.comicvine ? 'Testing…' : 'Test'}
            </button>
            <TestPill svc="comicvine" />
          </div>
        </div>

        {/* Metron: reading lists for the Timeline event generator */}
        <div className="settings-card">
          <div className="settings-card-title">Metron <InfoTip text="Metron (metron.cloud) keeps event reading lists with exact issues, release dates and Comic Vine IDs. The Timeline event generator starts from them when Metron has the event. Get an API token from your Metron account." position="right" /></div>
          {field('metron_api_token', 'API Token', 'password', 'metron.cloud → your account → API token')}
          <div className="a-flex a-ai-c a-gap-10 a-mt-4">
            <button className="adm-btn a-fs-13"
              onClick={() => test('metron')} disabled={testing.metron}>
              {testing.metron ? 'Testing…' : 'Test'}
            </button>
            <TestPill svc="metron" />
          </div>
        </div>

        {/* Anthropic: key and models live on the AI Models tab */}
        {!compact && <div className="settings-card">
          <div className="settings-card-title">AI providers</div>
          <p className="form-hint a-mt-0">Provider keys and AI models are configured in the <a href="/settings?group=ai">AI &amp; Comic Book Guy</a> group.</p>
        </div>}

        {/* Prowlarr */}
        <div className="settings-card">
          <div className="settings-card-title">Prowlarr <InfoTip text="Prowlarr searches your configured indexers for Usenet and comic torrent downloads." position="right" /></div>
          {field('prowlarr_url', 'URL', 'text', 'e.g. http://192.168.1.248:9696')}
          {field('prowlarr_api_key', 'API Key', 'password')}
          <div className="a-flex a-ai-c a-gap-10 a-mt-4">
            <button className="adm-btn a-fs-13"
              onClick={() => test('prowlarr')} disabled={testing.prowlarr}>
              {testing.prowlarr ? 'Testing…' : 'Test'}
            </button>
            <TestPill svc="prowlarr" />
          </div>
        </div>

        {/* SABnzbd */}
        <div className="settings-card">
          <div className="settings-card-title">SABnzbd <InfoTip text="SABnzbd downloads NZB files from Usenet. Completed path is the container path where SABnzbd places finished downloads for Omnibus to process." position="right" /></div>
          {field('sabnzbd_url', 'URL', 'text', 'e.g. http://192.168.1.248:18081')}
          {field('sabnzbd_api_key', 'API Key', 'password')}
          {field('sabnzbd_category', 'Category', 'text', 'e.g. comics')}
          {field('sabnzbd_completed_path', 'Completed Path', 'text', 'Container path where SABnzbd drops finished downloads. Default: /downloads')}
          <div className="a-flex a-ai-c a-gap-10 a-mt-4">
            <button className="adm-btn a-fs-13"
              onClick={() => test('sabnzbd')} disabled={testing.sabnzbd}>
              {testing.sabnzbd ? 'Testing…' : 'Test'}
            </button>
            <TestPill svc="sabnzbd" />
          </div>
        </div>

        {/* qBittorrent — Manga */}
        <div className="settings-card">
          <div className="settings-card-title">qBittorrent (Manga) <InfoTip text="Used for manga torrent downloads from Nyaa. Save path is the host machine path sent to qBittorrent. Completed path is the container path Omnibus reads from after download. The Comics connection uses the same URL, username and password; categories and paths are separate." position="right" /></div>
          {field('qbittorrent_url', 'URL', 'text', 'e.g. http://192.168.1.248:8080')}
          {field('qbittorrent_username', 'Username', 'text')}
          {field('qbittorrent_password', 'Password', 'password')}
          {field('qbittorrent_category', 'Category', 'text', 'e.g. manga')}
          {field('qbittorrent_savepath', 'Save Path (host)', 'text', 'Host path sent to qBittorrent when adding a torrent. e.g. D:\\Downloads\\omnibus-manga or /data/torrents')}
          {field('torrent_completed_path', 'Completed Path (container)', 'text', 'Container path manga post-processor scans. Default: /downloads/torrents')}
          <div className="a-flex a-ai-c a-gap-10 a-mt-4">
            <button className="adm-btn a-fs-13"
              onClick={() => test('qbittorrent', 'which=manga')} disabled={testing['qbittorrent?which=manga']}>
              {testing['qbittorrent?which=manga'] ? 'Testing…' : 'Test'}
            </button>
            <TestPill svc="qbittorrent?which=manga" />
          </div>
        </div>

        {/* qBittorrent — Comics */}
        <div className="settings-card">
          <div className="settings-card-title">qBittorrent (Comics) <InfoTip text="Used for comic torrent downloads from Prowlarr indexers. Connection settings (URL/username/password) come from qBittorrent (Manga) — only the category and paths differ. Use this category in qBittorrent so comic torrents land in their own folder, separate from manga." position="right" /></div>
          {field('qbittorrent_comic_category', 'Category', 'text', 'e.g. comics — must exist in qBittorrent (right-click Categories → Add)')}
          {field('qbittorrent_comic_savepath', 'Save Path (host)', 'text', 'Host path sent to qBittorrent for comic torrents. Often the same path SAB uses, e.g. D:\\Downloads\\omnibus')}
          {field('qbittorrent_comic_completed_path', 'Completed Path (container)', 'text', 'Container path Omnibus reads completed comic torrents from. Often the same as SAB completed_path, e.g. /downloads/omnibus')}
          <div className="a-flex a-ai-c a-gap-10 a-mt-4">
            <button className="adm-btn a-fs-13"
              onClick={() => test('qbittorrent', 'which=comic')} disabled={testing['qbittorrent?which=comic']}>
              {testing['qbittorrent?which=comic'] ? 'Testing…' : 'Test'}
            </button>
            <TestPill svc="qbittorrent?which=comic" />
          </div>
          <p className="form-hint a-mt-8">
            The test verifies the connection, that the configured category exists in qBittorrent, and that the completed path is readable from the Omnibus container.
          </p>
        </div>

        {/* GetComics DDL */}
        <div className="settings-card">
          <div className="settings-card-title">GetComics (DDL) <InfoTip text="GetComics.info is a direct download source. Omnibus scrapes download links and saves files to this path inside the container." position="right" /></div>
          {field('ddl_download_path', 'Download Path', 'text', 'Container path where direct downloads are saved. Default: /downloads/getcomics')}
          <p className="form-hint a-mt-8">
            DDL downloads go directly to this folder inside the container. Make sure it is covered by your <code className="a-fs-13">/downloads</code> volume mount.
          </p>
        </div>
      </div>
    </section>
  );
}

// ─── OIDC / SSO Status Section ───────────────────────────────────
export function OIDCSection() {
  const [status, setStatus] = useState(null);
  const [savingHide, setSavingHide] = useState(false);

  useEffect(() => {
    fetch('/api/auth/oidc-status').then(r => r.json()).then(setStatus).catch(() => setStatus({ configured: false }));
  }, []);

  const setHideLocal = async on => {
    setSavingHide(true);
    try {
      const token = localStorage.getItem('omnibus_token');
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ oidc_hide_local_login: on ? 'true' : 'false' }) });
      if (r.ok) setStatus(s => ({ ...s, hide_local_login: on }));
    } finally { setSavingHide(false); }
  };

  const pill = (ok, label) => (
    <span className="a-iflex a-ai-c a-gap-4 a-fs-12" style={{ padding: '3px 10px', borderRadius: 20, background: ok ? 'rgba(76,170,96,0.12)' : 'rgba(180,180,180,0.08)', border: `1px solid ${ok ? 'rgba(76,170,96,0.3)' : 'rgba(255,255,255,0.1)'}`, color: ok ? '#5acc72' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))' }}>{ok ? '✓' : '○'} {label}</span>
  );

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Single Sign-On (OIDC)</h2>
          <p className="settings-section-sub">
            SSO is configured via environment variables in your <code className="a-accent a-fs-13">.env</code> file
            and takes effect after restarting the container. Compatible with any OIDC provider —
            Authentik, Keycloak, Authelia, Google, and others.
          </p>
        </div>
      </div>

      {!status ? (
        <div className="a-muted a-fs-13">Loading…</div>
      ) : (
        <div className="settings-card" style={{ maxWidth: 480 }}>
          <div className="settings-card-title">SSO Status</div>
          <div className="a-flex a-col a-gap-12">
            <div className="a-flex a-ai-c a-jc-b">
              <span className="a-fs-15 a-text2">SSO configured</span>
              {pill(status.configured, status.configured ? 'Active' : 'Not configured')}
            </div>
            {status.configured && (
              <>
                <div className="a-flex a-ai-c a-jc-b">
                  <span className="a-fs-15 a-text2">Provider base URL</span>
                  <code className="a-fs-12 a-accent a-ovh a-ellip a-nowrap" style={{ maxWidth: 240 }}>{status.base_url}</code>
                </div>
                <div className="a-flex a-ai-c a-jc-b">
                  <span className="a-fs-15 a-text2">Client ID</span>
                  <code className="a-fs-12 a-muted">{status.client_id}</code>
                </div>
                <label className="a-flex a-ai-s a-gap-10 a-ptr a-mt-4">
                  <input type="checkbox" checked={!!status.hide_local_login} disabled={savingHide}
                    onChange={e => setHideLocal(e.target.checked)} className="a-mt-2" />
                  <span>
                    <span className="a-fs-15 a-text2">Show only the SSO button on the login page</span>
                    <span className="a-block a-fs-12 a-muted a-mt-2" style={{ lineHeight: 1.5 }}>
                      Hides the username and password fields. If SSO is ever down, the local sign-in is still at <code>/login?local=1</code>.
                    </span>
                  </span>
                </label>
              </>
            )}
            <p className="a-fs-12 a-muted a-m0" style={{ lineHeight: 1.5 }}>
              {status.configured
                ? 'To change providers, update OIDC_BASE_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in your .env file and restart the container.'
                : 'Set OIDC_BASE_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET in your .env file and restart the container to enable SSO.'}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Post-Processing Section ──────────────────────────────────────
export const namingExample = template => String(template || '').replace(/\$(Series|Issue|Year|Title)/g, (_, key) => ({ Series: 'Secret Wars', Issue: '001', Year: '1984', Title: 'The War Begins!' }[key]));

export function PostProcessingSection({ compact = false } = {}) {
  const [settings, setSettings] = useState({});
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings);
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const field = (key, label, type = 'text', hint = '') => (
    <div className="form-group" key={key}>
      <label className="form-label">{label}</label>
      <input
        className="form-input"
        type={type}
        value={settings[key] || ''}
        onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))}
        style={type === 'text' && key.includes('format') ? { fontFamily: 'Courier Prime, monospace', fontSize: '0.85rem' } : {}}
      />
      {hint && <p className="form-hint">{hint}</p>}
    </div>
  );

  return (
    <section className="settings-section" style={{ borderBottom: 'none' }}>
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Post-Processing <InfoTip text="Controls how downloaded files are renamed and organised after download completes. Variables like $Series and $Year are replaced with actual metadata." /></h2>
          <p className="settings-section-sub">File naming, folder structure, and automation settings.</p>
        </div>
        <button
          className="adm-btn adm-btn-primary a-noshrink"
          onClick={save}
          disabled={saving}
          style={{ opacity: saving ? 0.6 : 1 }}>
          {saved ? <><CheckIcon /> Saved</> : saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      <div className="settings-two-col">
        <div className="settings-card">
          <div className="settings-card-title">File Naming <InfoTip text="Templates for how files and folders are named after download. Variables: $Series (series name), $Issue (zero-padded number), $Year (start year), $Title (issue title)." /></div>
          {field('file_format', 'File Format', 'text', 'Variables: $Series $Issue $Year $Title')}
          {field('folder_format', 'Folder Format', 'text', 'Variables: $Series $Year')}
          {compact && <div className="library-name-example"><small>Example · Secret Wars #1</small><code>{namingExample(settings.folder_format)} / {namingExample(settings.file_format)}.cbz</code></div>}
        </div>
        <div className="settings-card">
          <div className="settings-card-title">Automation <InfoTip text="Controls how often Omnibus checks Comic Vine for new issues on monitored series. Lower values mean more frequent checks but more API usage." /></div>
          {field('downloads_path', 'Downloads Path', 'text', 'Container path where SABnzbd completes files')}
          {field('cv_poll_interval_days', 'CV Poll Interval', 'number', 'Days between Comic Vine checks for new issues')}
        </div>

        {!compact && <div className="settings-card">
          <div className="settings-card-title">Inventory Report <InfoTip text="Exports a flat list of monitored series, events, and Top Shelf canon runs grouped by publisher. Useful for feeding to an AI to identify gaps — 'what major X-Men runs am I missing?' etc." position="right" /></div>
          <p className="form-hint a-mt-0 a-mb-12">
            Download a flat list of everything tracked in Omnibus, grouped by publisher.
            Designed to paste into an AI chat for gap analysis.
          </p>
          <div className="a-flex a-gap-10">
            <InventoryDownloadBtn format="md"  label="↓ Download Markdown" />
            <InventoryDownloadBtn format="json" label="↓ Download JSON" />
          </div>
        </div>}
      </div>
    </section>
  );
}

// ─── Logs Section ────────────────────────────────────────────────
const LOG_LEVEL_COLORS = {
  error: '#cc5050', warn: '#f5c518', info: '#7aaa88', debug: '#555'
};

export function LogsSection() {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter]   = useState('all'); // all | error | warn | info | debug
  const [paused, setPaused]   = useState(false);
  const [search, setSearch]   = useState('');
  const bottomRef = useRef(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    const es = new EventSource('/api/logs/stream?token=' + encodeURIComponent(localStorage.getItem('omnibus_token') || ''));
    es.onmessage = (e) => {
      if (pausedRef.current) return;
      const entry = JSON.parse(e.data);
      setEntries(prev => {
        const next = [...prev, entry];
        return next.length > 500 ? next.slice(-500) : next;
      });
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, paused]);

  const displayed = entries.filter(e => {
    if (filter !== 'all' && e.level !== filter) return false;
    if (search && !`${e.category} ${e.message}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <section className="settings-section" style={{ borderBottom: 'none' }}>
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Live Logs</h2>
          <p className="settings-section-sub">Real-time server log stream. Last 500 entries.</p>
        </div>
        <div className="a-flex a-gap-8 a-ai-c a-noshrink">
          <button
            onClick={() => setPaused(p => !p)}
            className="a-ptr a-fs-12" style={{ padding: '6px 14px', borderRadius: 5, border: '1px solid var(--adm-g4)', background: paused ? 'color-mix(in srgb, var(--om-base) 90%, white)' : 'transparent', color: paused ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))' }}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button
            onClick={() => setEntries([])}
            className="a-faint a-ptr a-fs-12" style={{ padding: '6px 14px', borderRadius: 5, border: '1px solid var(--adm-g4)', background: 'transparent' }}>
            Clear
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="a-flex a-gap-8 a-mb-10 a-wrap a-ai-c">
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Filter by category or message…"
          className="a-grow a-text2 a-fs-12" style={{ minWidth: 180, padding: '5px 10px', background: 'var(--adm-g0)', border: '1px solid var(--adm-g3)', borderRadius: 5 }}
        />
        {['all','error','warn','info','debug'].map(l => (
          <button key={l} onClick={() => setFilter(l)} className="a-fs-11 a-ptr" style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid', borderColor: filter === l ? (LOG_LEVEL_COLORS[l] || 'var(--td-yellow)') : 'color-mix(in srgb, var(--om-base) 90%, white)', background: filter === l ? `${LOG_LEVEL_COLORS[l] || 'var(--td-yellow)'}22` : 'transparent', color: filter === l ? (LOG_LEVEL_COLORS[l] || 'var(--td-yellow)') : 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))' }}>{l}</button>
        ))}
        <span className="a-dim a-fs-11 a-ml-auto">{displayed.length} entries</span>
      </div>

      {/* Log output */}
      <div className="a-mono a-fs-11" style={{ background: 'var(--adm-g0)', border: '1px solid var(--adm-g1)', borderRadius: 6, height: 480, overflowY: 'auto' }}>
        {displayed.length === 0 && (
          <div className="a-dim a-ta-c" style={{ padding: 20 }}>No log entries yet — events will appear here in real-time.</div>
        )}
        {displayed.map((entry, i) => (
          <div key={i} className="a-flex a-gap-10" style={{ padding: '3px 12px', borderBottom: '1px solid var(--adm-g1)', background: entry.level === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--om-base) 90%, black) 27%, transparent)' : 'transparent' }}>
            <span className="a-dim a-noshrink" style={{ minWidth: 170 }}>{entry.ts}</span>
            <span className="a-noshrink" style={{ color: LOG_LEVEL_COLORS[entry.level] || 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))', minWidth: 50, fontWeight: entry.level === 'error' || entry.level === 'warn' ? 700 : 400 }}>
              {entry.level?.toUpperCase()}
            </span>
            <span className="a-noshrink" style={{ color: '#5a8a6a', minWidth: 100 }}>[{entry.category}]</span>
            <span className="a-text2 a-grow a-breakword">
              {entry.message}
              {entry.data && <span className="a-faint a-ml-6">{typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}</span>}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

// ─── Publisher Section ────────────────────────────────────────────
export function PublisherSection() {
  const confirm = useConfirm();
  const [publishers, setPublishers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [newPubName, setNewPubName] = useState('');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');

  // Only the first load shows "Loading…"; reloads after an edit keep the list mounted so the page doesn't jump to the top.
  const load = () => {
    fetch('/api/publishers').then(r => r.json()).then(d => { setPublishers(d); setLoading(false); }).catch(() => setLoading(false));
  };
  useEffect(load, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const addPublisher = async () => {
    if (!newPubName.trim()) return;
    await fetch('/api/publishers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publisher: newPubName }) });
    setNewPubName(''); setAdding(false); load();
  };

  const deletePublisher = async (id, name) => {
    if (!(await confirm({ message: `Delete publisher "${name}" and all its eras/imprints?`, title: 'Delete publisher?', confirmLabel: 'Delete publisher', danger: true }))) return;
    await fetch(`/api/publishers/${id}`, { method: 'DELETE' });
    load();
  };

  const toggleFolder = async (pub) => {
    await fetch(`/api/publishers/${pub.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ use_folder_detection: !pub.use_folder_detection }) });
    load();
  };

  const addEra = async (pubId, name, startYear, endYear, folder = null) => {
    if (!name.trim()) return;
    await fetch(`/api/publishers/${pubId}/eras`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, start_year: startYear || null, end_year: endYear || null, folder }) });
    load(); flash('Era added');
  };

  const deleteEra = async (pubId, eraId) => {
    await fetch(`/api/publishers/${pubId}/eras/${eraId}`, { method: 'DELETE' });
    load();
  };

  const updateEra = async (pubId, era, changes) => {
    const body = { name: era.name, start_year: era.start_year, end_year: era.end_year, sort_order: era.sort_order ?? 0, folder: era.folder, ...changes };
    if (!body.name || !String(body.name).trim()) return false;
    const r = await fetch(`/api/publishers/${pubId}/eras/${era.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { flash('Era update failed'); return false; }
    load(); flash('Era updated');
    return true;
  };

  const addImprint = async (pubId, pattern, name) => {
    if (!pattern.trim() || !name.trim()) return;
    await fetch(`/api/publishers/${pubId}/imprints`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern, name }) });
    load(); flash('Imprint added');
  };

  const deleteImprint = async (pubId, impId) => {
    await fetch(`/api/publishers/${pubId}/imprints/${impId}`, { method: 'DELETE' });
    load();
  };

  const addSkipPattern = async (pubId, pattern) => {
    if (!pattern.trim()) return;
    await fetch(`/api/publishers/${pubId}/skip-patterns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern }) });
    load(); flash('Skip pattern added');
  };

  const deleteSkipPattern = async (pubId, patId) => {
    await fetch(`/api/publishers/${pubId}/skip-patterns/${patId}`, { method: 'DELETE' });
    load();
  };

  const is = { padding: '5px 8px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: 'var(--om-text)', fontSize: 12, flex: 1 };
  const btn = (color='#f5c518') => ({ padding: '4px 10px', background: 'transparent', border: `1px solid ${color}44`, color, borderRadius: 4, cursor: 'pointer', fontSize: 11 });

  return (
    <section className="settings-section" style={{ borderBottom: 'none' }}>
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Publishers & Eras <InfoTip text="Configure publisher era definitions used by the metadata enricher and the directory suggestion system when adding monitored series. Each publisher can have era year ranges, imprint folder mappings, and folders to skip." /></h2>
          <p className="settings-section-sub">
            Configure publisher era definitions for metadata enrichment. Eras are detected by year range (primary).
            Enable folder detection per publisher if your folder structure encodes era names.
          </p>
        </div>
        <button onClick={() => setAdding(a => !a)} className="a-ptr a-fw6 a-fs-12" style={{ padding: '7px 14px', background: 'var(--td-yellow)', color: 'var(--adm-g1)', border: 'none', borderRadius: 6 }}>
          + Add Publisher
        </button>
      </div>

      {msg && <div className="a-mb-12 a-ok a-fs-12" style={{ padding: '7px 12px', background: 'rgba(100,180,100,0.12)', borderRadius: 5 }}>{msg}</div>}

      {adding && (
        <div className="a-flex a-gap-8 a-mb-16 a-ai-c">
          <input style={{ ...is, flex: 1 }} placeholder="Publisher name (e.g. DC Comics)" value={newPubName} onChange={e => setNewPubName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addPublisher()} />
          <button style={btn()} onClick={addPublisher}>Add</button>
          <button style={btn('color-mix(in srgb, var(--om-text) 55%, var(--om-base))')} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}

      {loading ? <div className="a-faint a-fs-13">Loading…</div> : (
        <div className="a-flex a-col a-gap-12">
          {publishers.length === 0 && <div className="a-faint a-fs-13">No publishers configured. Add one to enable era detection.</div>}
          {publishers.map(pub => {
            const open = expanded[pub.id];
            return (
              <div key={pub.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
                {/* Publisher header */}
                <div className="a-flex a-ai-c a-gap-12 a-ptr" style={{ padding: '12px 16px' }} onClick={() => setExpanded(e => ({ ...e, [pub.id]: !open }))}>
                  <span className="a-fs-15 a-fw6 a-text a-grow">{pub.publisher}</span>
                  <span className="a-fs-11 a-faint">{pub.eras.length} eras · {pub.imprints.length} imprints</span>
                  <label className="a-flex a-ai-c a-gap-6 a-fs-11 a-muted a-ptr" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={pub.use_folder_detection} onChange={() => toggleFolder(pub)} />
                    Folder detection <InfoTip text="When enabled, era is matched by looking for the era's folder name in the series path. When disabled, era is determined by the series start year matching a year range. Folder detection fires first; year ranges are used as fallback." position="left" width={260} />
                  </label>
                  <button style={btn('#c06060')} onClick={e => { e.stopPropagation(); deletePublisher(pub.id, pub.publisher); }}>Delete</button>
                  <span className="a-faint a-fs-12">{open ? '▲' : '▼'}</span>
                </div>

                {open && (
                  <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '16px' }}>
                    <BrandingEditor kind="publisher" name={pub.publisher} />
                    {/* Eras */}
                    <EraEditor pub={pub} onAddEra={addEra} onDeleteEra={deleteEra} onUpdateEra={updateEra} />
                    {/* Imprints */}
                    <ImprintEditor pub={pub} onAddImprint={addImprint} onDeleteImprint={deleteImprint} />
                    {/* Skip patterns */}
                    <SkipPatternEditor pub={pub} onAdd={addSkipPattern} onDelete={deleteSkipPattern} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EraRow({ pub, era, is, onDeleteEra, onUpdateEra }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({});
  const start = () => { setF({ name: era.name || '', start_year: era.start_year ?? '', end_year: era.end_year ?? '', folder: era.folder || '' }); setEditing(true); };
  const save = async () => {
    const ok = await onUpdateEra(pub.id, era, {
      name: f.name.trim(),
      start_year: f.start_year === '' ? null : parseInt(f.start_year),
      end_year: f.end_year === '' ? null : parseInt(f.end_year),
      folder: f.folder.trim() || null,
    });
    if (ok) setEditing(false);
  };
  const btn = (color) => ({ padding: '2px 8px', background: 'transparent', border: `1px solid ${color}44`, color, borderRadius: 3, cursor: 'pointer', fontSize: 10 });
  if (editing) return (
    <div className="a-flex a-ai-c a-gap-6 a-mb-6 a-wrap"
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}>
      <input style={{ ...is, flex: 2, minWidth: 100 }} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus />
      <input style={{ ...is, width: 64 }} type="number" placeholder="From" value={f.start_year} onChange={e => setF({ ...f, start_year: e.target.value })} />
      <input style={{ ...is, width: 64 }} type="number" placeholder="To" value={f.end_year} onChange={e => setF({ ...f, end_year: e.target.value })} />
      <input style={{ ...is, flex: 3, minWidth: 140 }} placeholder="Folder name" value={f.folder} onChange={e => setF({ ...f, folder: e.target.value })} />
      <button style={btn('var(--td-yellow)')} onClick={save}>Save</button>
      <button style={btn('color-mix(in srgb, var(--om-text) 55%, var(--om-base))')} onClick={() => setEditing(false)}>Cancel</button>
    </div>
  );
  return (
    <div className="a-flex a-ai-c a-gap-8 a-mb-6">
      <span className="a-fs-13 a-text2" style={{ flex: 2 }}>{era.name}</span>
      <span className="a-fs-11 a-faint" style={{ minWidth: 80 }}>{era.start_year || '—'} → {era.end_year || '—'}</span>
      {era.folder && <span className="a-fs-11 a-faint a-mono a-ovh a-ellip a-nowrap" style={{ maxWidth: 180 }} title={era.folder}>📁 {era.folder}</span>}
      <button style={{ ...btn('var(--td-yellow)'), marginLeft: 'auto' }} title="Edit era" onClick={start}>✎</button>
      <button style={btn('#c06060')} title="Delete era" onClick={() => onDeleteEra(pub.id, era.id)}>✕</button>
    </div>
  );
}

function EraEditor({ pub, onAddEra, onDeleteEra, onUpdateEra }) {
  const [name, setName] = useState('');
  const [startYear, setStartYear] = useState('');
  const [endYear, setEndYear] = useState('');
  const [folder, setFolder] = useState('');
  const is = { padding: '4px 7px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: 'var(--om-text)', fontSize: 12 };
  return (
    <div className="a-mb-16">
      <div className="a-fs-11 a-upper a-accent a-mb-4" style={{ letterSpacing: '0.1em' }}>Eras (year-range based)</div>
      <p className="a-fs-11 a-faint a-mb-8" style={{ lineHeight: 1.5 }}>
        Year ranges are inclusive. To avoid overlap between adjacent eras, end one year before the next starts (e.g. Post-Crisis ends 2010, New 52 starts 2011). Leave year fields blank when using folder detection. The <strong className="a-muted">Folder</strong> field is the actual folder name on disk — used for directory suggestions when adding monitored series and for folder detection.
      </p>
      {pub.eras.length === 0 && <div className="a-fs-12 a-faint a-mb-8">No eras defined.</div>}
      {pub.eras.map(era => <EraRow key={era.id} pub={pub} era={era} is={is} onDeleteEra={onDeleteEra} onUpdateEra={onUpdateEra} />)}
      <div className="a-flex a-gap-6 a-mt-8 a-wrap">
        <input style={{ ...is, flex: 2, minWidth: 100 }} placeholder="Era name" value={name} onChange={e => setName(e.target.value)} />
        <input style={{ ...is, width: 64 }} placeholder="From" type="number" value={startYear} onChange={e => setStartYear(e.target.value)} />
        <input style={{ ...is, width: 64 }} placeholder="To" type="number" value={endYear} onChange={e => setEndYear(e.target.value)} />
        <input style={{ ...is, flex: 3, minWidth: 140 }} placeholder="Folder name (e.g. 4. DC Rebirth)" value={folder} onChange={e => setFolder(e.target.value)} />
        <button className="a-accent a-ptr a-fs-11" style={{ padding: '4px 10px', background: 'transparent', border: '1px solid color-mix(in srgb, var(--td-yellow) 27%, transparent)', borderRadius: 4 }}
          onClick={() => {
            onAddEra(pub.id, name, startYear ? parseInt(startYear) : null, endYear ? parseInt(endYear) : null, folder.trim() || null);
            setName(''); setStartYear(''); setEndYear(''); setFolder('');
          }}>
          Add
        </button>
      </div>
    </div>
  );
}

function ImprintEditor({ pub, onAddImprint, onDeleteImprint }) {
  const [pattern, setPattern] = useState('');
  const [name, setName] = useState('');
  const is = { padding: '4px 7px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: 'var(--om-text)', fontSize: 12 };
  return (
    <div className="a-mb-16">
      <div className="a-fs-11 a-upper a-accent a-mb-8" style={{ letterSpacing: '0.1em' }}>Imprints (folder pattern → imprint name)</div>
      {pub.imprints.length === 0 && <div className="a-fs-12 a-faint a-mb-8">No imprints defined.</div>}
      {pub.imprints.map(imp => (
        <div key={imp.id} className="a-flex a-ai-c a-gap-8 a-mb-6">
          <span className="a-fs-12 a-muted a-mono">{imp.pattern}</span>
          <span className="a-fs-12 a-text2">→ {imp.name}</span>
          <button className="a-err a-ptr a-fs-10 a-ml-auto" style={{ padding: '2px 8px', background: 'transparent', border: '1px solid #c0606044', borderRadius: 3 }} onClick={() => onDeleteImprint(pub.id, imp.id)}>✕</button>
        </div>
      ))}
      <div className="a-flex a-gap-6 a-mt-8">
        <input style={{ ...is, flex: 1 }} placeholder="Folder pattern (e.g. Black Label)" value={pattern} onChange={e => setPattern(e.target.value)} />
        <input style={{ ...is, flex: 1 }} placeholder="Imprint name" value={name} onChange={e => setName(e.target.value)} />
        <button className="a-accent a-ptr a-fs-11" style={{ padding: '4px 10px', background: 'transparent', border: '1px solid color-mix(in srgb, var(--td-yellow) 27%, transparent)', borderRadius: 4 }}
          onClick={() => { onAddImprint(pub.id, pattern, name); setPattern(''); setName(''); }}>
          Add
        </button>
      </div>
    </div>
  );
}

function SkipPatternEditor({ pub, onAdd, onDelete }) {
  const [pattern, setPattern] = useState('');
  const is = { padding: '4px 7px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: 'var(--om-text)', fontSize: 12 };
  return (
    <div>
      <div className="a-fs-11 a-upper a-accent a-mb-8" style={{ letterSpacing: '0.1em' }}>Skip Patterns (folders to exclude from enrichment)</div>
      {pub.skip_patterns.length === 0 && <div className="a-fs-12 a-faint a-mb-8">No skip patterns defined.</div>}
      {pub.skip_patterns.map((p) => (
        <div key={p.id} className="a-flex a-ai-c a-gap-8 a-mb-6">
          <span className="a-fs-12 a-muted a-mono a-grow">{p.pattern}</span>
          <button className="a-err a-ptr a-fs-10" style={{ padding: '2px 8px', background: 'transparent', border: '1px solid #c0606044', borderRadius: 3 }} onClick={() => onDelete(pub.id, p.id)}>✕</button>
        </div>
      ))}
      <div className="a-flex a-gap-6 a-mt-8">
        <input style={{ ...is, flex: 1 }} placeholder="Pattern to skip (e.g. Events and Crossovers)" value={pattern} onChange={e => setPattern(e.target.value)} />
        <button className="a-accent a-ptr a-fs-11" style={{ padding: '4px 10px', background: 'transparent', border: '1px solid color-mix(in srgb, var(--td-yellow) 27%, transparent)', borderRadius: 4 }}
          onClick={() => { onAdd(pub.id, pattern); setPattern(''); }}>
          Add
        </button>
      </div>
    </div>
  );
}

// ─── Weekly Releases Section ──────────────────────────────────────
export function WeeklySection() {
  const [excluded, setExcluded] = useState([]);
  const [newPub, setNewPub]     = useState('');
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      try { setExcluded(JSON.parse(s.weekly_excluded_publishers || '[]')); } catch {}
    });
  }, []);

  const save = async (list) => {
    setSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weekly_excluded_publishers: JSON.stringify(list) }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const add = () => {
    const t = newPub.trim();
    if (!t || excluded.some(e => e.toLowerCase() === t.toLowerCase())) return;
    const next = [...excluded, t];
    setExcluded(next);
    setNewPub('');
    save(next);
  };

  const remove = (pub) => {
    const next = excluded.filter(e => e !== pub);
    setExcluded(next);
    save(next);
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Weekly Releases</h2>
          <p className="settings-section-sub">
            Publishers excluded here are hidden from the weekly releases tab entirely.
            Useful for filtering out foreign reprint publishers (Panini), digital platforms (Webtoon),
            or any other noisy source that causes false matches.
          </p>
        </div>
        {saved && <span className="a-fs-12 a-accent" style={{ alignSelf: 'flex-start', paddingTop: 6 }}>&#10003; Saved</span>}
      </div>
      <div style={{ padding: '0 4px' }}>
        <div className="a-fs-12 a-muted a-mb-10">
          Each entry is a case-insensitive substring match against the publisher name.
          E.g. "Panini" blocks "Panini Comics", "Panini Deutschland", etc.
        </div>
        <div className="a-flex a-wrap a-gap-8 a-mb-12">
          {excluded.map(pub => (
            <span key={pub} className="a-iflex a-ai-c a-gap-6 a-fs-12 a-text" style={{ background: 'var(--adm-g2)', border: '1px solid var(--adm-g4)', borderRadius: 20, padding: '4px 10px 4px 12px' }}>
              {pub}
              <button onClick={() => remove(pub)} className="a-ptr a-faint a-fs-13" style={{ background: 'none', border: 'none', lineHeight: 1, padding: 0 }} title="Remove">×</button>
            </span>
          ))}
          {excluded.length === 0 && (
            <span className="a-fs-12 a-faint a-italic">No publishers excluded</span>
          )}
        </div>
        <div className="a-flex a-gap-8 a-ai-c">
          <input
            value={newPub}
            onChange={e => setNewPub(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && add()}
            placeholder="Publisher name or substring…"
            className="a-text a-fs-13" style={{ background: 'var(--adm-g2)', border: '1px solid var(--adm-g4)', borderRadius: 6, padding: '7px 12px', width: 260 }}
          />
          <button
            onClick={add}
            disabled={!newPub.trim() || saving}
            className="a-fs-13 a-ptr a-fw6" style={{ background: 'var(--td-yellow)', border: 'none', borderRadius: 6, color: 'var(--adm-g0)', padding: '7px 16px', opacity: !newPub.trim() || saving ? 0.5 : 1 }}
          >Add</button>
        </div>
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────
// ─── Access Control Section ───────────────────────────────────────
export function AccessControlSection() {
  const [settings, setSettings] = useState({});
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings);
  }, []);

  const save = async () => {
    setSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const toggle = (key) => setSettings(s => ({ ...s, [key]: s[key] === 'true' ? 'false' : 'true' }));

  const Toggle = ({ settingKey, label, hint }) => (
    <div className="a-flex a-ai-s a-jc-b a-gap-16" style={{ padding: '12px 0', borderBottom: '1px solid var(--adm-g2)' }}>
      <div>
        <div className="a-fs-13 a-text a-fw5 a-mb-2">{label}</div>
        {hint && <div className="a-fs-12 a-faint" style={{ lineHeight: 1.5 }}>{hint}</div>}
      </div>
      <button
        onClick={() => toggle(settingKey)}
        className="a-noshrink a-ptr a-rel" style={{ width: 40, height: 22, borderRadius: 11, border: 'none', background: settings[settingKey] === 'true' ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-base) 90%, white)', transition: 'background 0.2s' }}>
        <span style={{
          position: 'absolute', top: 3, left: settings[settingKey] === 'true' ? 20 : 3,
          width: 16, height: 16, borderRadius: '50%', background: 'var(--om-text)', transition: 'left 0.2s',
        }} />
      </button>
    </div>
  );

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Access Control</h2>
          <p className="settings-section-sub">Control which features are visible, and to whom.</p>
        </div>
        <button className="adm-btn adm-btn-primary a-noshrink" onClick={save} disabled={saving} style={{ opacity: saving ? 0.6 : 1 }}>
          {saved ? <>&#10003; Saved</> : saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
      <div style={{ padding: '0 4px' }}>
        <Toggle
          settingKey="download_manager_admin_only"
          label="Restrict Download Manager to admins"
          hint="When enabled, the Downloads page and nav item are hidden from non-admin users. Admins always have access."
        />
      </div>
    </section>
  );
}

export function InventoryDownloadBtn({ format, label }) {
  const [loading, setLoading] = React.useState(false);
  const download = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reports/inventory?format=${format}`);
      if (!r.ok) throw new Error(`Server error: ${r.status}`);
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href     = url;
      a.download = `omnibus-inventory-${today}.${format === 'json' ? 'json' : 'md'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    }
    setLoading(false);
  };
  return (
    <button
      className="adm-btn a-fs-13"
      onClick={download}
      disabled={loading}
    >
      {loading ? '⏳ Generating…' : label}
    </button>
  );
}

// ─── Restart (System group) ───────────────────────────────────────
// Backend cancels active downloads, responds 202, then exits; Docker's restart
// policy brings it back. The connection drop is expected.
export function RestartSection() {
  const confirm = useConfirm();
  const [restarting, setRestarting] = useState(false);
  const restart = async () => {
    if (!(await confirm({ message: 'Restart Omnibus? Any in-progress downloads will be cancelled. The page will be unreachable for a few seconds.', title: 'Restart Omnibus?', confirmLabel: 'Restart', danger: true }))) return;
    setRestarting(true);
    try { await fetch('/api/admin/restart', { method: 'POST' }); } catch {}
  };
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Restart</h2>
          <p className="settings-section-sub">Restart the Omnibus container. Active downloads are cancelled; the page is unreachable for a few seconds.</p>
        </div>
        <button className="adm-btn a-noshrink a-err" onClick={restart} disabled={restarting}
          style={{ opacity: restarting ? 0.6 : 1, borderColor: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 30%, transparent)' }}>
          {restarting ? '⏳ Restarting… reload in a few seconds' : '↻ Restart App'}
        </button>
      </div>
    </section>
  );
}

// ─── SettingsPage ─────────────────────────────────────────────────
// Set-once configuration in four groups that open in place (2026-10-16
// reorganization, claude/ADMIN_REORG.md). Library work moved to the Library
// page; appearance moved to the account menu. Old ?tab= links still land.
const OLD_TABS = { ai: 'ai', assistant: 'ai', users: 'people', logs: 'system', backups: 'backups' };
const MOVED_TABS = {
  publishers: '/library?group=publishers',
  'no-metadata': '/library?group=series',
  'no-cv-id': '/library?group=metadata&view=unidentified',
};

export default function SettingsPage() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  // Every group starts closed so all of them are visible at once (user,
  // 2026-10-16); an old ?tab= link opens its group.
  const [open, toggle] = useOpenGroups(OLD_TABS[tab] ? [OLD_TABS[tab]] : []);
  if (tab && MOVED_TABS[tab]) return <Navigate to={MOVED_TABS[tab]} replace />;
  const group = (id, title, sub, children) => (
    <AdminGroup id={id} title={title} sub={sub} open={open.has(id)} onToggle={toggle}>{children}</AdminGroup>
  );
  return (
    <div className="settings-page comic-settings">
      <PageHeader title="SETTINGS" borderSeed={0}>
        <span className="settings-admin-label">Administration</span>
      </PageHeader>
      <div className="settings-page-body admin-groups">
        <p className="admin-groups-note">
          Manage folders, scans and metadata in <Link to="/library">Library</Link>.
        </p>
        {group('connections', 'Connections', 'Metadata and download services · connection tests · Comic Vine usage', <><ConnectionsSection compact /><CvUsagePanel /></>)}
        {group('ai', 'AI & Comic Book Guy', 'Provider keys, model choices, assistant behaviour and usage', <AiModelsSettings compact><details className="ai-disclosure"><summary><strong>Comic Book Guy</strong><span>Assistant, limits, avatar &amp; usage</span></summary><AssistantSettings compact /></details></AiModelsSettings>)}
        {group('people', 'People', 'Users, access control and single sign-on', <><UsersSection /><AccessControlSection /><OIDCSection /></>)}
        {group('backups', 'Backups', 'Nightly database backups, a second copy, restore · API key encryption', <BackupsSection />)}
        {group('system', 'System', 'Restart and live logs', <><RestartSection /><LogsSection /></>)}
      </div>
      <SettingsStyles />
    </div>
  );
}

// Section styles, shared with the Library page.
export function SettingsStyles() {
  return (
    <>
      <AdminGroupStyles />
      <style>{`
        .settings-page {
          padding: 0;
        }
        .settings-page-header {
          padding: 32px 40px 24px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .settings-page-title {
          font-family: 'Boogaloo', cursive;
          font-size: 1.9rem;
          font-weight: 900;
          color: var(--text-primary);
          margin-bottom: 4px;
        }
        .settings-page-sub {
          color: var(--text-muted);
          font-size: 0.9rem;
        }
        .settings-page-body {
          max-width: 860px;
          padding: 0 40px 60px;
        }

        /* Section */
        .settings-section {
          padding: 32px 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .settings-section-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 20px;
          margin-bottom: 22px;
        }
        .settings-section-title {
          font-family: 'Boogaloo', cursive;
          font-size: 1.15rem;
          font-weight: 700;
          color: var(--color-accent);
          margin-bottom: 4px;
        }
        .settings-section-sub {
          font-size: 0.85rem;
          color: var(--text-muted);
          line-height: 1.5;
          max-width: 480px;
        }

        /* Two-col card grid */
        .settings-two-col {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        @media (max-width: 680px) {
          .settings-two-col { grid-template-columns: 1fr; }
        }
        .settings-card {
          background: var(--bg-card);
          border: 1px solid var(--border-subtle);
          border-radius: 8px;
          padding: 18px 20px;
        }
        .settings-card-title {
          font-family: 'Courier Prime', monospace;
          font-size: 0.7rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--color-primary);
          margin-bottom: 16px;
        }

        /* Form helpers */
        .form-hint {
          font-size: 0.76rem;
          color: var(--text-muted);
          margin-top: 4px;
          line-height: 1.4;
        }

        /* Scan progress */
        .scan-progress {
          background: var(--bg-card);
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
          padding: 14px 16px;
          margin-bottom: 16px;
        }
        .scan-progress-meta {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .scan-progress-label {
          font-family: 'Courier Prime', monospace;
          font-size: 0.78rem;
          color: var(--text-secondary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 80%;
        }
        .scan-progress-pct {
          font-family: 'Courier Prime', monospace;
          font-size: 0.78rem;
          color: var(--color-primary);
          flex-shrink: 0;
        }
        .scan-track {
          height: 3px;
          background: var(--bg-elevated);
          border-radius: 2px;
          overflow: hidden;
        }
        .scan-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--color-primary), var(--color-accent));
          border-radius: 2px;
          transition: width 0.4s ease;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        /* Add library form */
        .add-library-form {
          background: var(--bg-card);
          border: 1px solid var(--border-active);
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 16px;
          animation: slideUp 180ms var(--ease);
        }

        /* Library list */
        .library-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .library-row {
          display: flex;
          align-items: center;
          gap: 14px;
          background: var(--bg-card);
          border: 1px solid var(--border-subtle);
          border-radius: 8px;
          padding: 14px 16px;
          transition: border-color 0.2s;
        }
        .library-row--scanning {
          border-color: color-mix(in srgb, var(--td-yellow) 35%, transparent);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--td-yellow) 8%, transparent);
        }
        .library-color-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
          box-shadow: 0 0 6px currentColor;
        }
        .library-info {
          flex: 1;
          min-width: 0;
        }
        .library-name {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 3px;
        }
        .library-path {
          font-family: 'Courier Prime', monospace;
          font-size: 0.75rem;
          color: var(--text-muted);
          display: block;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .library-meta {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-shrink: 0;
        }
        .library-count {
          font-size: 0.82rem;
          color: var(--text-muted);
          white-space: nowrap;
        }
      `}</style>
    </>
  );
}
