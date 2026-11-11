import React from 'react';
import '../curatedMast.css';
import '../curatedPage.css'; // shared page width; delete this line to roll it back

// The shared top for the curated catalog pages (Timeline, Top Shelf, Essentials, Reading Lists),
// in the Timeline design: two-line headline, label + intro, a tilted stamp, then a row for the
// page's own controls (stats, New button) passed as children. The small eyebrow line moved into
// the red PageHeader banner above it on 2026-10-27.
// stamp: lines of text; the last one is highlighted.
export default function CuratedMast({ title, titleEm, label, intro, stamp, className = '', children }) {
  return (
    <header className={`cm-mast ${className}`}>
      <h1>{title}{titleEm && <><br /><em>{titleEm}</em></>}</h1>
      {(label || intro) && (
        <div className="cm-intro">
          {label && <strong>{label}</strong>}
          {intro && <p>{intro}</p>}
        </div>
      )}
      {stamp?.length > 0 && (
        <div className="cm-stamp" aria-hidden="true">
          {stamp.map((line, i) => (
            <React.Fragment key={i}>
              {i > 0 && <br />}
              {i === stamp.length - 1 ? <b>{line}</b> : line}
            </React.Fragment>
          ))}
        </div>
      )}
      {children && <div className="cm-actions">{children}</div>}
    </header>
  );
}
