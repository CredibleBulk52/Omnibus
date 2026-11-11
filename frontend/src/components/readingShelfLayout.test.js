import { readingShelfLayout } from './readingShelfLayout';
test('uses the whole row when every issue fits', () => {
  expect(readingShelfLayout(516, 3)).toEqual({count: 3, moreBelow: false});
});
test('reserves a More tile without wrapping a cover', () => {
  expect(readingShelfLayout(516, 12).count).toBe(2);
  expect(readingShelfLayout(442, 12).count).toBe(2);
  expect(readingShelfLayout(441, 12).count).toBe(1);
});
test('moves More below on narrow screens and handles empty shelves', () => {
  expect(readingShelfLayout(240, 12)).toEqual({count: 1, moreBelow: true});
  expect(readingShelfLayout(0, 0).count).toBe(0);
});
test('responds to desktop resizing without exceeding available width', () => {
  for (let width = 266; width < 2200; width++) {
    const { count } = readingShelfLayout(width, 30);
    expect(count * 164 + count * 12 + 90).toBeLessThanOrEqual(width);
  }
});
