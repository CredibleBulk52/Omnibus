import React, { useId } from 'react';
import { genreBadgeArt } from './genreBadgeArt';
import { storyBadgeArt } from './storyBadgeArt';
import { readerBadgeArt } from './readerBadgeArt';

// ─── Achievement badges (2026-11-10; pass 2: a glyph per family, label on a ribbon) ──
// Drawn in code so every achievement has a badge in one consistent comic look: a shape
// per group, the tier's metal (bronze, silver, gold, with 1–3 stars), halftone dots, a
// thick black outline with a hard shadow, the family's glyph in the middle and the
// badge's short label on a red ribbon. Libraries use the library's own colour; genres a
// colour of their own; Legendary Stories are purple-foil comic books. Locked badges are greyed by
// the page (CSS); a hidden one shows "?".
const METAL = { 1: ['#e8a86c', '#9c5a26'], 2: ['#f0f4f8', '#8f9ba8'], 3: ['#ffe36a', '#d99a00'] };

// Glyphs, drawn in a 48 × 48 box: f = filled shape (white, black outline), s = stroke only
// (a black line under a white one), c = circle [cx, cy, r], t = text.
const G = {
  trophy: [['f', 'M14,7 H34 V17 C34,26 29,30 24,30 C19,30 14,26 14,17 Z'], ['s', 'M14,11 H8 C8,19 11,22 15,22 M34,11 H40 C40,19 37,22 33,22'], ['f', 'M20,30 H28 V36 H20 Z'], ['f', 'M13,36 H35 V42 H13 Z']],
  shelf: [['f', 'M8,12 H16 V36 H8 Z'], ['f', 'M17,7 H25 V36 H17 Z'], ['f', 'M27,13 L34,11 L39,35 L32,37 Z'], ['f', 'M4,36 H44 V42 H4 Z']],
  film: [['f', 'M7,20 H41 V41 H7 Z'], ['f', 'M6,12 L39,6 L41,13 L8,19 Z'], ['s', 'M15,10 L18,17 M24,9 L27,15 M33,7 L36,14'], ['s', 'M13,28 H35 M13,34 H28']],
  star: [['f', 'M24,4 L29.5,17 L43.5,18 L32.8,27.3 L36.2,41 L24,33.6 L11.8,41 L15.2,27.3 L4.5,18 L18.5,17 Z']],
  burst: [['f', 'M24,3 L28,15 L39,8 L34,20 L46,24 L34,28 L39,40 L28,33 L24,45 L20,33 L9,40 L14,28 L2,24 L14,20 L9,8 L20,15 Z']],
  bolt: [['f', 'M28,3 L11,27 H22 L18,45 L37,19 H26 Z']],
  link: [['s', 'M20,30 L14,36 A6,6 0 0 1 6,28 L14,20 A6,6 0 0 1 22,20'], ['s', 'M28,18 L34,12 A6,6 0 0 1 42,20 L34,28 A6,6 0 0 1 26,28'], ['s', 'M19,29 L29,19']],
  book: [['f', 'M24,13 C18,9 11,9 5,11 V38 C11,36 18,36 24,40 C30,36 37,36 43,38 V11 C37,9 30,9 24,13 Z'], ['s', 'M24,13 V39']],
  stack: [['f', 'M8,32 L36,28 L40,34 L12,38 Z'], ['f', 'M7,24 L35,21 L38,27 L10,30 Z'], ['f', 'M9,15 L37,13 L39,19 L11,22 Z'], ['f', 'M10,7 L36,6 L37,12 L11,14 Z']],
  pen: [['f', 'M24,3 L35,21 L29,41 H19 L13,21 Z'], ['c', 24, 23, 3], ['s', 'M24,26 V38']],
  list: [['f', 'M10,8 H38 V43 H10 Z'], ['f', 'M18,4 H30 V11 H18 Z'], ['s', 'M16,20 H32 M16,27 H32 M16,34 H26']],
  sparkle: [['f', 'M24,3 C26,17 31,22 45,24 C31,26 26,31 24,45 C22,31 17,26 3,24 C17,22 22,17 24,3 Z']],
  calendar: [['f', 'M7,11 H41 V42 H7 Z'], ['f', 'M7,11 H41 V19 H7 Z'], ['s', 'M15,6 V14 M33,6 V14'], ['t', '1', 24, 37, 17]],
  one: [['c', 24, 24, 19], ['t', '#1', 24, 31, 20]],
  check: [['s', 'M8,25 L19,36 L41,11']],
  mountain: [['f', 'M2,42 L18,14 L26,28 L32,20 L46,42 Z'], ['s', 'M18,14 V4 L27,7 L18,10']],
  box: [['f', 'M5,18 H43 V42 H5 Z'], ['f', 'M3,11 H45 V19 H3 Z'], ['s', 'M18,27 H30']],
  heart: [['f', 'M24,42 C10,32 4,24 4,16 C4,9 9,5 15,5 C19,5 22,8 24,11 C26,8 29,5 33,5 C39,5 44,9 44,16 C44,24 38,32 24,42 Z']],
  stamp: [['f', 'M4,17 L24,5 L44,17 Z'], ['f', 'M8,19 H40 V22 H8 Z'], ['f', 'M10,22 H15 V36 H10 Z'], ['f', 'M21.5,22 H26.5 V36 H21.5 Z'], ['f', 'M33,22 H38 V36 H33 Z'], ['f', 'M5,36 H43 V42 H5 Z']],
  card: [['f', 'M5,10 H43 V40 H5 Z'], ['c', 15, 21, 5], ['s', 'M24,18 H37 M24,25 H37 M11,33 H37']],
  globe: [['c', 24, 24, 19], ['s', 'M5,24 H43 M24,5 C14,14 14,34 24,43 M24,5 C34,14 34,34 24,43']],
  hourglass: [['f', 'M10,4 H38 V8 C38,16 28,20 28,24 C28,28 38,32 38,40 V44 H10 V40 C10,32 20,28 20,24 C20,20 10,16 10,8 Z'], ['s', 'M17,40 H31']],
  palette: [['f', 'M24,5 C12,5 4,13 4,23 C4,34 13,43 24,43 C28,43 29,40 27,37 C25,34 27,31 31,31 H37 C42,31 44,28 44,23 C44,13 35,5 24,5 Z'], ['c', 14, 20, 3], ['c', 22, 13, 3], ['c', 32, 15, 3], ['c', 14, 31, 3]],
  flag: [['s', 'M10,44 V5'], ['f', 'M12,6 C20,2 27,10 38,6 V26 C27,30 20,22 12,26 Z']],
  scroll: [['f', 'M11,6 H37 V36 C37,40 34,42 31,42 H11 Z'], ['f', 'M6,36 H31 C31,40 34,42 31,42 H11 C8,42 6,40 6,36 Z'], ['s', 'M17,15 H31 M17,22 H31 M17,29 H26']],
  genre: [['f', 'M6,8 C14,12 34,12 42,8 C43,24 38,40 24,43 C10,40 5,24 6,8 Z'], ['f', 'M12,19 C14,16 19,16 21,19 C19,22 14,22 12,19 Z'], ['f', 'M27,19 C29,16 34,16 36,19 C34,22 29,22 27,19 Z'], ['s', 'M16,31 C20,36 28,36 32,31']],
  truck: [['f', 'M3,12 H29 V35 H3 Z'], ['f', 'M29,19 H38 L45,27 V35 H29 Z'], ['c', 13, 37, 5], ['c', 36, 37, 5]],
  flame: [['f', 'M24,3 C27,13 38,18 38,30 C38,38 32,44 24,44 C16,44 10,38 10,30 C10,22 16,19 17,11 C21,15 22,19 22,23 C26,19 26,10 24,3 Z']],
  clock: [['c', 24, 24, 19], ['s', 'M24,12 V24 L32,30']],
  couch: [['f', 'M9,14 H39 V26 H9 Z'], ['f', 'M3,22 H11 V40 H3 Z'], ['f', 'M37,22 H45 V40 H37 Z'], ['f', 'M10,26 H38 V36 H10 Z']],
  medal: [['f', 'M14,3 H22 L28,18 H20 Z'], ['f', 'M34,3 H26 L20,18 H28 Z'], ['c', 24, 31, 13], ['t', '1', 24, 37, 16]],
  mail: [['f', 'M4,11 H44 V39 H4 Z'], ['s', 'M5,12 L24,28 L43,12']],
  wrench: [['f', 'M30,4 C24,4 20,10 22,16 L5,33 C3,35 3,39 5,41 C7,43 11,43 13,41 L30,24 C36,26 42,22 42,16 L35,20 L29,17 L28,11 L34,6 C33,5 31,4 30,4 Z']],
  speech: [['f', 'M5,8 H43 V32 H22 L12,42 L14,32 H5 Z'], ['c', 15, 20, 2.5], ['c', 24, 20, 2.5], ['c', 33, 20, 2.5]],
  hash: [['s', 'M18,6 L14,42 M32,6 L28,42 M8,17 H41 M6,31 H39']],
  moon: [['f', 'M30,4 C20,6 13,15 13,25 C13,35 21,43 31,44 C26,40 23,33 23,25 C23,16 27,8 30,4 Z'], ['f', 'M38,10 L39.5,14 L43.5,15.5 L39.5,17 L38,21 L36.5,17 L32.5,15.5 L36.5,14 Z']],
  saber: [['s', 'M10,40 L36,10'], ['f', 'M5,45 L3,43 L11,35 L15,37 L13,41 Z']],
  pumpkin: [['f', 'M24,13 C34,11 45,17 45,28 C45,39 35,44 24,43 C13,44 3,39 3,28 C3,17 14,11 24,13 Z'], ['s', 'M24,14 V7 L29,4 M17,15 C13,22 13,34 17,42 M31,15 C35,22 35,34 31,42']],
  gift: [['f', 'M6,19 H42 V43 H6 Z'], ['f', 'M4,13 H44 V20 H4 Z'], ['s', 'M24,13 V43 M24,13 C20,6 13,6 15,11 C16,13 20,13 24,13 C28,13 32,13 33,11 C35,6 28,6 24,13']],
  cake: [['f', 'M6,26 H42 V43 H6 Z'], ['f', 'M10,17 H38 V26 H10 Z'], ['s', 'M24,17 V9'], ['f', 'M24,2 C27,5 27,8 24,9 C21,8 21,5 24,2 Z']],
  split: [['t', 'VS', 24, 33, 24]],
  team: [['c', 16, 14, 7], ['c', 33, 16, 6], ['f', 'M3,42 C3,30 9,24 16,24 C23,24 29,30 29,42 Z'], ['f', 'M27,42 C27,32 30,26 33,26 C39,26 45,31 45,42 Z']],
  loop: [['s', 'M38,18 A15,15 0 0 0 10,20 M10,30 A15,15 0 0 0 38,28'], ['f', 'M38,9 L41,22 L29,19 Z'], ['f', 'M10,39 L7,26 L19,29 Z']],
  question: [['t', '?', 24, 39, 40]],
};

