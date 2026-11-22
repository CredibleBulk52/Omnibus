import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import EventStrip, { EventHomeCaptions } from './EventStrip';

it('links the home event once and opens additional events at the issue', async () => {
  const home = { id: 'home', name: 'Core event', tier: 2 };
  const events = [
    { ...home, tier: 'essential', eventTier: 2 },
    { id: 'side', name: 'Side event', tier: 'recommended', eventTier: 3 },
    { id: 'other', name: 'Other event' },
  ];
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<MemoryRouter>
      <EventHomeCaptions events={[home]} />
      <EventStrip bookId="book/8" events={events} homeEvents={[home]} current />
    </MemoryRouter>));
    const hrefs = () => [...node.querySelectorAll('a')].map(link => link.getAttribute('href'));
    expect(hrefs()).toEqual(['/events/home', '/events/side?book=book%2F8']);
    expect(node.textContent).toContain('Major Event');
    expect(node.textContent).toContain('Reading');
    expect(node.querySelector('[title^="Side event"]').title).toContain('Crossover Arc');
    await act(async () => node.querySelector('button').click());
    expect(hrefs()).toContain('/events/other?book=book%2F8');
    expect(node.querySelector('[title^="Other event"]').style.getPropertyValue('--event-accent')).toBe('');
  } finally {
    await act(async () => root.unmount());
  }
});
