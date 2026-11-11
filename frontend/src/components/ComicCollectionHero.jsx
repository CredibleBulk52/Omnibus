import React, { useEffect, useRef, useState } from 'react';
import ManageMenu from './ManageMenu';
import { collectionPresentation } from '../pages/collectionPresentation.mjs';

// The comic box's Manage menu: sits at the right of the hero's intro row, across from the
// back button (comic boxes have no next-issue card to sit under). Same items as before.
export function CollectionManageMenu({ isManual, uploading, onEdit, onEditRules, onDelete, onUpload, personal = false, shared = false, onShare }) {
  const [open, setOpen] = useState(false);
  const upload = useRef(null);
  const act = action => { setOpen(false); action(); };
  return <>
    <ManageMenu id="collection-manage-menu" open={open} setOpen={setOpen}>
      <button onClick={() => act(onEdit)}>Edit box</button>
      {!isManual && <button onClick={() => act(onEditRules)}>Edit matching rules</button>}
      <button disabled={uploading} onClick={() => act(() => upload.current?.click())}>{uploading ? 'Uploading…' : 'Change artwork'}</button>
      {personal && onShare && <button onClick={() => act(onShare)}>{shared ? 'Stop sharing' : 'Share with other readers'}</button>}
      <button className="manage-menu-danger" onClick={() => act(onDelete)}>Delete box…</button>
    </ManageMenu>
    <input ref={upload} type="file" accept="image/png,image/jpeg" hidden aria-label="Collection artwork" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; onUpload(file); }} />
  </>;
}

export default function ComicCollectionHero({ collection, count, isManual, coverUrl, back, manage }) {
  const [artFailed, setArtFailed] = useState(false);
  const { lead, paragraphs } = collectionPresentation(collection);
  useEffect(() => { setArtFailed(false); }, [coverUrl]);
  return <section className="ccd-intro">
    {coverUrl && !artFailed && <img className="ccd-fuzzy" src={coverUrl} alt="" aria-hidden="true" />}
    <div className="ccd-intro-top">
      <div className="ccd-intro-left">{back}<span className="ccd-stamp">{!collection.owner_id ? 'Library box' : collection.is_owner === false ? `Shared by ${collection.owner_name || 'another reader'}` : collection.shared ? 'Personal box · Shared' : 'Personal box'}</span></div>
      {manage}
    </div>
    <div className={`ccd-editorial${!coverUrl || artFailed ? ' ccd-no-art' : ''}`}>
      {coverUrl && !artFailed && <figure className="ccd-artwork"><img src={coverUrl} alt={`${collection.name} box artwork`} onError={() => setArtFailed(true)} /></figure>}
      <div className="ccd-caption"><span className="ccd-caption-tab">Inside this box</span>
        {lead ? <p className="ccd-lead">{lead}</p> : <p className="ccd-lead">{isManual ? 'A collection of hand-picked series.' : 'A collection that grows with your library.'}</p>}
        {collection.era && <p className="ccd-era">{collection.era}</p>}
        {paragraphs.length > 0 && <>
          <div className="ccd-desktop-introduction">{paragraphs.map((p,i) => <p className="ccd-description" key={i}>{p}</p>)}</div>
          <details className="ccd-collapsible-introduction"><summary>Read the full introduction <span aria-hidden="true">+</span></summary>{paragraphs.map((p,i) => <p className="ccd-description" key={i}>{p}</p>)}</details>
        </>}
      </div>
    </div>
    <div className="ccd-facts"><span className="ccd-count">{count} <span>series</span></span><span className="ccd-type">{isManual ? 'Hand-picked' : '↻ Automatic'}</span><span className="ccd-fact-copy">{isManual ? 'Series chosen for this box.' : 'Series join this box when they match its rules.'}</span></div>
  </section>;
}
