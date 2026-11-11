import React from 'react';
import { useNavigate } from 'react-router-dom';
import { previousPage, pageName } from './navTrail';
import '../backLink.css';

// ─── Shared back button (2026-10-26, claude/FOLLOW_UPS.md item 17) ──
// Top left of the page, in the page's own colours (--rl-theme-*), Comic yellow
// where a page has none. It names where it goes.
//   <BackLink to="/events" label="Timeline" />  — goes to its catalog; if you
//     came from there it goes back instead, so the catalog keeps your place.
//   <BackLink follow to="/series" label="Series" /> — goes back to whatever
//     page you came from and names it; with no earlier page, opens `to`.
// `match` widens which earlier pages count as "the catalog" (a RegExp).
export default function BackLink({ to, label, follow = false, match, className = '', style }) {
  const navigate = useNavigate();
  const prev = previousPage();
  let text = label, go = () => navigate(to);
  if (follow && prev) { text = pageName(prev.path); go = () => navigate(-1); }
  else if (!follow && prev && (match ? match.test(prev.path) : prev.path === to)) {
    go = () => navigate(-1);
    if (match) text = pageName(prev.path);   // e.g. My Comic Boxes or The Comic Box, whichever it came from
  }
  return (
    <button type="button" className={`back-link${className ? ` ${className}` : ''}`} style={style} onClick={go}>
      <span aria-hidden="true">←</span> {text}
    </button>
  );
}
