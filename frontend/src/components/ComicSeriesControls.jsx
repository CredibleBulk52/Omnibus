import CoverSizeControl from './CoverSizeControl';
import React, { useId, useRef } from 'react';
import { useViewState } from '../hooks/useViewState';
import '../seriesControls.css';

export default function ComicSeriesControls({ compact, viewKey, activeCount, recent, onClear, alpha, children, selectionControls, resultCount }) {
  const [open, setOpen] = useViewState(viewKey && `${viewKey}:filters-open`, false);
  const panelId = useId();
  const toggle = useRef(null);
  if (!compact) return <>{selectionControls}{children}{alpha}</>;
  return <div className="series-controls">
    <div className="csb-navigation-rail">
    {alpha}
    <div className="csb-toolbar">
      <span className="csb-result" aria-live="polite">{resultCount.toLocaleString()} series</span>
      <button type="button" ref={toggle} className="series-filter-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        Find &amp; filter{activeCount > 0 ? ` · ${activeCount}` : ''} <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      <CoverSizeControl />
      {selectionControls}
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
