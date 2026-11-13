import CoverSizeControl, { CoverSizeChoices } from './CoverSizeControl';
import React, { useEffect, useId, useRef } from 'react';
import { useViewState } from '../hooks/useViewState';
import '../seriesControls.css';

// viewSwitch: a segmented view choice beside the count (series browser: Series · Shelved · No shelf).
// moreMenu: occasional actions (Select, Add a series) under "⋯", with the cover size; without it,
// the cover size keeps its own button (2026-11-13).
export default function ComicSeriesControls({ compact, viewKey, activeCount, recent, onClear, alpha, children, selectionControls, resultCount, viewSwitch = null, moreMenu = null }) {
  const [open, setOpen] = useViewState(viewKey && `${viewKey}:filters-open`, false);
  const panelId = useId();
  const toggle = useRef(null);
  if (!compact) return <>{selectionControls}{children}{alpha}</>;
  return <div className="series-controls">
    <div className="csb-navigation-rail">
    {alpha}
    <div className="csb-toolbar">
      {viewSwitch}
      <span className="csb-result" aria-live="polite">{resultCount.toLocaleString()} series</span>
      <button type="button" ref={toggle} className="series-filter-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        Find &amp; filter{activeCount > 0 ? ` · ${activeCount}` : ''} <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {selectionControls}
      {moreMenu ? <ToolbarMore>{moreMenu}</ToolbarMore> : <CoverSizeControl />}
    </div>
    </div>
    {(activeCount > 0 || recent) && <div className="csb-filter-state">
      <span>{activeCount > 0 ? `${activeCount} active filter${activeCount === 1 ? '' : 's'}` : ''}{recent ? ` · ${typeof recent === 'string' ? recent : 'Recent issue release'}` : ''}</span>
      <button type="button" className="series-filter-clear" onClick={onClear}>Reset all ×</button>
    </div>}
    <div id={panelId} className="series-filter-panel" hidden={!open} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } }}>
      {children}
    </div>
  </div>;
}

function ToolbarMore({ children }) {
  const ref = useRef(null);
  const close = () => ref.current?.removeAttribute('open');
  useEffect(() => {
    const outside = e => { if (!ref.current?.contains(e.target)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details ref={ref} className="csb-more" onKeyDown={e => { if (e.key === 'Escape') { close(); ref.current.querySelector('summary').focus(); e.stopPropagation(); } }}>
    <summary aria-label="More: cover size, select, add" title="Cover size, select, add a series"><span aria-hidden="true">⋯</span></summary>
    <div className="csb-more-panel" onClick={e => { if (e.target.closest('button')) close(); }}>
      <div className="csb-more-label">Cover size</div>
      <CoverSizeChoices />
      <div className="csb-more-items">{children}</div>
    </div>
  </details>;
}
