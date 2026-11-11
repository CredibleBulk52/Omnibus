import { createPortal } from 'react-dom';
import BoxDefaultArtwork from '../components/BoxDefaultArtwork';
import { boxArtworkOptions } from '../components/boxArtwork';
import useBoxArtwork from '../components/useBoxArtwork';
import Modal from '../components/Modal';
import PageHeader from '../components/PageHeader';
import '../comicBoxes.css';
import PageStats from '../components/PageStats';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loading, ErrorNote } from '../components/StateMessage';
import { Link, useNavigate } from 'react-router-dom';
import { useLibrary, isAdmin, getUser } from '../App';
import ConditionGroup from '../components/ConditionBuilder';
import { rlApi, ListSettingsModal } from '../components/ReadingListBits';
import { NewEntryDialog, AskForList } from '../components/NewEntry';


// ─── Geometry constants (must match App.css) ──────────────────────
const SCENE_W   = 495;
const FRONT_BOT = 288;

function BoxSVG({ id }) {
  // A single perspective: the 420 × 210 front recedes 70px right and 28px up.
  // Keep all joins aligned with .cbox-front; scoped IDs support multiple cards.
  const side = `box-side-${id}`;
  const inside = `box-inside-${id}`;
  return (
    <svg className="cbox-shell" viewBox="0 0 495 298" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={side} x1="0" y1="0" x2="1" y2=".5">
          <stop offset="0" stopColor="#343a47" />
          <stop offset=".35" stopColor="#252a35" />
          <stop offset="1" stopColor="#11151e" />
        </linearGradient>
        <linearGradient id={inside} x2="0" y2="1">
          <stop stopColor="#343945" />
          <stop offset="1" stopColor="#090b11" />
        </linearGradient>
      </defs>
      {/* Open interior, with a folded back lip and dark well beneath the comics. */}
      <path d="M1 77 70 49H490L420 77Z" fill={`url(#${inside})`} stroke="#080a10" strokeWidth="2" />
      {/* Rear lip belongs behind the comics (shell z:1, thumbnails z:2). */}
      <path d="M70 44H490V50H70Z" fill="#515866" />
      <path d="M70 44H490" fill="none" stroke="#a9afba" strokeOpacity=".65" strokeWidth="1" />
      <path d="M70 44V50" stroke="#252a35" strokeWidth="1" />
      {/* Right wall shares its seam and bottom precisely with the artwork face. */}
      <path d="M420 78 490 50V260L420 288Z" fill={`url(#${side})`} stroke="#080a10" strokeWidth="2" strokeLinejoin="round" />
      <path d="M426 85 484 62V254L426 277Z" fill="none" stroke="#fff" strokeOpacity=".055" />
      <path d="M420 280 490 252V260L420 288Z" fill="#080b12" fillOpacity=".6" />
      {/* Die-cut handhold follows the same perspective as the side wall. */}
      <g transform="matrix(1 -.4 0 1 0 182)">
        <rect x="438" y="146" width="37" height="15" rx="7.5" fill="#080a10" stroke="#68717f" strokeOpacity=".45" />
        <path d="M443 158H469" stroke="#000" strokeWidth="3" strokeLinecap="round" />
      </g>
      <path d="M421 79V286" stroke="#a9afba" strokeOpacity=".3" />
    </svg>
  );
}

// ─── Canvas resize helper ─────────────────────────────────────────
// Shrinks the image to maxWidth. Preserves PNG transparency; converts
// other formats to JPEG 0.88 quality.
function resizeImageFile(file, maxWidth = 1200) {
  const isPng = file.type === 'image/png';
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = img.width > maxWidth ? maxWidth / img.width : 1;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (isPng) ctx.clearRect(0, 0, w, h); // keep alpha channel clear
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(resolve, isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 0.88);
    };
    img.src = url;
  });
}

// Display-only: keep saved names intact, including unrecognized parentheses.
export function splitBoxTitle(name = '') {
  const match = name.match(/^(.*?)\s*\((\d{4})\s*(?:to|–|-)\s*(\d{4}|present)\)$/i);
  if (!match || !match[1].trim() || (match[3].toLowerCase() !== 'present' && Number(match[3]) < Number(match[2]))) return { title: name, dates: null };
  return { title: match[1].trim(), dates: match[2] + '–' + (match[3].toLowerCase() === 'present' ? 'Present' : match[3]) };
}

