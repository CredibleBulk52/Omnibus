import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ThemeArtwork from './ThemeArtwork';
import GenericThemeArtwork from './ThemeArtworkGeneric';
import { refreshBranding } from './Branding';
import { PRESETS } from './appearance';

// Without uploads a theme shows its built-in generic scene; uploaded character art replaces it (2026-11-12).
test('a theme banner shows the generic scene until an admin uploads character art', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const prevFetch = global.fetch, prevURL = URL.createObjectURL;
  let assets = [];
  global.fetch = vi.fn(async url => String(url) === '/api/branding'
    ? { ok: true, json: async () => assets }
    : { ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
  URL.createObjectURL = () => 'blob:superman';
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), root = createRoot(host);
  try {
    await act(async () => { await refreshBranding(); root.render(<ThemeArtwork theme="superman" span={900} />); });
    expect(host.querySelector('image')).toBeNull();
    expect(host.querySelector('path')).not.toBeNull();
    assets = [{ kind: 'character', key: 'superman', version: 1 }];
    await act(async () => { await refreshBranding(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('image').getAttribute('href')).toBe('blob:superman');
  } finally {
    act(() => root.unmount());
    global.fetch = prevFetch; URL.createObjectURL = prevURL;
  }
});

test('every theme has a generic scene at narrow and wide spans, and public names name no character', () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), root = createRoot(host);
  try {
    for (const p of PRESETS) for (const span of [360, 620, 2400]) {
      act(() => root.render(<GenericThemeArtwork theme={p.id} span={span} />));
      expect(host.children.length).toBeGreaterThan(0);
      expect(host.innerHTML).not.toMatch(/NaN|undefined/);
    }
    for (const p of PRESETS) expect(p.name).not.toBe(p.character);
  } finally { act(() => root.unmount()); }
});
