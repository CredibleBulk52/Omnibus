import { isSpread, markSpread, setRightToLeft } from './spreadCovers';

test('wide covers are spreads; portrait and square covers are not', () => {
  expect(isSpread(1988, 1530)).toBe(true);
  expect(isSpread(1000, 1530)).toBe(false);
  expect(isSpread(1000, 1000)).toBe(false);
  expect(isSpread(0, 0)).toBe(false);
});

test('only issue and series cover images are marked, and the mark follows the image', () => {
  const img = document.createElement('img');
  const size = (w, h) => { Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true }); Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true }); };
  img.src = 'http://x/api/books/42/thumbnail';
  size(2000, 1500); markSpread(img); expect(img.classList.contains('cover-spread')).toBe(true);
  size(1000, 1500); markSpread(img); expect(img.classList.contains('cover-spread')).toBe(false);
  const other = document.createElement('img');
  other.src = 'http://x/api/books/42/pages/3';
  Object.defineProperty(other, 'naturalWidth', { value: 2000 }); Object.defineProperty(other, 'naturalHeight', { value: 1500 });
  markSpread(other); expect(other.classList.contains('cover-spread')).toBe(false);
});

test('manga (right to left) spreads are marked to show their left half, once the server has listed them', () => {
  global.fetch = vi.fn(() => new Promise(() => {}));   // the list arrives below
  const img = document.createElement('img');
  Object.defineProperty(img, 'naturalWidth', { value: 2000 }); Object.defineProperty(img, 'naturalHeight', { value: 1500 });
  img.src = 'http://x/api/books/77/thumbnail';
  document.body.appendChild(img);
  markSpread(img);
  expect(img.classList.contains('cover-spread')).toBe(true);
  expect(img.classList.contains('cover-spread-rtl')).toBe(false);
  expect(global.fetch).toHaveBeenCalledWith('/api/covers/right-to-left');
  setRightToLeft({ books: ['77'], series: [] });               // spreads already shown are marked again
  expect(img.classList.contains('cover-spread-rtl')).toBe(true);
  const series = document.createElement('img');
  Object.defineProperty(series, 'naturalWidth', { value: 2000 }); Object.defineProperty(series, 'naturalHeight', { value: 1500 });
  series.src = 'http://x/api/series/5/thumbnail';
  markSpread(series);
  expect(series.classList.contains('cover-spread-rtl')).toBe(false);
  img.remove();
});