function shapePath(group) {
  const star = (n, ro, ri) => Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? ri : ro, a = (Math.PI * i) / n - Math.PI / 2;
    return `${i ? 'L' : 'M'}${(62 + r * Math.cos(a)).toFixed(1)},${(58 + r * Math.sin(a)).toFixed(1)}`;
  }).join('') + 'Z';
  const poly = (n, r, rot = -Math.PI / 2) => Array.from({ length: n }, (_, i) => {
    const a = rot + (2 * Math.PI * i) / n;
    return `${i ? 'L' : 'M'}${(62 + r * Math.cos(a)).toFixed(1)},${(58 + r * Math.sin(a)).toFixed(1)}`;
  }).join('') + 'Z';
  switch (group) {
    case 'paths': return 'M62,6 L108,20 L104,66 C100,90 84,104 62,113 C40,104 24,90 20,66 L16,20 Z';   // shield
    case 'milestones': return star(12, 54, 43);                                                     // starburst
    case 'libraries': return star(24, 53, 47);                                                      // stamp with a notched edge
    case 'eras': return poly(6, 54, 0);                                                             // hexagon
    case 'habits': return poly(8, 53, Math.PI / 8);                                                 // octagon
    case 'household': return 'M14,18 Q14,8 24,8 L100,8 Q110,8 110,18 L110,84 Q110,94 100,94 L60,94 L36,114 L40,94 L24,94 Q14,94 14,84 Z';   // speech balloon
    case 'secret': return 'M62,4 L116,58 L62,112 L8,58 Z';                                          // diamond
    case 'legendary': return 'M22,6 H102 Q110,6 110,14 V106 Q110,114 102,114 H22 Q14,114 14,106 V14 Q14,6 22,6 Z';   // a comic book
    default: return 'M62,4 A54,54 0 1,1 61.9,4 Z';                                                  // circle (genres)
  }
}

