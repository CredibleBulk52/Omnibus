import { PublisherLogo, CharacterSymbol } from './Branding';
import React, { useEffect, useMemo, useState } from 'react';
import BackLink from './BackLink';
import { identifyPalette, paletteTokens, schemePalette } from '../themes/readingPalettes';
import { useAppearance, DEFAULT_COLORS } from './appearance';
import { FALLBACK_PALETTE, sampleSeriesPalette } from '../themes/seriesPalette.mjs';
import '../comicSeriesHero.css';
import '../readingOrderActions.css';
import InkTitle from './ComicInkTitle';

const cache = new Map();
function useSeriesPalette(title, coverUrl) {
  const { pageColors, colors } = useAppearance();
  const cover = pageColors ? coverUrl : null;
  const identity = useMemo(() => (pageColors ? identifyPalette(title) : null), [title, pageColors]);
  const [sample, setSample] = useState(null);
  useEffect(() => {
    if (identity || !cover) return;
    if (cache.has(cover)) { setSample({ cover, palette: cache.get(cover) }); return; }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 144;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, 96, 144);
        const palette = sampleSeriesPalette(ctx.getImageData(0, 0, 96, 144).data, 96, 144);
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(cover, palette); setSample({ cover, palette });
      } catch { /* Keep a readable neutral palette when artwork is unavailable. */ }
    };
    image.src = cover;
    return () => { cancelled = true; image.onload = null; };
  }, [identity, cover]);
  if (!pageColors) return schemePalette(colors || DEFAULT_COLORS);
  return identity || (sample?.cover === cover ? sample.palette : FALLBACK_PALETTE);
}

export default function ComicSeriesHero({ id, title, publisher, era, year, pubRun, status, totalIssues, owned, readCount = 0, unread, genres, userTags, description, badges, readingBook, resuming, resumeLabel, onRead, onDetails, onReadFirst, onPalette, tabs, actions, tools, bulkActions, notice }) {
  const cover = `/api/series/${id}/thumbnail`;
  const palette = useSeriesPalette(title, cover);
  const { colors } = useAppearance();
  const style = useMemo(() => ({ ...paletteTokens(palette, colors || DEFAULT_COLORS), '--csh-cover': `url("${cover}")`, '--csh-depth': palette.secondary }), [palette, cover, colors]);
  useEffect(() => { onPalette?.(style); }, [style, onPalette]);
  const pages = Number(readingBook?.media?.pagesCount) || 0;
  const page = Math.max(0, Number(readingBook?.readProgress?.page) || 0);
  const completed = !!readingBook?.readProgress?.completed;
  const progress = pages ? Math.min(100, (completed ? pages : page) / pages * 100) : 0;
  const seriesTotal = Math.max(Number(totalIssues) || 0, Number(owned) || 0);
  const seriesRead = Math.min(seriesTotal, Math.max(0, Number(readCount) || 0));
  const issue = readingBook?.issue_number || readingBook?.metadata?.number || '—';
  return <div className="comic-series-overview" style={style}>
    <section className="comic-series-hero" aria-label="Series overview">
    <div className="csh-topline">
      <BackLink follow to="/series" label="Series" className="csh-back" />
      {publisher && <span className="csh-publisher"><PublisherLogo name={publisher} size="hero" /></span>}
    </div>
    <div className="csh-editorial">
      <img className="csh-cover" src={cover} alt={`${title} cover`} />
      <div className="csh-heading">
        <InkTitle emblem={<CharacterSymbol title={String(title || '')} />} title={String(title || 'Untitled series')} />
        <p className="csh-meta">{[pubRun || (year && !String(title || '').includes(String(year)) ? year : null), era, status, totalIssues > 0 ? `${totalIssues} issues` : `${owned} owned`, owned > 0 && totalIssues > 0 && owned !== totalIssues ? `${owned} owned` : null, unread > 0 ? `${unread} unread` : null].filter(Boolean).join(' · ')}</p>
        <div className="csh-genres">{genres.map(g => <span key={g}>{g}</span>)}</div>
        {userTags.length > 0 && <div className="csh-user-tags">{userTags.map(t => <span key={t}>{t}</span>)}</div>}
      </div>
      <div className="csh-story">
        {description && <p>{description}</p>}
        <button className="csh-about" onClick={onDetails}>About this series ↗</button>
        <div className="csh-badges">{badges}</div>
      </div>
    </div>
    <div className="csh-side">
      {readingBook ? <aside className="csh-caption" aria-label="Continue reading">
      <span className="csh-caption-label">{resuming ? 'Back to the action' : completed ? 'Read it again' : 'Your next issue'}</span>
      {seriesTotal > 0 && <div className="csh-series-summary">
        <div className="csh-series-counts"><strong>{seriesRead} / {seriesTotal} read</strong><span>{owned} in library</span></div>
        <div className="csh-track" role="progressbar" aria-label="Series reading progress" aria-valuemin={0} aria-valuemax={seriesTotal} aria-valuenow={seriesRead}><span style={{ width: (seriesRead / seriesTotal * 100) + '%' }} /></div>
      </div>}
      <img src={`/api/books/${readingBook.id}/thumbnail`} alt={`Issue ${issue} cover`} />
      <div className="csh-progress-copy"><h2>Issue #{issue}</h2><span>{resuming ? `Page ${page}${pages ? ` of ${pages}` : ''}` : completed ? 'Completed' : 'Ready to read'}</span>
        {pages > 0 && <div className="csh-track" role="progressbar" aria-label="Issue reading progress" aria-valuemin={0} aria-valuemax={pages} aria-valuenow={Math.min(pages, completed ? pages : page)}><span style={{ width: `${progress}%` }} /></div>}
      </div>
      <button className="csh-resume" onClick={onRead}>{resumeLabel}</button>
      {onReadFirst && <button type="button" className="csh-read-first" onClick={onReadFirst}>Read from #1</button>}
    </aside> : <aside className="csh-caption csh-empty"><span className="csh-caption-label">The story awaits</span><p>No owned issues to read yet.</p></aside>}
      {/* Page tools under the next-issue card, as on Event, Top Shelf run and Essential pages:
          Pull control with inherited reading-order action styles. */}
      {(actions || tools) && <div className="csh-side-tools">{actions && <div className="order-utility-actions csh-entry-actions">{actions}</div>}{tools}</div>}
    </div>
    {bulkActions && <div className="csh-bulk">{bulkActions}</div>}
    {notice && <p className="csh-notice" role="status">{notice}</p>}
  </section>
  {tabs}
  </div>;
}
