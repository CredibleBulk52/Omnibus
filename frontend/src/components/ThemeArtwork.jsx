import React from 'react';
import { useBranding, assetFor, useBrandingImage } from './Branding';
import { characterThemes } from '../themes/characterThemes';

// Banner artwork for an app theme (2026-11-11). Omnibus ships no character emblems: a theme
// shows the character art an admin uploaded under the theme's name (Settings › Branding,
// kind "character", e.g. "Superman"), the same art Essentials cards use. Nothing uploaded,
// nothing drawn: the theme keeps its colours.
export default function ThemeArtwork({ theme }) {
  const assets = useBranding();
  const name = characterThemes.find(t => t.id === theme)?.name;
  const url = useBrandingImage(name ? assetFor(assets, 'character', name) : null);
  if (!url) return null;
  return <image href={url} x={-120} y={12} width={240} height={216} preserveAspectRatio="xMidYMid meet" opacity=".92" />;
}