function Glyph({ name, paper = '#fff0c5', accent = '#ee9259' }) {
  const parts = G[name] || G.star;
  return (
    <g transform="translate(30 22) scale(1.34)">
      {parts.map((p, i) => {
        if (p[0] === 'f') return <path key={i} d={p[1]} fill={i % 2 ? accent : paper} stroke="#191822" strokeWidth="2.6" strokeLinejoin="round" />;
        if (p[0] === 's') return <g key={i}><path d={p[1]} fill="none" stroke="#000" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          <path d={p[1]} fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></g>;
        if (p[0] === 'c') return <circle key={i} cx={p[1]} cy={p[2]} r={p[3]} fill={accent} stroke="#191822" strokeWidth="2.6" />;
        return <text key={i} x={p[2]} y={p[3]} textAnchor="middle" fontFamily="Bangers, 'Comic Sans MS', sans-serif" fontSize={p[4]}
          fill="#fff" stroke="#000" strokeWidth="3" paintOrder="stroke">{p[1]}</text>;
      })}
    </g>
  );
}

const shelfBooks = { runs_1: 1, runs_5: 2, runs_10: 3, runs_25: 4 };
const spineColors = ['#bf4a51', '#56948e', '#7786ba', '#ddb866'];

function ShelfAward({ count }) {
  return (
    <g stroke="#25202c" strokeWidth="3" strokeLinejoin="round">
      {spineColors.slice(0, count).map((color, index) => (
        <g key={color} transform={`translate(${62 - 8 * count + index * 16} ${index % 2 ? 4 : 0}) rotate(${index === count - 1 ? 7 : 0} 8 66)`}>
          <path fill={color} d="M0 31 L14 28 V66 H0Z" />
          <path fill="#ffedbc" d="M2 38 L12 36 V42 L2 44Z" />
        </g>
      ))}
      <path fill="#b67c54" d="M21 69 H102 L96 77 H26Z" />
      {count === 4 && <path fill="#ffda69" d="M46 25 L54 28 L61 22 L68 28 L78 24 L74 33 H50Z" />}
    </g>
  );
}