// Card copy is a complete sentence; the saved detail description is untouched.
function boxSummary(col) {
  const text = (col.card_description || col.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const period = text.indexOf('.');
  return period < 0 ? text : text.slice(0, period + 1);
}

// ─── Comic Box ────────────────────────────────────────────────────
// col.kind === 'order': a reading order (a reading list) shown as a box (2026-11-03,
// claude/BOXES_UNIFIED_PLAN.md stage 1). Same box; its comics are the list's first
// covers, its art is the list's cover image, and it opens the reading list page.
// col.displayName: a followed or shared box shows as "Username's Box Title" (stage 2).
function ComicBox({ col, onClick }) {
  const isOrder = col.kind === 'order';
  const slotRef=useRef(null);
  const [scale,setScale]=useState(1);
  useEffect(()=>{const slot=slotRef.current;if(!slot)return;const resize=()=>setScale(Math.min(1,slot.clientWidth/SCENE_W));resize();const observer=new ResizeObserver(resize);observer.observe(slot);return()=>observer.disconnect();},[]);
  const { title: displayTitle, dates } = splitBoxTitle(col.displayName || col.name);
  const [hovered, setHovered]     = useState(false);
  const [peekIds, setPeekIds]     = useState([]);
  const [coverUrl, setCoverUrl]   = useState(null);
  const [coverIsPng, setCoverIsPng] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const fileRef = useRef();
  const displayCoverUrl = useBoxArtwork(coverUrl);
  const [artwork,setArtwork]=useState(col.catalog?.artwork || {choice:'auto',family:'default'});
  const [artworkOpen,setArtworkOpen]=useState(false);
  const [artworkError,setArtworkError]=useState('');
  const [artworkSaving,setArtworkSaving]=useState(false);
  useEffect(()=>{if(isOrder && col.catalog?.artwork) setArtwork(col.catalog.artwork);},[isOrder,col.catalog?.artwork]);
  const saveArtwork=async(choice)=>{
    setArtworkSaving(true); setArtworkError('');
    try {
      const r=await fetch(`/api/${isOrder?'reading-lists':'collections'}/${col.id}/artwork`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({choice})});
      const data=await r.json();
      if(!r.ok) throw new Error(data.error || 'Could not save artwork');
      setArtwork(data.artwork);
    } catch(e) {setArtworkError(e.message);}
    finally {setArtworkSaving(false);}
  };

  useEffect(() => {
    if (isOrder) {   // uploaded artwork (2026-11-03); an older full link is used as it is
      const art = col.cover_image ? (/^(https?:)?\//.test(col.cover_image) ? col.cover_image : `/api/reading-lists/${col.id}/cover?v=${encodeURIComponent(col.cover_image)}`) : null;
      setCoverUrl(art); setCoverIsPng(String(col.cover_image || '').endsWith('.png')); return;
    }
    if (col.cover_image) {
      setCoverUrl(`/api/collections/${col.id}/cover?v=${col.cover_image}`);
      setCoverIsPng(col.cover_image.endsWith('.png'));
    } else {setCoverUrl(col.purpose === 'pull' ? '/pull-box-art.png' : null);setCoverIsPng(false);}
  }, [col.id, col.cover_image, col.purpose, isOrder]);

  useEffect(() => {
    if (isOrder) return;
    // Its series, topped up with issues from them when there are too few to fill the row (2026-11-04).
    fetch(`/api/collections/${col.id}/peek?n=8`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d?.items)) setPeekIds(d.items); if(d?.artwork) setArtwork(d.artwork); })
      .catch(() => {});
  }, [col.id, isOrder]);
  const peek = isOrder
    ? (col.progress?.cover_book_ids || []).map(id => ({ key: id, src: `/api/books/${id}/thumbnail` }))
    : peekIds.map(({ kind, id }) => ({ key: `${kind}:${id}`, src: kind === 'book' ? `/api/books/${id}/thumbnail` : `/api/series/${id}/thumbnail` }));

  const doUpload = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    setUploading(true);
    try {
      const blob = await resizeImageFile(file);
      const r = await fetch(isOrder ? `/api/reading-lists/${col.id}/cover` : `/api/collections/${col.id}/cover`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
      if (!r.ok) throw new Error('upload failed');
      setCoverUrl(`${isOrder ? `/api/reading-lists/${col.id}` : `/api/collections/${col.id}`}/cover?v=${Date.now()}`);
      setCoverIsPng(blob.type === 'image/png');
    } catch {}
    setUploading(false);
  }, [col.id, isOrder]);

  const handleFileChange = e => { if (e.target.files[0]) doUpload(e.target.files[0]); };
  const handleDrop = e => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) doUpload(file);
  };

  // Upload allowed: admin always, regular users only on their own collections
  // Your own boxes of both kinds (a followed box is someone else's); library boxes for admins.
  const canUpload = col.owner_id ? col.owner_id === getUser()?.id && !col.followedBox : !isOrder && isAdmin();

  const thumbLeft    = [2, 54, 106, 158, 210, 262, 314, 366];
  const thumbRot     = [-1.5, 0.6, -1, 0.4, -0.8, 1.2, -0.5, 1];
  const thumbHeights = [118, 114, 120, 116, 119, 113, 117, 115];

  return (
    <div className="cbox-slot" ref={slotRef} style={{'--box-scale':scale}}><div
      className={`cbox-scene ${col.card_description || col.description ? 'cbox-has-description' : ''} ${hovered ? 'cbox-hovered' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position:'relative', width:SCENE_W, height: FRONT_BOT + 60, overflow:'visible', cursor:'pointer' }}
    >
      {/* ── z:1  SVG — interior top + right side face ───────────── */}
      <BoxSVG id={col.id} />

      {/* ── z:2  Thumbnails ───────────────────────────────────────── */}
      {peek.map(({ key, src }, i) => (
        <div
          key={key}
          className="cbox-thumb"
          style={{
            left:            thumbLeft[i]    ?? (2 + i * 52),
            rotate:          `${thumbRot[i]  ?? 0}deg`,
            height:          thumbHeights[i] ?? 100,
            transitionDelay: hovered
              ? `${i * 0.045}s`
              : `${(peek.length - 1 - i) * 0.035}s`,
          }}
        >
          <img
            src={src}
            alt=""
            draggable={false}
            onError={e => { e.currentTarget.parentElement.style.display = 'none'; }}
          />
        </div>
      ))}

      {/* ── z:3  Front face ─────────────────────────────────────── */}
      <div
        className={`cbox-front ${dragOver ? 'cbox-front--dragover' : ''}`}
        onClick={onClick}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {displayCoverUrl ? (
          <div className="cbox-cover-layers">
            {/* Blur fill — only for opaque images; PNGs render against dark box bg */}
            {!coverIsPng && (
              <img className="cbox-cover-blur" src={displayCoverUrl} alt="" draggable={false} aria-hidden />
            )}
            {/* Contained image — always fully visible */}
            <img className="cbox-cover-img" src={displayCoverUrl} alt={col.name} draggable={false} />
          </div>
        ) : (
          <BoxDefaultArtwork title={displayTitle} isOrder={isOrder} family={artwork.family} era={col.era} />
        )}
        <div className="cbox-spine-shadow" />
        {isOrder && displayCoverUrl && <span className="cbox-order-ribbon" aria-hidden="true">Reading order</span>}

        {canUpload && (
          <>
            <button
              className={`cbox-upload-btn ${uploading ? 'cbox-upload-btn--busy' : ''}`}
              title="Upload cover art"
              onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}
            >{uploading ? '⏳' : '📷'}</button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display:'none' }}
              onClick={e => e.stopPropagation()}
              onChange={handleFileChange}
            />
          </>
        )}
        {canUpload && !coverUrl && <button type="button" className="cbox-artwork-choice" onClick={e=>{e.stopPropagation();setArtworkOpen(true);}}>Artwork</button>}
        {artworkOpen && createPortal(<div onClick={e=>e.stopPropagation()}><Modal title="Select artwork" width={380} initialFocus="select" onClose={()=>setArtworkOpen(false)}>
          <div className="rl-modal-body">
            <select className="form-select" aria-label="Select artwork" value={artwork.choice} disabled={artworkSaving} onChange={e=>saveArtwork(e.target.value)}>
              {boxArtworkOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
            </select>
            {artworkSaving && <span role="status">Saving…</span>}
            {artworkError && <p role="alert">{artworkError}</p>}
          </div>
        </Modal></div>, document.body)}
        {dragOver && <div className="cbox-drop-hint">Drop image here</div>}
      </div>

<svg className="cbox-rim-wrap" viewBox="0 0 495 298" aria-hidden="true" focusable="false">
        {/* Continuous front/right lip sits ahead of the comics; rear lip is in BoxSVG. */}
        <path d="M0 72H420L490 44V50L420 78H0Z" fill="#515866" />
        <path d="M490 44L420 72H0" fill="none" stroke="#a9afba" strokeOpacity=".65" strokeWidth="1" strokeLinejoin="round" />
        <path d="M0 77.5H420L490 49.5" fill="none" stroke="#202631" strokeWidth="1" strokeLinejoin="round" />
      </svg>

      {/* ── Label ─────────────────────────────────────────────────── */}
      <div className="cbox-label" onClick={onClick}>
        {col.era && <span className="cbox-era-badge">{col.era}</span>}
        {isOrder && <span className="cbox-era-badge cbox-kind-badge">Reading order</span>}
        <div className="cbox-col-name">{displayTitle}</div>
        <div className="cbox-col-meta">
          {isOrder ? orderMeta(col.progress) : <>
          {dates && <><span className="box-date">{dates}</span><span aria-hidden="true"> · </span></>}
          {col.publisher && <>{col.publisher} · </>}{col.seriesCount} series{col.purpose === 'pull' && !col.displayName && ' · My pulls'}
          </>}
          {col.sharedMine && ' · Shared'}{col.followedBox && ' · Following'}
        </div>
        {(col.card_description || col.description) && <p className="cbox-card-description">{boxSummary(col)}</p>}
      </div>
    </div></div>
  );
}

const orderMeta = (p = {}) => {
  const total = p.total || 0, read = p.read || 0;
  if (!total) return 'Nothing added yet';
  return `${total} ${total === 1 ? 'issue' : 'issues'}` + (read >= total ? ' · All read' : read ? ` · ${read} read` : '');
};

// My Comic Boxes: one side-scrolling row (2026-11-03), arrows as on the Home shelves.
function BoxRow({ children, count, label = 'My Comic Boxes' }) {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const update = useCallback(() => {
    const t = ref.current; if (!t) return;
    setEdges({ start: t.scrollLeft <= 4, end: t.scrollLeft + t.clientWidth >= t.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const t = ref.current; if (!t) return undefined;
    update();
    t.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(t);
    return () => { t.removeEventListener('scroll', update); window.removeEventListener('resize', update); ro?.disconnect(); };
  }, [update, count]);
  const move = dir => {
    const t = ref.current; if (!t) return;
    t.scrollBy({ left: dir * t.clientWidth * 0.85, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return <div className="cbox-row-wrap">
    {!edges.start && <button type="button" className="cbox-row-arrow cbox-row-arrow--left" aria-label="Scroll left" onClick={() => move(-1)}>‹</button>}
    <div className="cbox-row" ref={ref} role="region" aria-label={label} tabIndex={0}>{children}</div>
    {!edges.end && <button type="button" className="cbox-row-arrow cbox-row-arrow--right" aria-label="Scroll right" onClick={() => move(1)}>›</button>}
  </div>;
}

// Box titles matched by the page's search field (title only, any case).
export const matchesBoxQuery = (box, query) => {
  const q = query.trim().toLowerCase();
  return !q || String(box.displayName || box.name || '').toLowerCase().includes(q);
};
// The user's boxes in one order: My Pull Box, then the most recently updated (both kinds),
// then the boxes they follow (stage 2), shown as "Username's Box Title".
const byUpdate = (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
export const othersName = box => (box.owner_name ? `${box.owner_name}'s ${box.name}` : box.name);
export function orderMyBoxes(series, orders, followed = { series: [], orders: [] }) {
  const own = [...series.map(c => ({ ...c, kind: 'series', sharedMine: c.visibility === 'shared' })),
    ...orders.map(l => ({ ...l, kind: 'order', sharedMine: l.visibility === 'public' }))]
    .sort((a, b) => Number(b.purpose === 'pull') - Number(a.purpose === 'pull') || byUpdate(a, b));
  const theirs = [...(followed.series || []).map(c => ({ ...c, kind: 'series' })), ...(followed.orders || []).map(l => ({ ...l, kind: 'order' }))]
    .map(b => ({ ...b, followedBox: true, displayName: othersName(b) })).sort(byUpdate);
  return [...own, ...theirs];
}
// Other users' shared boxes not yet followed (both kinds), newest first.
export function sharedByOthers(sharedSeries, publicOrders, userId) {
  return [...sharedSeries.filter(c => !c.following).map(c => ({ ...c, kind: 'series' })),
    ...publicOrders.filter(l => l.owner_id !== userId && !l.following).map(l => ({ ...l, kind: 'order' }))]
    .map(b => ({ ...b, displayName: othersName(b) })).sort(byUpdate);
}

// Find shared boxes (2026-11-03): other readers' shared boxes, found when wanted instead of
// a row that always shows. Search by title or owner; ☆ Follow adds one to My Comic Boxes.
export const matchesSharedQuery = (box, query) => {
  const q = query.trim().toLowerCase();
  return !q || [box.name, box.owner_name].some(v => String(v || '').toLowerCase().includes(q));
};
function SharedBoxArt({ box }) {
  const isOrder = box.kind === 'order';
  const src = box.cover_image
    ? (isOrder ? (/^(https?:)?\//.test(box.cover_image) ? box.cover_image : `/api/reading-lists/${box.id}/cover?v=${encodeURIComponent(box.cover_image)}`)
      : `/api/collections/${box.id}/cover?v=${encodeURIComponent(box.cover_image)}`)
    : isOrder && box.progress?.cover_book_ids?.[0] ? `/api/books/${box.progress.cover_book_ids[0]}/thumbnail` : null;
  const art = useBoxArtwork(src);
  return <span className="cbox-shared-art" aria-hidden="true">{art ? <img src={art} alt="" /> : <span>{isOrder ? '1·2·3' : '▣'}</span>}</span>;
}
function SharedBoxesModal({ boxes, followed, busy, onFollow, onOpen, onClose }) {
  const [query, setQuery] = useState('');
  const [justFollowed, setJustFollowed] = useState(new Set());
  const keyOf = b => `${b.kind}-${b.id}`;
  // Boxes followed in this dialog stay listed (as Following) until it is closed.
  const followedHere = followed.filter(b => justFollowed.has(keyOf(b)) && !boxes.some(x => keyOf(x) === keyOf(b)));
  const list = [...boxes, ...followedHere].map(b => ({ ...b, nowFollowing: justFollowed.has(keyOf(b)) })).filter(b => matchesSharedQuery(b, query))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const follow = async b => { if (await onFollow(b)) setJustFollowed(s => new Set(s).add(keyOf(b))); };
  return <Modal title="Find shared boxes" onClose={onClose} width={620} footer={<button type="button" className="btn btn-ghost" onClick={onClose}>Done</button>}>
    <div className="rl-modal-body cbox-shared">
      <p className="cbox-shared-intro">Boxes other readers share. Follow one to keep it with your boxes; it stays up to date with their changes. Open one to look inside first.</p>
      {(boxes.length + followedHere.length) > 0 && <input type="search" className="find-box cbox-shared-search" autoFocus placeholder="Search by title or by who shared it…" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search shared boxes" />}
      {!boxes.length && !followedHere.length ? <p className="cbox-shared-empty">{followed.length ? 'You follow every box that is shared right now.' : 'No one has shared a box yet.'} You can share your own from a box’s menu.</p>
        : !list.length ? <p className="cbox-shared-empty">No shared boxes match “{query}”.</p>
        : <ul className="cbox-shared-list">{list.map(b => (
          <li key={keyOf(b)} className="cbox-shared-item">
            <SharedBoxArt box={b} />
            <button type="button" className="cbox-shared-open" onClick={() => onOpen(b)}>
              <strong>{b.name}</strong>
              <span>{b.kind === 'order' ? `Reading order · ${b.progress?.total || 0} issues` : `Series box · ${b.seriesCount ?? 0} series`} · shared by {b.owner_name || 'another reader'}</span>
            </button>
            {b.nowFollowing ? <span className="cbox-shared-done">★ Following</span>
              : <button type="button" className="btn btn-secondary cbox-follow" disabled={busy === keyOf(b)} onClick={() => follow(b)}>{busy === keyOf(b) ? 'Following…' : '☆ Follow'}</button>}
          </li>))}</ul>}
    </div>
  </Modal>;
}

function BoxSectionHeader({ title, children }) {
  return <div className="cbox-caption-header">
    <div className="cbox-caption-tab"><h2>{title}</h2></div>
    <div className="cbox-caption-rail" aria-hidden="true" />
    <div className="cbox-caption-actions">{children}</div>
  </div>;
}

// ─── Collections Page ─────────────────────────────────────────────

// mine (/my-boxes, 2026-11-03): only the reader's own and followed boxes, as a grid, with the
// same search, + Create a box and Find shared boxes; the library's boxes stay on /collections.
export default function CollectionsPage({ mine = false }) {
  const navigate = useNavigate();
  const { activeLibrary } = useLibrary();
  const [collections, setCollections] = useState([]);
  const [orders, setOrders]           = useState([]);   // the user's reading lists, shown as boxes
  const [sharedSeries, setSharedSeries] = useState([]); // other users' shared series boxes (followed ones flagged)
  const [followedOrders, setFollowedOrders] = useState([]);
  const [publicOrders, setPublicOrders] = useState([]);
  const [followBusy, setFollowBusy]   = useState(null);
  // When this reader last opened Find shared boxes: boxes shared since then count as new.
  // Kept in this browser only (a convenience; nothing breaks without it).
  const seenKey = `omnibus.sharedSeen.${getUser()?.id || ''}`;
  const [sharedSeen, setSharedSeen]   = useState(() => { try { return localStorage.getItem(seenKey) || ''; } catch { return ''; } });
  const [query, setQuery]             = useState('');
  const [loading, setLoading]         = useState(true);
  const [modal, setModal]             = useState(null);
  const showAllMine = mine;   // the full grid lives on My Comic Boxes (/my-boxes)
  const [publisher,setPublisher]=useState('all');
  const admin = isAdmin();
  const userId = getUser()?.id;

  const load = () => {
    const url = activeLibrary
      ? `/api/collections?libraryId=${activeLibrary.id}`
      : '/api/collections';
    fetch(url).then(r => r.json())
      .then(d => { setCollections(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
    rlApi('GET', '/api/reading-lists?scope=mine').then(d => setOrders(d.lists || [])).catch(() => setOrders([]));
    rlApi('GET', '/api/boxes/shared').then(d => setSharedSeries(d.boxes || [])).catch(() => setSharedSeries([]));
    rlApi('GET', '/api/reading-lists?scope=following').then(d => setFollowedOrders(d.lists || [])).catch(() => setFollowedOrders([]));
    rlApi('GET', '/api/reading-lists?scope=public').then(d => setPublicOrders(d.lists || [])).catch(() => setPublicOrders([]));
  };
  const openShared = () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);   // same form as updated_at
    try { localStorage.setItem(seenKey, now); } catch {}
    setModal('shared');
    setTimeout(() => setSharedSeen(now), 0);
  };
  const follow = async box => {
    setFollowBusy(`${box.kind}-${box.id}`);
    let ok = false;
    try { await rlApi('POST', box.kind === 'order' ? `/api/reading-lists/${box.id}/follow` : `/api/collections/${box.id}/follow`); ok = true; load(); }
    catch {}
    setFollowBusy(null);
    return ok;
  };
  useEffect(() => { load(); }, [activeLibrary]);

  if (loading) return <Loading label="Loading comic boxes…" />;

  const sharedCols = collections.filter(c => !c.owner_id);
  const myCols = orderMyBoxes(collections.filter(c => c.owner_id && c.owner_id === userId), orders,
    { series: sharedSeries.filter(c => c.following), orders: followedOrders });
  const myShown = myCols.filter(c => matchesBoxQuery(c, query));
  const others = sharedByOthers(sharedSeries, publicOrders, userId);
  const newShared = others.filter(b => String(b.updated_at || '') > sharedSeen).length;
  const publishers=[...new Set(sharedCols.map(c=>c.publisher).filter(Boolean))];
  const visibleShared=(publisher==='all'?sharedCols:sharedCols.filter(c=>c.publisher===publisher)).filter(c => matchesBoxQuery(c, query));
  const openBox = col => navigate(col.kind === 'order' ? `/reading-lists/${col.id}` : `/collections/${col.id}`);
  const boxKey = col => `${col.kind || 'series'}-${col.id}`;

  return (
    <div>
      <div className="cbox-page-bg comic-boxes" style={{ flex:1, minWidth:0 }}>
      <PageHeader title={mine ? 'MY COMIC BOXES' : 'THE COMIC BOX'} borderSeed={3}>
        {!mine && <PageStats page="collections" libraryId={activeLibrary?.id} />}
        {admin && !mine && (
          <>
            <button className="btn btn-secondary" onClick={() => setModal('auto')}>+ Automatic</button>
            <button className="btn btn-primary"   onClick={() => setModal('manual')}>+ Manual</button>
          </>
        )}
      </PageHeader>

      <div className="cbox-find find-bar">
        <label className="cbox-find-label"><span className="cbox-sr">Find a box</span>
          <input type="search" className="find-box" placeholder="Find a box by title…" value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        {query && <span className="cbox-find-count" role="status">{myShown.length + (mine ? 0 : visibleShared.length)} {myShown.length + (mine ? 0 : visibleShared.length) === 1 ? 'box' : 'boxes'} found</span>}
      </div>

      <div className="cbox-section cbox-section--personal" id="my-boxes">
        <BoxSectionHeader title="My Comic Boxes"><div className="cbox-section-count">{myCols.length} {myCols.length===1?'box':'boxes'}</div><button className="btn btn-secondary" onClick={()=>setModal('create-personal')}>+ Create a box</button><button type="button" className="btn btn-secondary cbox-find-shared" onClick={openShared}>Find shared boxes{others.length ? ` (${newShared ? `${newShared} new` : others.length})` : ''}</button>{mine ? <Link className="box-jump" to="/collections">The Comic Box →</Link> : <>{myCols.length > 1 && <Link className="box-jump" to="/my-boxes">View all {myCols.length}</Link>}<a className="box-jump" href="#library-boxes">Library Comic Boxes ↓</a></>}</BoxSectionHeader>
        {!myCols.length ? <div className="cbox-personal-empty"><strong>Your comics, in your own boxes.</strong><p>Choose + Pull on a series to start My Pull Box, or create a box: a set of series, or a reading order to read in sequence.</p><Link to="/my-pull-box">Explore My Pull Box →</Link></div>
          : !myShown.length ? <div className="cbox-personal-empty">None of your boxes match “{query}”.</div>
          : showAllMine ? <div className="cbox-grid">{myShown.map(col => <ComicBox key={boxKey(col)} col={col} onClick={() => openBox(col)} />)}</div>
          : <BoxRow count={myShown.length}>{myShown.map(col => <ComicBox key={boxKey(col)} col={col} onClick={() => openBox(col)} />)}</BoxRow>}
      </div>
      {/* ── Library Comic Boxes ── */}
      {!mine && <div className="cbox-section" id="library-boxes">
        <BoxSectionHeader title="Library Comic Boxes">
          <div className="cbox-section-count">{sharedCols.length} {sharedCols.length === 1 ? 'box' : 'boxes'}</div>
          <a className="box-jump" href="#my-boxes">My Comic Boxes ↑</a>
        </BoxSectionHeader>
        {publishers.length>1 && <label className="cbox-publisher-filter">Publisher <select value={publisher} onChange={e=>setPublisher(e.target.value)}><option value="all">All publishers</option>{publishers.map(p=><option key={p} value={p}>{p}</option>)}</select></label>}
        {visibleShared.length === 0 ? (
          <div style={{ padding:'24px 48px', color:'var(--text-muted)', fontSize:'0.88rem' }}>
            {query ? `No library boxes match “${query}”.` : admin ? 'No shared boxes yet. Create one above.' : 'No library boxes have been created yet.'}
          </div>
        ) : (
          <div className="cbox-grid">
            {visibleShared.map(col => (
              <ComicBox key={col.id} col={col} onClick={() => navigate(`/collections/${col.id}`)} />
            ))}
          </div>
        )}
      </div>}



      {modal === 'create-personal' && <Modal title="Create a box" onClose={()=>setModal(null)} width={520}><div className="rl-modal-body cbox-create">
        <p className="cbox-create-q">What goes in this box?</p>
        <button type="button" className="cbox-create-choice" onClick={()=>setModal('my-manual')}><strong>A set of series</strong><span>You pick the series, from each series page.</span></button>
        <button type="button" className="cbox-create-choice" onClick={()=>setModal('my-auto')}><strong>A set of series that fills itself</strong><span>Series are added by the rules you choose (publisher, era, genre…).</span></button>
        <button type="button" className="cbox-create-choice" onClick={()=>setModal('my-order')}><strong>A reading order</strong><span>Issues, runs and events to read in sequence, with your progress. Comic Book Guy can build one for you.</span></button>
      </div></Modal>}
      {modal === 'shared' && <SharedBoxesModal boxes={others} followed={myCols.filter(b => b.followedBox)} busy={followBusy} onFollow={follow}
        onOpen={box => { setModal(null); openBox(box); }} onClose={() => setModal(null)} />}
      {(modal === 'my-order' || modal === 'my-order-manual') && <NewEntryDialog title="New reading order" tab={modal === 'my-order' ? 'generate' : 'manual'} onTab={t => setModal(t === 'generate' ? 'my-order' : 'my-order-manual')} onClose={() => setModal(null)} width={620}>
        {tab => tab === 'generate'
          ? <AskForList onSent={() => setModal(null)} />
          : <ListSettingsModal embedded list={null} defaultVisibility="private" onClose={() => setModal(null)} onSaved={id => { setModal(null); navigate(`/reading-lists/${id}`); }} />}
      </NewEntryDialog>}
      {modal === 'auto'      && <AutoCollectionModal personal={modal === 'my-auto'} onClose={() => setModal(null)} onCreated={() => { setModal(null); load(); }} />}
      {modal === 'manual'    && <ManualCollectionModal personal={modal === 'my-manual'} onClose={() => setModal(null)} onCreated={() => { setModal(null); load(); }} />}
      {modal === 'my-auto'   && <AutoCollectionModal personal onClose={() => setModal(null)} onCreated={() => { setModal(null); load(); }} />}
      {modal === 'my-manual' && <ManualCollectionModal personal onClose={() => setModal(null)} onCreated={() => { setModal(null); load(); }} />}
      </div>

    </div>
  );
}

// ─── Auto Collection Modal ────────────────────────────────────────
function AutoCollectionModal({ onClose, onCreated, personal=false }) {
  const { libraries } = useLibrary();
  const [name, setName]                     = useState('');
  const [description, setDescription]       = useState('');
  const [cardDescription,setCardDescription]=useState('');
  const [sortOrder, setSortOrder]           = useState(0);
  const [libraryId, setLibraryId]           = useState('');
  const [conditionGroup, setConditionGroup] = useState({
    id: 1, type: 'group', condition: 'AND',
    rules: [{ id: Date.now(), field: 'era', operator: 'is', value: '', value2: '' }]
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), description, cardDescription, personal,
          rules: flattenRules(conditionGroup),
          conditionGroup: JSON.stringify(conditionGroup),
          collectionType: 'auto',
          sortOrder,
          libraryId: libraryId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error(data.error || 'Failed');
      setSaving(false); onCreated();
    } catch (e) { setSaving(false); setError(e.message); }
  };

  return (
    <Modal title="Automatic comic box" onClose={onClose} width={720} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>
        {saving ? 'Creating…' : 'Create box'}
      </button>
    </>}>
      <div className="rl-modal-body">
        {error && <ErrorNote title="Couldn't create the box.">{error}</ErrorNote>}
        <p style={{ fontSize:'0.85rem', color:'var(--text-secondary)', margin:0 }}>
          Series are automatically populated based on the conditions you define below.
        </p>
        <div className="form-group">
          <label className="form-label">Collection Name *</label>
          <input className="form-input" placeholder="e.g. DC Bronze Age" value={name} onChange={e => setName(e.target.value)} />
        </div>
<div className="form-group"><label className="form-label">Card description ({[...cardDescription].length}/140)</label><textarea className="form-textarea" maxLength={140} value={cardDescription} onChange={e=>setCardDescription(e.target.value)} placeholder="Optional short introduction" /></div>
        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-textarea" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Library</label>
          <select className="form-input" value={libraryId} onChange={e => setLibraryId(e.target.value)}>
            <option value="">All Libraries</option>
            {libraries.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div style={{ fontSize:'0.72rem', color:'var(--text-muted)', marginTop:3 }}>Only show this collection when this library is active</div>
        </div>
        <div className="form-group">
          <label className="form-label">Conditions</label>
          <ConditionGroup group={conditionGroup} onChange={setConditionGroup} depth={0} />
        </div>
        <div className="form-group" style={{ maxWidth: 120 }}>
          <label className="form-label">Display Order</label>
          <input className="form-input" type="number" min="0" step="1" value={sortOrder}
            onChange={e => setSortOrder(e.target.value)} style={{ textAlign: 'center' }} />
          <div style={{ fontSize:'0.72rem', color:'var(--text-muted)', marginTop:3 }}>Lower = appears first</div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Manual Collection Modal ──────────────────────────────────────
function ManualCollectionModal({ onClose, onCreated, personal=false }) {
  const { libraries } = useLibrary();
  const [form, setForm] = useState({ name:'', description:'', cardDescription:'', era:'', publisher:'', sortOrder: 0, libraryId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, personal, name: form.name.trim(), rules: [], collectionType: 'manual', sortOrder: form.sortOrder, libraryId: form.libraryId || null }),
      });
      const data = await res.json();
      if (!res.ok || !data.id) throw new Error(data.error || 'Failed');
      setSaving(false); onCreated();
    } catch (e) { setSaving(false); setError(e.message); }
  };

  return (
    <Modal title="Hand-picked comic box" onClose={onClose} width={560} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={save} disabled={saving || !form.name.trim()}>
        {saving ? 'Creating…' : 'Create box'}
      </button>
    </>}>
      <div className="rl-modal-body">
        {error && <ErrorNote title="Couldn't create the box.">{error}</ErrorNote>}
        <p style={{ fontSize:'0.85rem', color:'var(--text-secondary)', margin:0 }}>
          Create a curated collection and add series to it manually from each series page.
        </p>
        <div className="form-group">
          <label className="form-label">Name *</label>
          <input className="form-input" placeholder="e.g. My Reading List" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
        </div>
        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-textarea" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
        </div>
        <div className="form-group">
          <label className="form-label">Library</label>
          <select className="form-input" value={form.libraryId} onChange={e => setForm(p => ({ ...p, libraryId: e.target.value }))}>
            <option value="">All Libraries</option>
            {libraries.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div style={{ fontSize:'0.72rem', color:'var(--text-muted)', marginTop:3 }}>Only show this collection when this library is active</div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 100px', gap:12 }}>
          <div className="form-group">
            <label className="form-label">Era</label>
            <input className="form-input" placeholder="e.g. Bronze Age" value={form.era} onChange={e => setForm(p => ({ ...p, era: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Publisher</label>
            <input className="form-input" placeholder="e.g. DC Comics" value={form.publisher} onChange={e => setForm(p => ({ ...p, publisher: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Order</label>
            <input className="form-input" type="number" min="0" step="1" value={form.sortOrder}
              onChange={e => setForm(p => ({ ...p, sortOrder: e.target.value }))} style={{ textAlign:'center' }} />
          </div>
        </div>
        <div style={{ fontSize:'0.72rem', color:'var(--text-muted)', marginTop:-6, marginBottom:4 }}>Lower order = appears first</div>
      </div>
    </Modal>
  );
}

function flattenRules(group) {
  const flat = [];
  const walk = g => {
    (g.rules || []).forEach(r => {
      if (r.type === 'group') walk(r);
      else if (r.value || r.operator === 'between') {
        flat.push({ type: r.field, operator: r.operator || 'contains', value: r.value || '', value2: r.value2 || '' });
      }
    });
  };
  walk(group);
  return flat;
}
