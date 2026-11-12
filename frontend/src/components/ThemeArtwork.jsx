import React from 'react';
import { useBranding, assetFor, useBrandingImage } from './Branding';
import { characterThemes } from '../themes/characterThemes';
import GenericThemeArtwork from './ThemeArtworkGeneric';

// Banner artwork for an app theme. In order (2026-11-12):
// 1. an installation's own ThemeArtwork.local.jsx (git-ignored, never published);
// 2. character art an admin uploaded for the theme (Branding, kind "character");
// 3. the built-in generic scene (ThemeArtworkGeneric.jsx: no characters or logos).
const artworkModules = import.meta.glob('./ThemeArtwork.local.jsx', { eager: true, import: 'default' });
const LocalArtwork = artworkModules['./ThemeArtwork.local.jsx'];
export const hasLocalArtwork = !!LocalArtwork;

export default function ThemeArtwork({ theme, span }) {
  if (LocalArtwork) return <LocalArtwork theme={theme} span={span} />;
  return <UploadedArtwork theme={theme} span={span} />;
}

function UploadedArtwork({ theme, span }) {
  const assets = useBranding();
  const character = characterThemes.find(t => t.id === theme)?.character;
  const url = useBrandingImage(character ? assetFor(assets, 'character', character) : null);
  if (!url) return <GenericThemeArtwork theme={theme} span={span} />;
  return <image href={url} x={-120} y={12} width={240} height={216} preserveAspectRatio="xMidYMid meet" opacity=".92" />;
}