const illustratedArt = { ...genreBadgeArt, ...storyBadgeArt };

function FeatureArt({ item }) {
  const { id, icon: fallback } = item;
  if (Object.prototype.hasOwnProperty.call(illustratedArt, id)) return illustratedArt[id];
  if (Object.prototype.hasOwnProperty.call(shelfBooks, id)) return <ShelfAward count={shelfBooks[id]} />;
  if (id === 'genre_noir') return (
    <g strokeLinejoin="round">
      <path fill="#171c34" d="M18 78 Q44 63 83 69 L105 79 Q65 91 18 82Z" />
      <path fill="#ffdc88" d="M50 43 L60 43 L81 76 Q57 82 35 75Z" />
      <path fill="#101522" d="M39 73 V27 Q39 18 48 18 H56 V24 H49 Q45 24 45 30 V73 L49 77 H34Z" />
      <path fill="#ffdc88" stroke="#101522" strokeWidth="4" d="M46 31 L55 22 L65 31 L61 45 H50Z" />
      <path stroke="#e5eff6" strokeWidth="3" d="M76 24 l-6 10 M90 38 l-7 12 M28 42 l-5 9 M49 74 h16 M55 80 h18" />
    </g>
  );
  if (id === 'story_dark_knight_returns') return (
    <g>
      <path fill="#21355b" d="M20 13 H104 V86 H20Z" />
      <path fill="#ffebae" d="M87 13 L49 46 H63 L35 80 L84 40 H67 L98 13Z" />
      <path fill="#101222" d="M27 65 Q40 41 61 43 L65 32 L69 40 L76 32 L77 47 L85 54 L93 55 L86 62 L76 59 L69 67 L82 76 L77 83 L61 72 L51 81 L40 82 L51 66 Q43 57 39 68 Q35 57 27 65Z" />
    </g>
  );
  if (id === 'issues_10') return (
    <g stroke="#191522" strokeWidth="3" strokeLinejoin="round">
      {[2, 1, 0].map(n => <path key={n} transform={`translate(0 ${n * 8})`} fill={n ? '#f5dfb4' : '#d54c42'} d="M26 48 L70 31 L99 45 L53 63Z" />)}
      <path fill="#ffe088" d="M49 46 l8 -2 2 -6 5 4 12 -3 -7 7 5 3 -12 1 -4 5 -2 -5 -9 1Z" />
    </g>
  );
  if (id === 'issues_100') return (
    <g transform="rotate(-9 62 53)" stroke="#201927" strokeLinejoin="round">
      <path fill="#ba3439" strokeWidth="3" d="M21 42 L33 42 L29 28 L46 33 L51 22 L61 31 L76 21 L77 34 L94 30 L90 44 L104 49 L93 58 L100 69 L82 68 L78 80 L64 72 L51 82 L46 71 L29 74 L32 61 L20 59 L28 51Z" />
      <text x="62" y="64" textAnchor="middle" fontFamily="Impact, sans-serif" fontWeight="900" fontSize="34" fill="#fff3bf" strokeWidth="3" paintOrder="stroke">100</text>
    </g>
  );
  if (id === 'issues_250') return (
    <g transform="rotate(9 62 52)" stroke="#19212e" strokeWidth="3" strokeLinejoin="round">
      <path fill="#acdce3" d="M39 20 H85 V80 H39Z" />
      <path fill="#fff2ce" d="M44 28 H80 V75 H44Z" />
      <path fill="#b43e49" d="M47 34 H76 V69 H47Z" />
      <path fill="#ffc96a" d="M65 38 L52 53 H60 L56 66 L72 48 H64Z" />
      <path fill="#e9f9ff" d="M39 20 H85 L76 29 H48Z" />
      <path stroke="#fff" d="M76 55 L69 68" />
    </g>
  );
  if (id === 'issues_500') return (
    <g transform="rotate(-32 61 53)" stroke="#251922" strokeWidth="4" strokeLinejoin="round">
      <path fill="#ffcd58" fillRule="evenodd" d="M26 51 A17 17 0 1 1 58 59 H98 V73 H89 V65 H81 V72 H73 V64 H54 A17 17 0 0 1 26 51Z M35 51 A7 7 0 1 0 49 51 A7 7 0 1 0 35 51Z" />
    </g>
  );
  if (id === 'issues_1000') return (
    <g stroke="#201926" strokeWidth="3" strokeLinejoin="round">
      <path fill="#c8444a" d="M64 34 Q46 34 32 48 L19 69 Q32 62 41 68 L35 79 Q52 74 66 58 L82 53Z" />
      <circle cx="68" cy="35" r="10" fill="#ffd195" />
      <path fill="#247294" d="M41 45 Q57 44 68 54 Q80 44 95 43 L90 72 Q76 71 66 81 Q57 72 43 71Z" />
      <path fill="none" stroke="#fff0bc" d="M68 55 L66 75 M48 51 Q57 52 62 57 M76 56 L88 50" />
    </g>
  );
  if (id !== 'issues_50') return readerBadgeArt(item) || <Glyph name={fallback} />;
  return (
    <g stroke="#191522" strokeWidth="3" strokeLinejoin="round">
      <path fill="#52404a" d="M24 48 L47 32 H100 L78 51Z" />
      {[0, 1].map(i => (
        <path key={i} transform={`translate(${-4 * i} ${3 * i})`} fill={i % 2 ? '#e3bb79' : '#b14a45'} d="M49 49 L48 26 H88 L89 49Z" />
      ))}
      <path fill="#f3deb5" d="M24 48 H78 V79 H24Z" />
      <path fill="#b88455" d="M78 48 L100 32 V63 L78 79Z" />
      <path fill="#211c26" d="M39 56 H62 V61 H39Z" />
    </g>
  );
}

