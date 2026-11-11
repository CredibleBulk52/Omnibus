import React from 'react';
import Modal from './Modal';
import { Empty } from './StateMessage';

// "+ Collection": pick a comic box for one series (Series page) or the ticked
// series (Series browser). Shared since 2026-10-26; the two pages had copies.
export default function AddToBoxModal({ intro, collections, onAdd, onClose, emptyTitle = 'No comic boxes yet' }) {
  return (
    <Modal title="Add to a comic box" onClose={onClose} width={480}
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="rl-modal-body">
        <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{intro}</p>
        {collections.length === 0 ? (
          <Empty title={emptyTitle}>Create one from Comic Boxes first.</Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {collections.map(col => (
              <button type="button" key={col.id} className="list-card" onClick={() => onAdd(col.id)} style={{ cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                <div style={{ flex: 1 }}>
                  <div className="list-card-name">{col.name}</div>
                  <div className="list-card-meta">{col.seriesCount} series · {(col.collectionType || col.collection_type) === 'auto' ? 'Automatic' : 'Hand-picked'}</div>
                </div>
                <span className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '3px 10px' }}>Add</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
