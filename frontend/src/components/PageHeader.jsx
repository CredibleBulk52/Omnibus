import React from 'react';
import { useAppearance } from './appearance';
import ThemeMotif from './ThemeMotif';

// Unique SVG path seeds so each page gets a slightly different border
const BORDERS = [
  "M3 2.8 C20 1.5,80 1,200 1.5 C350 2,500 1.8,683 2.2 C684 2.2,684.5 2.8,684.5 3.5 L684.5 50.5 C684.5 51.2,684 51.8,683 51.8 C520 52.5,300 52.8,100 52.5 C50 52.3,15 52,3.5 51.5 C2.5 51.5,2 51,2 50.2 L2 3.8 C2 3.2,2.5 2.8,3 2.8 Z",
  "M2.8 3 C18 1.8,75 1.2,220 1.6 C400 2,560 1.9,683 2.4 C684 2.4,684.8 2.9,684.8 3.6 L684.8 50.3 C684.8 51.1,684 51.7,683 52 C540 52.6,320 52.9,150 52.5 C70 52.3,20 52,3 51.5 C2.2 51.4,1.8 51,1.8 50.2 L1.8 4 C1.8 3.3,2.2 2.8,2.8 3 Z",
  "M3 2.5 C25 1.5,100 1,300 1.5 C450 2,600 1.8,683 2.3 C684 2.3,684.8 2.8,684.8 3.5 L684.8 50.5 C684.8 51.2,684.2 51.7,683 52 C540 52.6,320 52.9,150 52.6 C70 52.4,20 52,3.5 51.6 C2.5 51.5,1.8 51,1.8 50.2 L1.8 3.8 C1.8 3.2,2.3 2.7,3 2.5 Z",
  "M2.5 3 C15 2,60 1.3,200 1.6 C380 2,560 1.8,683 2.4 C684 2.4,684.5 2.9,684.5 3.6 L684.5 50.3 C684.5 51.1,684 51.6,683 51.9 C600 52.6,400 52.9,200 52.6 C90 52.3,25 52,3 51.5 C2.3 51.4,1.8 51,1.8 50.2 L1.8 4 C1.8 3.3,2.1 2.8,2.5 3 Z",
  "M3 3 C40 1.8,150 1.2,340 1.5 C500 1.8,620 2,683 2.5 C684 2.5,684.5 3,684.5 3.8 L684.5 50.2 C684.5 51,684 51.5,683 51.8 C580 52.5,380 52.8,180 52.5 C80 52.3,25 52,3.5 51.5 C2.5 51.5,2 51,2 50.2 L2 4 C2 3.3,2.4 2.8,3 3 Z",
  "M3 2.8 C30 1.6,120 1,340 1.5 C520 1.9,640 2.1,683 2.5 C684 2.5,684.5 3,684.5 3.8 L684.5 50.2 C684.5 51,684 51.5,683 51.8 C600 52.5,380 52.8,200 52.5 C80 52.2,20 51.9,3.5 51.4 C2.5 51.3,2 50.9,2 50.1 L2 3.8 C2 3.2,2.4 2.8,3 2.8 Z",
];

let borderIndex = 0;

// The red banner at the top of most pages (2026-10-27: one large inked title, no subtitle;
// curated pages use it too). note: large secondary text on the dark side (e.g. Timeline years).
export default function PageHeader({ title, note, children, borderSeed = 0, titleTag: TitleTag = 'h1' }) {
  const {themeId,decorations}=useAppearance();
  const path = BORDERS[borderSeed % BORDERS.length];
  return (
    <div className="page-header" data-motif={decorations?themeId:undefined}>
      <div className="page-header-dots" />
      <div className="page-header-dots-r" />
      {decorations && <ThemeMotif theme={themeId} />}
      <div className="page-header-content">
        <TitleTag className="page-title">{title}</TitleTag>
        {(note || children) && (
          <div className="page-header-actions">
            {note && <span className="page-header-note">{note}</span>}
            {children}
          </div>
        )}
      </div>
      <svg className="page-header-border" viewBox="0 0 686 54" preserveAspectRatio="none">
        <path d={path} fill="none" stroke="#000" strokeWidth="4.5"
          strokeLinejoin="round" strokeLinecap="round"/>
        <path d={path.replace(/L[\d.]+ [\d.]+.*Z/, '')}
          fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1.5"/>
      </svg>
    </div>
  );
}