export default function AchievementBadge({ item, size = 84, locked = false, className = '' }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const d = shapePath(item.group);
  let [light, dark] = METAL[item.tier] || METAL[1];
  if (item.group === 'genres' && item.hue != null) { light = `hsl(${item.hue} 75% 64%)`; dark = `hsl(${item.hue} 70% 36%)`; }
  if (item.group === 'libraries' && item.library?.color && item.tier === 1) { light = item.library.color; dark = item.library.color; }
  if (item.group === 'legendary') { light = '#d9b8ff'; dark = '#5b2aa8'; }   // Legendary Stories: purple foil
  if (locked) { light = '#696970'; dark = '#36363e'; }
  const masked = item.label === '?' || item.name === '???';
  const label = masked ? '' : String(item.label ?? '');
  const fs = label.length <= 3 ? 17 : label.length <= 5 ? 15 : label.length <= 7 ? 12.5 : 10.5;
  const stars = masked || ['genres', 'secret', 'legendary'].includes(item.group) ? 0 : Math.max(0, Math.min(3, item.tier || 0));
  return (
    <svg className={`ach-badge${locked ? ' locked' : ''} ${className}`} width={size} height={size} viewBox="0 0 128 128" role="img" aria-label={item.name}>
      <defs>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
        <pattern id={`p${uid}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <circle cx="3.5" cy="3.5" r="1.3" fill="#000" opacity="0.18" />
        </pattern>
        <clipPath id={`c${uid}`}><path d={d} /></clipPath>
      </defs>
      <path d={d} transform="translate(5 5)" fill="#000" />
      <path d={d} fill={`url(#g${uid})`} />
      <rect x="0" y="0" width="128" height="128" fill={`url(#p${uid})`} clipPath={`url(#c${uid})`} />
      <path d="M24,30 Q62,2 100,30" fill="none" stroke="#fff" strokeOpacity="0.45" strokeWidth="5" strokeLinecap="round" clipPath={`url(#c${uid})`} />
      <path d={d} fill="none" stroke="#000" strokeWidth="5" strokeLinejoin="round" />
      {masked ? <Glyph name="question" /> : <FeatureArt item={item} />}
      {stars > 0 && (
        <g className="ach-stars" fill="#fff" stroke="#000" strokeWidth="1.6">
          {Array.from({ length: stars }, (_, i) => {
            const x = 62 + (i - (stars - 1) / 2) * 14, y = 9;
            return <path key={i} d={`M${x},${y} l2.4,4.9 5.4,0.8 -3.9,3.8 0.9,5.4 -4.8,-2.5 -4.8,2.5 0.9,-5.4 -3.9,-3.8 5.4,-0.8Z`} />;
          })}
        </g>
      )}
      {label && (
        <g className="ach-ribbon">
          <path d="M8,84 H116 L108,95 L116,106 H8 L16,95 Z" transform="translate(3 3)" fill="#000" />
          <path d="M8,84 H116 L108,95 L116,106 H8 L16,95 Z" fill="#d41f26" stroke="#000" strokeWidth="3" strokeLinejoin="round" />
          <text x="62" y={95 + fs * 0.36} textAnchor="middle" fontFamily="Bangers, 'Comic Sans MS', sans-serif" fontSize={fs}
            fill="#fff" letterSpacing="0.6">{label}</text>
        </g>
      )}
    </svg>
  );
}
