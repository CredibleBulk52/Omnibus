// ─── Skin ─────────────────────────────────────────────────────────
// Comic is the only skin. The Comic (OLD), Wood and Panel skins were
// retired on 2026-10-26 (claude/FOLLOW_UPS.md item 17).
//
// The data-theme="comic" attribute on <html> stays because CSS still
// uses it as a hook. The old per-browser choice is cleared on load.

const STORAGE_KEY = 'omnibus.skin';

export function bootstrapSkin() {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', 'comic');
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
bootstrapSkin();
