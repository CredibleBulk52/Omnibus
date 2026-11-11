// Match the existing 164px covers, 12px gap and 90px More tile.
export function readingShelfLayout(width, total) {
  const available = Math.max(0, width);
  const full = Math.max(1, Math.floor((available + 12) / 176));
  const moreBelow = available < 266;
  const count = total <= full || moreBelow ? full : Math.max(1, Math.floor((available - 90) / 176));
  return { count: Math.min(total, count), moreBelow };
}
