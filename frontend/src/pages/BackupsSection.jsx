// ─── Settings › Backups (user 2026-11-02) ────────────────────────────────────
// Nightly database backups (backend/backups.js): back up now, a second folder
// on another drive, pin, and restore (applied when Omnibus restarts). Also
// shows whether the stored API keys are encrypted (backend/secrets.js).
import React, { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '../components/Confirm';
import '../backupsSection.css';

const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
};
const mb = b => (b == null ? '' : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${(b / 1048576).toFixed(0)} MB`);
const when = iso => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
const KIND = { omnibus: 'Nightly', pinned: 'Pinned', 'before-restore': 'Before restore' };

function BackupList({ where, files, busy, onPin, onRestore }) {
  if (!files.length) return <p className="bk-empty">No backups here yet.</p>;
  return (
    <table className="bk-table">
      <thead><tr><th>Taken</th><th>Kind</th><th>Size</th><th aria-label="Actions" /></tr></thead>
      <tbody>{files.map(f => (
        <tr key={f.file}>
          <td title={f.file}>{when(f.modified)}</td>
          <td><span className={`bk-kind bk-kind--${f.kind}`}>{KIND[f.kind] || f.kind}</span>{!f.files && <span className="bk-note" title="Backups from before 2026-11-02 hold only the database"> · database only</span>}</td>
          <td>{mb(f.bytes)}</td>
          <td className="bk-actions">
            {f.kind !== 'before-restore' && <button type="button" className="adm-btn adm-btn-ghost" disabled={busy}
              title={f.kind === 'pinned' ? 'Let it be removed with the old nightly backups again' : 'Keep it: pinned backups are never removed'}
              onClick={() => onPin(where, f, f.kind !== 'pinned')}>{f.kind === 'pinned' ? 'Unpin' : 'Pin'}</button>}
            <button type="button" className="adm-btn" disabled={busy} onClick={() => onRestore(where, f)}>Restore…</button>
          </td>
        </tr>))}
      </tbody>
    </table>
  );
}

export default function BackupsSection() {
  const confirm = useConfirm();
  const [data, setData] = useState(null), [error, setError] = useState(''), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [restarting, setRestarting] = useState(false);
  const [dirDraft, setDirDraft] = useState('');
  const load = useCallback(() => api('GET', '/api/admin/backup/list').then(d => { setData(d); setDirDraft(d.copy.dir || ''); setError(''); }).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, done) => { setBusy(true); setNote(''); setError(''); try { const r = await fn(); if (done) setNote(done(r)); await load(); } catch (e) { setError(e.message); } setBusy(false); };
  const backupNow = () => act(() => api('POST', '/api/admin/backup/run'),
    r => `Backup written: ${r.file} (${mb(r.bytes)})${r.copy ? (r.copy.ok ? ', copied to the second folder' : `; second copy failed: ${r.copy.error}`) : ''}.`);
  const saveDir = () => act(() => api('POST', '/api/admin/backup/copy-dir', { dir: dirDraft }),
    r => (r.dir ? `Second copies go to ${r.dir}${r.freeBytes != null ? ` (${mb(r.freeBytes)} free)` : ''}. The next backup is copied there.` : 'Second copy turned off.'));
  const offDir = () => { setDirDraft(''); act(() => api('POST', '/api/admin/backup/copy-dir', { dir: '' }), () => 'Second copy turned off.'); };
  const pin = (where, f, on) => act(() => api('POST', '/api/admin/backup/pin', { where, file: f.file, pinned: on }), () => (on ? 'Pinned: it will not be removed.' : 'Unpinned.'));
  const restore = async (where, f) => {
    const ok = await confirm({
      title: 'Restore this backup?', danger: true, confirmLabel: 'Restore and restart',
      message: `Omnibus goes back to ${when(f.modified)}: reading progress, lists, events, settings and everything else saved since then is replaced. The current database is kept first as a "Before restore" backup, so this can be undone. Omnibus finishes running work, restarts, and is back in a minute; active downloads are cancelled.`,
    });
    if (!ok) return;
    setBusy(true); setError(''); setNote('');
    try {
      await api('POST', '/api/admin/backup/restore', { where, file: f.file });
      setRestarting(true);
      // Wait for the restart, then reload the page.
      const started = Date.now();
      await new Promise(r => setTimeout(r, 4000));
      while (Date.now() - started < 180000) {
        try { const h = await fetch('/api/health', { cache: 'no-store' }); if (h.ok) { window.location.reload(); return; } } catch {}
        await new Promise(r => setTimeout(r, 2500));
      }
      setError('Omnibus has not come back after 3 minutes. Check the container (docker logs omnibus).');
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  if (restarting) return <section className="settings-section bk"><p className="bk-banner">Restoring… Omnibus is restarting. This page reloads when it is back.</p>{error && <p className="bk-error" role="alert">{error}</p>}</section>;
  if (!data) return <section className="settings-section bk">{error ? <p className="bk-error" role="alert">{error}</p> : <p className="bk-empty">Loading backups…</p>}</section>;
  const s = data.secrets || {}, last = data.last, r = data.restore;
  return (
    <section className="settings-section bk">
      {data.fresh && data.primary.files.length > 0 && <p className="bk-banner">This looks like a new install. To bring back your library, lists and progress, restore one of the backups below.</p>}
      {r && <p className={r.ok ? 'bk-ok' : 'bk-error'}>{r.ok
        ? `Last restore: ${r.source} on ${when(r.at)}${r.by ? ` by ${r.by}` : ''}. The database before it is kept as ${r.before || '(none)'}.`
        : `The restore of ${r.source} on ${when(r.at)} failed and nothing was changed: ${r.error}`}</p>}

      <div className="settings-section-header">
        <div>
          <h2 className="settings-section-title">Database backups</h2>
          <p className="settings-section-sub">Every night at 09:30 UTC Omnibus copies its database (users, progress, lists, events, Top Shelf, settings) and a few small files ({data.extraFiles.join(', ')}), checks the copy and keeps the newest {data.keep}. Pinned backups are never removed.</p>
        </div>
        <button type="button" className="adm-btn adm-btn-primary a-noshrink" disabled={busy} onClick={backupNow}>{busy ? 'Working…' : 'Back up now'}</button>
      </div>
      {last && <p className={last.ok ? 'bk-status' : 'bk-error'}>{last.ok
        ? `Last backup ${when(last.at)} (${last.trigger}), ${mb(last.bytes)}.${last.copy ? (last.copy.ok ? ' Second copy made.' : ` Second copy failed: ${last.copy.error}`) : ''}`
        : `Last backup ${when(last.at)} failed: ${last.error}`}</p>}
      {note && <p className="bk-ok" role="status">{note}</p>}
      {error && <p className="bk-error" role="alert">{error}</p>}

      <h3 className="bk-h">Second copy</h3>
      <p className="bk-help">A copy of every backup in another folder, so one failing drive does not take both. The folder must be mounted into Omnibus: set <code>BACKUP_COPY_HOST_PATH</code> in <code>.env</code> to a folder on another drive or a NAS (for example <code>E:\OmnibusBackups</code>), run <code>.\deploy.ps1</code>, then use <code>/backup-copy</code> here.</p>
      <div className="bk-row">
        <input className="adm-input" value={dirDraft} placeholder="/backup-copy" aria-label="Second backup folder" onChange={e => setDirDraft(e.target.value)} />
        <button type="button" className="adm-btn" disabled={busy || !dirDraft.trim()} onClick={saveDir}>Test and save</button>
        {data.copy.dir && <button type="button" className="adm-btn adm-btn-ghost" disabled={busy} onClick={offDir}>Turn off</button>}
      </div>
      {data.copy.error && <p className="bk-error">{data.copy.error}</p>}

      <h3 className="bk-h">API keys</h3>
      <p className={s.unreadable?.length ? 'bk-error' : s.configured ? 'bk-status' : 'bk-warn'}>
        {s.unreadable?.length
          ? `${s.unreadable.length} stored key(s) cannot be read (${s.unreadable.join(', ')}): OMNIBUS_SECRET in .env is missing or different from the one they were saved with. Put the original back, or enter the keys again.`
          : s.configured
            ? `Stored keys and passwords are encrypted (${s.encrypted} of ${s.stored}); backups never hold them readable. Restoring onto another machine needs the same OMNIBUS_SECRET from your .env, so keep a copy of .env somewhere safe.`
            : 'Stored keys and passwords are not encrypted: OMNIBUS_SECRET is not set in .env. Running .\\deploy.ps1 adds one.'}
      </p>

      <h3 className="bk-h">Backups <span className="bk-dir">{data.primary.dir}</span></h3>
      <BackupList where="primary" files={data.primary.files} busy={busy} onPin={pin} onRestore={restore} />
      {data.copy.dir && <>
        <h3 className="bk-h">Second copy <span className="bk-dir">{data.copy.dir}</span></h3>
        <BackupList where="copy" files={data.copy.files} busy={busy} onPin={pin} onRestore={restore} />
      </>}
    </section>
  );
}
