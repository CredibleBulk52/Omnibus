import { useMemo } from 'react';
import { identifyPalette, paletteTokens, schemePalette, contrast } from '../themes/readingPalettes';
import { useAppearance, DEFAULT_COLORS } from './appearance';
import useCoverPalette from './useCoverPalette';
import '../readingTheme.css';

// Reading palette for a list, event or run: character colours when the title names a known
// character or team, otherwise colours sampled from the cover. With "page colours" switched
// off in Appearance, the user's own scheme is used everywhere instead.
export function useReadingTheme(list, bookId) {
  const appearance = useAppearance();
  const pageColors = appearance.pageColors;
  const identity = useMemo(() => (pageColors ? identifyPalette(list?.name) : null), [list?.name, pageColors]);
  const regional = useCoverPalette(pageColors && !identity ? bookId : null);
  const root = appearance.colors || DEFAULT_COLORS;
  const style = useMemo(() => {
    const tokens = paletteTokens(pageColors ? identity || regional : schemePalette(root), root);
    const secondary = pageColors ? tokens["--rl-theme-button"] : root.secondary;
    const accent = tokens["--rl-theme-accent"];
    const onSecondary = contrast(accent, secondary) >= 3 ? accent : (contrast('#ffffff', secondary) >= contrast('#08090c', secondary) ? '#ffffff' : '#08090c');
    return {...tokens, "--rl-theme-secondary": secondary, "--rl-theme-on-secondary-accent": onSecondary};
  }, [identity, regional, pageColors, root]);
  return { style, identity, identityApplied: !!identity, hasCover: !!bookId };
}
