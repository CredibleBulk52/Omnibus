import useBoxArtwork from './useBoxArtwork';
import {pullRequest,PULL_CHANGED,FavoritesMigration} from './PullBox';
import {getUser} from '../App';
import '../comicSeriesHero.css';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useLibrary } from '../App';
import { EVENT_TIERS } from '../pages/EventsPage';
import { selectLists, featuredList } from '../pages/listCatalog';
import { useReadingTheme } from './ReadingTheme';
import { RichText, CoverFan } from './ReadingListBits';
import { dailyItem, publicRuns, runDestination, rotatedItem } from './homeSelection';

function Cover({ src, name = '', className = '' }) {
  src = useBoxArtwork(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img className={className} src={src} alt={name} loading="lazy" onError={() => setFailed(true)} /> : <div className={`hp-cover-fallback ${className}`} aria-hidden="true">✦</div>;
}

// One image moves from its measured crop into a full-cover reveal.
function RevealCover({src,name}) {
 const frame=useRef(null);const [ratio,setRatio]=useState(2/3);const [size,setSize]=useState({w:0,h:0});
 useEffect(()=>{setRatio(2/3);},[src]);
 useEffect(()=>{const el=frame.current;if(!el)return;const update=()=>setSize({w:el.clientWidth,h:el.clientHeight});update();const observer=new ResizeObserver(update);observer.observe(el);return()=>observer.disconnect();},[]);
 const {w,h}=size;const iw=Math.max(w,h*ratio),ih=iw/ratio,x=(w-iw)/2,y=(h-ih)*.25;
 const scale=1.03;
 const px=v=>iw?(v-x)/iw*100:0,py=v=>ih?(v-y)/ih*100:0;
 const style={'--reveal-rest':`translate(${x}px,${y}px) scale(1)`,'--reveal-open':`translate(${(w-iw*scale)/2}px,${y-12}px) scale(${scale})`,'--reveal-crop':`polygon(${px(w*.08)}% ${py(0)}%,${px(w)}% ${py(0)}%,${px(w)}% ${py(h)}%,${px(0)}% ${py(h)}%)`,width:iw,height:ih};
 return <div className="hp-reveal-frame" ref={frame}>{src ? <img className="hp-reveal-cover" src={src} alt={name || ''} style={style} onLoad={e=>setRatio(e.currentTarget.naturalWidth/e.currentTarget.naturalHeight)} /> : <div className="hp-cover-fallback">✦</div>}</div>;
}

async function read(url) { const r = await fetch(url); if (!r.ok) throw new Error('Unable to load this selection.'); return r.json(); }

export default function HomeFeatures({ discoverSeries = [], releases, controlsTarget }) {
  const { activeLibrary, libraries } = useLibrary();
  const [data, setData] = useState({});
  const [rotations, setRotations] = useState({});
  const libraryKey = String(activeLibrary?.id || 'all');
  const rotation = rotations[libraryKey] || 0;
  useEffect(() => {
    let active = true; setData({});
    const requests = { runs: '/api/canon/runs/shelf', lists: '/api/reading-lists?scope=essential', events: '/api/events', boxes: `/api/collections${activeLibrary ? `?libraryId=${encodeURIComponent(activeLibrary.id)}` : ''}` };
    // A missing curated catalog never hides Continue Reading or other panels.
    Object.entries(requests).forEach(([key,url]) => read(url).then(value => { if (active) setData(prev => ({...prev,[key]:value})); }).catch(() => { if (active) setData(prev => ({...prev,[key]:null})); }));
    return () => { active = false; };
  }, [activeLibrary]);
  const runPool = publicRuns(data.runs || {}, false);
  const run = rotatedItem(runPool, dailyItem(publicRuns(data.runs || {})), rotation);
  const listPool = selectLists(data.lists?.lists || [], {library:activeLibrary,libraries});
  const essential = rotatedItem(listPool, featuredList(listPool), rotation);
  const events = Array.isArray(data.events) ? data.events.filter(e => !e.draft) : [];   // admins also get drafts; never on Home
  // Match the timeline's unambiguous publisher-library default; other libraries retain the complete timeline.
  const pub = /^(dc|marvel)(?: comics)?$/i.test(activeLibrary?.name || '') ? activeLibrary.name.replace(/ comics$/i,'').toLowerCase() : null;
  const eventPool = pub ? events.filter(e => String(e.publisher || '').replace(/ comics$/i,'').toLowerCase() === pub) : events;
  const event = rotatedItem(eventPool, dailyItem(eventPool), rotation);
  const boxPool = (Array.isArray(data.boxes) ? data.boxes : []).filter(b => !b.owner_id);
  const box = rotatedItem(boxPool, dailyItem(boxPool), rotation);
  const series = rotatedItem(discoverSeries, dailyItem(discoverSeries), rotation);
  const canRotate = [runPool,listPool,eventPool,boxPool,discoverSeries].some(pool=>pool.length>1);
  const runTheme = useReadingTheme({name:run?.title}, run?.coverBookId);
  const essentialTheme = useReadingTheme({name:essential?.name}, essential?.progress?.cover_book_ids?.[0]);
  const runLabels = [...new Set([...(run?.categories || []).map(c => ({award_winning:'Award winning',adapted_to_screen:'Adapted to screen',critically_acclaimed:'Critically acclaimed'})[c.category]), run?.awards?.length ? 'Award winning' : null].filter(Boolean))];
  const tier = EVENT_TIERS[event?.event_tier] || EVENT_TIERS[2];
  const tierLabel = tier.label;
  const cards = [
    {kind:'run',item:run, tint:runTheme.style['--rl-theme-main'], theme:runTheme.style, distinction:runLabels.join(' · '), label:'Top Shelf · Great runs', title:run?.title, description:run?.description, meta:'Legendary runs, award winners, and staff picks.', image:run?.coverBookId && `/api/books/${run.coverBookId}/thumbnail`, to:run && runDestination(run), catalog:'/canon', action:'Explore Top Shelf', fallback:'Find your next great read', detail:'Read this run'},
    {kind:'essential',item:essential, tint:essentialTheme.style['--rl-theme-main'], theme:essentialTheme.style, glow:essentialTheme.style['--rl-theme-accent'], distinction:essential?.progress?.total ? `${essential.progress.total} issues in this journey · ${essential.progress.read || 0} read` : null, label:'Essentials · Character journeys', title:essential?.name, description:essential?.description, meta:essential?.progress?.total ? `${essential.progress.total} issues · ${essential.progress.read || 0} read` : 'Origins. Turning points. Lasting legends.', image:essential?.progress?.cover_book_ids?.[0] && `/api/books/${essential.progress.cover_book_ids[0]}/thumbnail`, to:essential && `/essentials/${essential.id}`, catalog:'/essentials',action:'Find your hero',fallback:'Every hero starts somewhere',detail:'Explore this journey'},
    {kind:'event',item:event, tint:tier.color, distinction:[event?.year,tierLabel,event?.publisher].filter(Boolean).join(' · '),label:'Timeline · Events in order',title:event?.name,description:event?.description,meta:'The big stories, in reading order.',image:event?.thumbnail_book_id ? `/api/books/${event.thumbnail_book_id}/thumbnail` : event?.cover_image,to:event && `/events/${event.id}`,catalog:'/events',action:'Journey Through the Timeline',fallback:'Worlds collide. History unfolds.',detail:'Follow this event'}
  ];
  const refreshControl = <div className="hp-refresh-controls"><button type="button" className="hp-refresh" disabled={!canRotate} title="Rotate Must Reads and Browse selections" onClick={()=>setRotations(prev=>({...prev,[libraryKey]:(prev[libraryKey] || 0)+1}))}><span aria-hidden="true">↻</span> Refresh picks</button><span className="hp-refresh-status" role="status">{rotation ? 'Featured selections refreshed.' : ''}</span></div>;
  return <>
    {controlsTarget ? createPortal(refreshControl, controlsTarget) : controlsTarget === undefined ? refreshControl : null}
    <div className="hp-grid"><div className="hp-curated">{cards.map(card => {
      const copy = {tagline:card.item?.home_tagline, description:card.item?.home_description};
      return <section className={`hp-panel hp-feature hp-feature-${card.kind}`} key={card.kind} style={{...card.theme,'--hp-identity':card.tint,'--hp-glow':card.glow}}>
        <div className="hp-feature-copy"><span className="hp-caption">{card.label}</span><h2>{copy?.tagline || card.title || card.fallback}</h2>{copy?.tagline && <strong className="hp-feature-name">{card.title}</strong>}
          <div className="hp-description">{copy?.description ? <p>{copy.description}</p> : card.description ? <RichText text={card.description} /> : <p>{card.meta}</p>}</div>
          {card.distinction && <p className="hp-distinction">{card.distinction}</p>}
          <div className="hp-links">{card.to && <Link className="comic-action hp-cta" to={card.to}>{card.detail} ↗</Link>}<Link className="hp-catalog-link" to={card.catalog}>{card.action} →</Link></div>
        </div><Link className="hp-feature-art" to={card.to || card.catalog} aria-label={card.title || card.action}>{card.kind === 'essential' && essential?.progress?.cover_book_ids?.length ? <CoverFan bookIds={essential.progress.cover_book_ids.slice(0,4)} /> : <RevealCover src={card.image} name={card.title} />}</Link>
      </section>;
    })}</div>{releases}</div>
    <div className="hp-browse">
      <section className="hp-panel hp-browse-series"><div className="hp-browse-copy"><span className="hp-kicker">Browse series</span><h2>A little curiosity.<br />A great discovery.</h2><p>Flip through everything in {activeLibrary?.name || 'your library'}.</p><Link className="comic-action hp-cta" to="/series">Browse all series ↗</Link></div>{series && <div className="hp-browse-detail"><strong>{series.displayTitle || series.metadata?.title || series.name}</strong>{(series.seriesJson?.description_text || series.metadata?.summary) && <div className="hp-browse-description"><RichText text={series.seriesJson?.description_text || series.metadata?.summary} /></div>}<Link className="comic-action hp-example hp-series-reveal-button" to={`/series/${series.id}`}>Explore series ↗</Link></div>}{series && <Link to={`/series/${series.id}`} className="hp-peek" aria-label={`Open ${series.displayTitle || series.name}`}><Cover src={`/api/series/${series.id}/thumbnail`} /></Link>}</section>
      <section className="hp-panel hp-browse-box"><div className="hp-browse-copy"><span className="hp-kicker">The Comic Box</span><h2>Open a new era.<br />Build your Box.</h2><p>Explore eras, worlds, and collections.</p><Link className="comic-action hp-cta" to="/collections">Explore the boxes ↗</Link></div>{box && <div className="hp-browse-detail"><strong>{box.name}</strong>{box.description && <div className="hp-browse-description"><RichText text={box.description} /></div>}<Link className="comic-action hp-example hp-series-reveal-button" to={`/collections/${box.id}`}>Explore {box.name.replace(/\s*\([^)]*\)/g, "").trim() || box.name} ↗</Link></div>}{box && <Link className="hp-box-art" to={`/collections/${box.id}`} aria-label={`Open ${box.name}`}><Cover src={box.cover_image ? `/api/collections/${box.id}/cover?v=${encodeURIComponent(box.cover_image)}` : null} /><b>{box.name}</b></Link>}</section>
    </div>
  </>;
}
export function ReleasePanel({items=[]}) {
 const key='omnibus-pull-tab:'+(getUser()?.id||'anonymous');
 const [mode,setMode]=useState(()=>{try{return localStorage.getItem(key)==='pull'?'pull':'all';}catch{return 'all';}});
 const [data,setData]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;const load=()=>pullRequest('/releases').then(d=>{if(active){setData(d);setError('');}}).catch(e=>{if(active)setError(e.message);});load();window.addEventListener(PULL_CHANGED,load);return()=>{active=false;window.removeEventListener(PULL_CHANGED,load);};},[key]);
 const choose=value=>{setMode(value);try{localStorage.setItem(key,value);}catch{}};
 const heading=<><div className="pull-release-tabs" role="group" aria-label="Release selection"><button aria-pressed={mode==='all'} onClick={()=>choose('all')}>Recently Released</button><button aria-pressed={mode==='pull'} onClick={()=>choose('pull')}>My Pulls</button></div><FavoritesMigration count={data?.favoritesCount} onChange={setData}/><p>{mode==='pull'?'From your Pull Box · All libraries':'Fresh issues. New chapters.'}</p></>;
 const empty=mode==='pull'?<div className="pull-empty">{error?<p role="alert">{error}</p>:!data?<p>Loading your pulls…</p>:<><p>{data.seriesIds?.length?'No dated releases are available for your pulled series yet. Pulling a series does not enable downloads.':'Choose + Pull on a series to see its available releases here.'}</p><Link to="/my-pull-box">My Pull Box →</Link></>}</div>:<p className="hp-empty">No recent releases in this library yet.</p>;
 return <ReleaseRail key={mode} items={mode==='pull'?(data?.items||[]):items} heading={heading} empty={empty} showNewThisWeek={mode==='pull'} label={mode==='pull'?'Releases from My Pull Box':'Recently released issues'} />;
}
function releasedThisWeek(value) {
  const date=String(value || '').slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const released=Date.parse(date+'T00:00:00Z');
  const now=new Date();
  const age=(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate())-released)/86400000;
  return age>=0 && age<7;
}
function ReleaseRail({items=[],heading,empty,label,showNewThisWeek=false}) {
  const rail=useRef(null);const [edges,setEdges]=useState({start:true,end:true});
  useEffect(()=>{const el=rail.current;if(!el)return;const update=()=>{const horizontal=window.matchMedia('(max-width:599px)').matches;const position=horizontal?el.scrollLeft:el.scrollTop;const size=horizontal?el.clientWidth:el.clientHeight;const total=horizontal?el.scrollWidth:el.scrollHeight;setEdges({start:position<2,end:position+size>=total-2});};update();el.addEventListener('scroll',update,{passive:true});window.addEventListener('resize',update);const observer=new ResizeObserver(update);observer.observe(el);return()=>{observer.disconnect();el.removeEventListener('scroll',update);window.removeEventListener('resize',update);};},[items]);
  const move=direction=>{const el=rail.current;const horizontal=window.matchMedia('(max-width:599px)').matches;el.scrollBy({[horizontal?'left':'top']:direction*(horizontal?el.clientWidth:el.clientHeight)*.8,behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});};
  return <section className="hp-panel hp-recent">{heading}<div className="hp-releases" ref={rail} tabIndex={0} role="region" aria-label={label} onKeyDown={e=>{if(e.target===e.currentTarget && ['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();move(['ArrowDown','ArrowRight'].includes(e.key)?1:-1);}}}>
    {!items.length && empty}{items.map(item=><div className="hp-release" key={item.id}><Link className="hp-release-cover-link" to={`/series/${item.seriesId}`}><Cover src={`/api/books/${item.id}/thumbnail`} /></Link><div>{showNewThisWeek && releasedThisWeek(item.effective_date) && <span className="hp-release-new" title="Released in the past seven days">New this week</span>}<h3><Link to={`/series/${item.seriesId}`}>{item.seriesName || item.name}</Link></h3><span>Issue #{item.issue_number || '—'}</span>{item.completed != null && <small>{item.completed ? "Read" : "Unread"}</small>}{item.effective_date && <small>{item.effective_date.slice(0,10)}</small>}<span className="hp-release-ratings">{item.rating?.cbr_score != null && `★ ${Number(item.rating.cbr_score).toFixed(1)} critics`}{item.rating?.user_score != null && ` · ${Number(item.rating.user_score).toFixed(1)} readers`}</span><Link className="hp-read-action" to={`/read/${item.id}`}>Read now ▶</Link></div></div>)}
    </div><div className="hp-release-controls"><button disabled={edges.start} onClick={()=>move(-1)} aria-label="Previous releases">← Previous</button><button disabled={edges.end} onClick={()=>move(1)} aria-label="More releases">More →</button></div></section>;
}

