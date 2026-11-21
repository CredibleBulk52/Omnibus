import React from 'react';

// Event tiers (crisis, major, crossover) and their comic ★ badge: the Timeline, an event's page and
// the reader's end card (moved from pages/EventsPage.jsx 2026-11-21).
export const EVENT_TIERS = {
  1: {
    label: 'Crisis-Level Event',
    short: 'Crisis',
    color: 'color-mix(in srgb, var(--td-red) 80%, white)',
    border: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 40%, transparent)',
    bg: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 12%, transparent)',
    gradient:
      'linear-gradient(180deg, color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 22%, transparent) 0%, color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 5%, transparent) 65%, transparent 100%), var(--bg-surface)',
    stripe: 'linear-gradient(180deg, #e05555 0%, #a83838 100%)',
    stars: 3,
  },
  2: {
    label: 'Major Event',
    short: 'Major',
    color: 'var(--td-yellow)',
    border: 'color-mix(in srgb, var(--td-yellow) 40%, transparent)',
    bg: 'color-mix(in srgb, var(--td-yellow) 10%, transparent)',
    gradient:
      'linear-gradient(180deg, color-mix(in srgb, var(--td-yellow) 20%, transparent) 0%, color-mix(in srgb, var(--td-yellow) 4%, transparent) 65%, transparent 100%), var(--bg-surface)',
    stripe: 'linear-gradient(180deg, #f5c518 0%, #b58a10 100%)',
    stars: 2,
  },
  3: {
    label: 'Crossover Arc',
    short: 'Crossover',
    color: '#4a8ccc',
    border: 'rgba(74,140,204,0.4)',
    bg: 'rgba(74,140,204,0.10)',
    gradient:
      'linear-gradient(180deg, rgba(74,140,204,0.20) 0%, rgba(74,140,204,0.04) 65%, transparent 100%), var(--bg-surface)',
    stripe: 'linear-gradient(180deg, #4a8ccc 0%, #2a5a8c 100%)',
    stars: 1,
  },
};

// ─── Tier Badge ───────────────────────────────────────────────────
// Comic-style label — Bangers font + clip-path bevel, matches .tag treatment.
export function TierBadge({ tier }) {
  const t = EVENT_TIERS[tier];
  if (!t) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 13px 3px 9px',
        fontFamily: "'Bangers', cursive",
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'color-mix(in srgb, var(--om-base) 70%, black)',
        background: t.color,
        clipPath: 'polygon(0 0, 100% 0, 94% 100%, 0 100%)',
        border: '2px solid #000',
        lineHeight: 1.2,
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: 0, color: 'color-mix(in srgb, var(--om-base) 70%, black)' }}>
        {'★'.repeat(t.stars)}
      </span>
      {t.short}
    </span>
  );
}
