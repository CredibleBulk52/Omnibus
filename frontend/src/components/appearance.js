// Per-user colours (2026-10-27). Four roots plus an optional action color drive the whole palette through CSS variables
// (App.css :root --om-*), so a change recolours the app immediately. The choice is cached in
// this browser (so it applies before the first paint) and saved to the user's account.
import { useSyncExternalStore } from 'react';
import { characterThemes, themeGroups } from '../themes/characterThemes.js';


export const DEFAULT_COLORS = { base: '#0f0f16', secondary: '#e8151f', highlight: '#f5c518', text: '#f0f0f0' };
export const COLOR_ROLES = [
  { key: 'base', label: 'Base', hint: 'Page and panel backgrounds' },
  { key: 'secondary', label: 'Secondary', hint: 'Banners and shelf accents' },
  { key: 'action', label: 'Action', hint: 'Main buttons; follows Secondary unless customized' },
  { key: 'highlight', label: 'Highlight', hint: 'Highlights, active tabs and titles' },
  { key: 'text', label: 'Text', hint: 'Main text' },
];
export const PRESET_GROUPS = themeGroups;   // one list unless an install's local file groups them (2026-11-12)
const KEY = 'omnibus.appearance';
const VAR = { base: '--om-base', secondary: '--om-secondary', highlight: '--om-highlight', text: '--om-text' };
const HEX = /^#[0-9a-f]{6}$/i;

// ── colour maths (WCAG contrast) ──
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export const mixHex = (a, b, t) => toHex(rgb(a).map((v, i) => v * (1 - t) + rgb(b)[i] * t));
const lum = h => rgb(h).map(v => v / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const isDark = h => lum(h) < 0.2;
// Nudge a colour towards white or black until it reads on the background.
export function readableOn(color, bg, min = 4.5) {
  let c = color; const to = isDark(bg) ? '#ffffff' : '#000000';
  for (let i = 0; i < 30 && contrast(c, bg) < min; i++) c = mixHex(c, to, 0.1);
  return c;
}
export function actionColor(c) { return c.action || c.secondary; }
export function actionInk(c) {
  if (!c.action || contrast(c.highlight,c.action)>=4.5) return c.highlight;
  return contrast('#ffffff',c.action)>=contrast('#08090c',c.action)?'#ffffff':'#08090c';
}
export function sameColors(a,b) {
  return Object.keys(DEFAULT_COLORS).every(k=>a[k]?.toLowerCase()===b[k]?.toLowerCase()) &&
    (a.action||'').toLowerCase()===(b.action||'').toLowerCase() && (a.bannerText||'').toLowerCase()===(b.bannerText||'').toLowerCase();
}
export const PRESETS = characterThemes;

// Readability problems for a set of colours (shown in the menu).
export function checkColors(c) {
  const out = [];
  if (contrast(c.text, c.base) < 4.5) out.push({ key: 'text', msg: 'Text is hard to read on the base colour.' });
  if (contrast(c.highlight, c.base) < 3) out.push({ key: 'highlight', msg: 'Highlight is hard to see on the base colour.' });
  if (contrast(c.bannerText || c.highlight, c.secondary) < 3) out.push({ key: 'secondary', msg: 'Banner text may be hard to read. Darken the secondary colour or choose a more contrasting highlight.' });
  if (!isDark(c.base)) out.push({ key: 'base', msg: 'Omnibus is designed for dark backgrounds; some pages may look off on a light base.' });
  return out;
}

// ── store ──
function valid(p) {
  const colors = p?.colors && Object.keys(VAR).every(k => HEX.test(p.colors[k] || '')) && (p.colors.action === undefined || HEX.test(p.colors.action)) && (p.colors.bannerText === undefined || HEX.test(p.colors.bannerText)) ? { ...p.colors } : null;
  // aiInfo: admins' ⓘ AI cost details and AI activity feed (2026-11-09), on unless switched off.
  return { colors, pageColors: p?.pageColors !== false, themeId: PRESETS.some(t=>t.id===p?.themeId)?p.themeId:null, decorations:p?.decorations!==false, aiInfo:p?.aiInfo!==false };
}
function readCache() { try { return valid(JSON.parse(localStorage.getItem(KEY))); } catch { return valid(null); } }
let state = readCache();
const listeners = new Set();
function apply() {
  if (typeof document === 'undefined') return;   // loaded outside a browser (Node helper tests)
  const root = document.documentElement.style;
  if(state.themeId && state.decorations)document.documentElement.dataset.characterTheme=state.themeId;else delete document.documentElement.dataset.characterTheme;
  if(state.colors?.bannerText)root.setProperty('--om-banner-text',state.colors.bannerText);else root.removeProperty('--om-banner-text');
  for (const k of Object.keys(VAR)) {
    const v = state.colors?.[k];
    if (v && v.toLowerCase() !== DEFAULT_COLORS[k]) root.setProperty(VAR[k], v); else root.removeProperty(VAR[k]);
  }
  if (state.colors?.action) {
    root.setProperty('--om-action',state.colors.action);
    root.setProperty('--om-on-action',actionInk(state.colors));
  } else {
    root.removeProperty('--om-action'); root.removeProperty('--om-on-action');
  }
}
let saveStatus = 'saved';
let snap = { ...state, saveStatus };
function emit() { snap = { ...state, saveStatus }; listeners.forEach(l => l()); }
// Snapshot for React: { colors, pageColors, saveStatus } ('saved' | 'saving' | 'error').
export const getAppearance = () => snap;
export const currentColors = () => state.colors || DEFAULT_COLORS;
export function useAppearance() {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, getAppearance, getAppearance);
}

let saveTimer = null;
let lastSaved = JSON.stringify(state);
export function setAppearance(next, { save = true } = {}) {
  state = valid({ ...state, ...next });
  if (state.colors && sameColors(state.colors,DEFAULT_COLORS)) state = { ...state, colors: null };
  apply();
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  emit();
  if (save) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }
}
async function saveNow() {
  const body = JSON.stringify(state);
  if (body === lastSaved) return;
  saveStatus = 'saving'; emit();
  try {
    const r = await fetch('/api/users/me/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!r.ok) throw new Error();
    lastSaved = body; saveStatus = 'saved';
  } catch { saveStatus = 'error'; }
  emit();
}
// After sign-in: the account's choice wins over this browser's cache.
let loadedFor = null;
export async function loadAppearance(token) {
  if (token && loadedFor === token) return;
  try {
    const r = await fetch('/api/users/me/appearance');
    if (!r.ok) return;
    const p = valid(await r.json());
    loadedFor = token || null;
    lastSaved = JSON.stringify(p);
    setAppearance(p, { save: false });
  } catch { /* offline: keep the cached choice */ }
}
// On sign-out: back to the Omnibus colours so the next person does not inherit them.
export function clearAppearance() {
  clearTimeout(saveTimer); loadedFor = null; saveStatus = 'saved';
  state = valid(null); lastSaved = JSON.stringify(state);
  try { localStorage.removeItem(KEY); } catch {}
  apply(); emit();
}
apply();
