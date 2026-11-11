import { CharacterSymbol } from './Branding';
import React from 'react';
import CoverHero, { CoverStack } from './CoverHero';
import ComicInkTitle from './ComicInkTitle';
import '../readingLists.css';
import '../readingTheme.css';
import '../readingOrderActions.css';
import '../readingOrderHero.css';

// The one hero for reading-order detail pages: Essential / reading list, Timeline event, Top Shelf run.
// The hero is the top of the page: back button over the cover stack, inked title, chips, then the
// page's own details (children), with the reading panel and entry tools on the right (actions).
// Colours come from the page's reading palette (character colours or the cover sampler) via themeStyle;
// without one they fall back to the Omnibus defaults.
export default function ReadingOrderHero({ title, back, covers = [], emptyText, chips, actions, themeStyle, className = '', children }) {
  return (
    <div className="rl-themed ro-hero-wrap" style={themeStyle}>
      <CoverHero inheritPalette className={`rl-hero hero-with-stack ro-hero ${className}`}>
        <div className="rl-hero-art">
          {back}
          <CoverStack bookIds={covers} emptyText={emptyText} />
        </div>
        <div className="rl-hero-body">
          <ComicInkTitle emblem={<CharacterSymbol title={title} />} title={title} className="rl-hero-title" />
          {chips && <div className="rl-chip-row">{chips}</div>}
          {children}
        </div>
        <div className="rl-hero-actions order-reading-actions">{actions}</div>
      </CoverHero>
    </div>
  );
}
