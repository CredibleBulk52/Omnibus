import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import ThemeArtwork from './ThemeArtwork';
import { refreshBranding } from './Branding';

// Themes ship no drawn emblems (2026-11-11): only art an admin uploaded under the theme's name.
test('a theme banner shows uploaded character art and nothing otherwise', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const prevFetch = global.fetch, prevURL = URL.createObjectURL;
  let assets = [];
  global.fetch = vi.fn(async url => String(url) === '/api/branding'
    ? { ok: true, json: async () => assets }
    : { ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
  URL.createObjectURL = () => 'blob:superman';
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), root = createRoot(host);
  try {
    await act(async () => { await refreshBranding(); root.render(<ThemeArtwork theme="superman" />); });
    expect(host.querySelector('image')).toBeNull();
    expect(host.querySelector('path')).toBeNull();
    assets = [{ kind: 'character', key: 'superman', version: 1 }];
    await act(async () => { await refreshBranding(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(host.querySelector('image').getAttribute('href')).toBe('blob:superman');
  } finally {
    act(() => root.unmount());
    global.fetch = prevFetch; URL.createObjectURL = prevURL;
  }
});
