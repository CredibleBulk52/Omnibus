import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import AchievementBadge from './AchievementBadge';

test('badges: one per achievement, with its glyph, its label on the ribbon, its tier\'s stars and a locked look', () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<>
    <AchievementBadge item={{ id: 'a', group: 'milestones', tier: 3, label: '500', name: 'Longbox Legend' }} />
    <AchievementBadge item={{ id: 'b', group: 'secret', tier: 2, label: '?', name: '???' }} locked />
  </>));
  const svgs = host.querySelectorAll('svg.ach-badge');
  expect(svgs).toHaveLength(2);
  expect(svgs[0].getAttribute('aria-label')).toBe('Longbox Legend');
  expect(svgs[0].querySelector('.ach-ribbon text').textContent).toBe('500');
  expect(svgs[0].querySelectorAll('.ach-stars path')).toHaveLength(3);   // gold: three stars
  expect(svgs[1].classList.contains('locked')).toBe(true);
  expect(svgs[1].querySelectorAll('.ach-stars path')).toHaveLength(0);   // secret badges have no stars
  expect(svgs[1].querySelector('.ach-ribbon')).toBeNull();               // a hidden one: just the "?"
  const ids = [...host.querySelectorAll('linearGradient')].map(g => g.id);
  expect(new Set(ids).size).toBe(2);                                    // each badge its own gradient
  act(() => root.unmount()); host.remove();
});
