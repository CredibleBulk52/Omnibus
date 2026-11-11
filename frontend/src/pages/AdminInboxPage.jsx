import React, { useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import DownloadRequestsTab from './DownloadRequestsTab';
import DownloadReportsTab from './DownloadReportsTab';
import { AddSeriesModal, ToastContainer, useToast } from './DownloadManager';
import '../downloadManager.css';

// ─── Requests and Reports (admins; 2026-11-10) ────────────────────────────────
// Moved out of the Download Manager's tabs to the account menu, unchanged:
// /admin/requests (what readers asked to have downloaded; Add series opens the
// Download Manager's Add Series window here and marks the request added) and
// /admin/reports (problems readers reported).
export default function AdminInboxPage({ kind }) {
  const { toast } = useToast();
  const [addQuery, setAddQuery] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const pending = useRef(null);
  const requests = kind === 'requests';
  return (
    <div className="dm-page">
      <PageHeader title={requests ? 'REQUESTS' : 'PROBLEM REPORTS'} borderSeed={0} />
      <div className="dm-content">
        {requests
          ? <DownloadRequestsTab toast={toast} reloadKey={reloadKey} onCount={() => {}}
              onAddSeries={(q, requestId) => { pending.current = requestId; setAddQuery(q || ''); }} />
          : <DownloadReportsTab onCount={() => {}} />}
      </div>
      {addQuery !== null && (
        <AddSeriesModal initialQuery={addQuery}
          onClose={() => { setAddQuery(null); pending.current = null; }}
          onAdded={() => {
            setAddQuery(null);
            const id = pending.current; pending.current = null;
            if (id) fetch(`/api/download-requests/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'added' }) })
              .then(() => setReloadKey(k => k + 1)).catch(() => {});
          }} />
      )}
      <ToastContainer />
    </div>
  );
}
