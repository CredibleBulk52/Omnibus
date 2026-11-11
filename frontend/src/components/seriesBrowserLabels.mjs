// Only detach a terminal volume year; preserve other parenthesized title text.
export function seriesLabel(series) {
  const raw = series.displayTitle || series.metadata?.title || series.name || '';
  const match = raw.match(/\s*\((\d{4})\)\s*$/);
  const candidate = String(series.displayYear || series.seriesJson?.year || '');
  const year = match?.[1] || (/^\d{4}$/.test(candidate) ? candidate : '');
  const title = match ? raw.slice(0, match.index).trim() : raw;
  return { title, year, fullTitle: year && !match ? `${raw} (${year})` : raw };
}
