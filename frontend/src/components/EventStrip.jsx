import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { EVENT_TIERS } from './eventTiers';
import '../eventStrip.css';

function EventCaption({ to, tier, title, children }) {
  const color = EVENT_TIERS[tier]?.color;
  return (
    <Link to={to} className="comic-caption event-caption" title={title} aria-label={title}
      style={color ? { '--event-accent': color } : undefined}>
      <span className="event-caption-text">{children}</span>
      <span aria-hidden="true">→</span>
    </Link>
  );
}

export function EventHomeCaptions({ events }) {
  if (!events?.length) return null;
  return (
    <nav className="event-home-captions" aria-label="Event reading orders">
      {events.map(event => {
        const tier = EVENT_TIERS[event.tier]?.label;
        return (
          <EventCaption key={event.id} to={'/events/' + encodeURIComponent(event.id)} tier={event.tier}
            title={`View the full ${event.name} event reading order with tie-ins${tier ? ' · ' + tier : ''}`}>
            {tier && tier + ' · '}{events.length > 1 && event.name + ' · '}Full event reading order
          </EventCaption>
        );
      })}
    </nav>
  );
}

export default function EventStrip({ bookId, events, current, hidden, homeEvents }) {
  const [open, setOpen] = useState(false);
  const visible = hidden ? [] : (events || []).filter(event => !homeEvents?.some(home => home.id === event.id));
  if (!visible.length && !current) return null;
  const caption = event => {
    const title = [event.name, EVENT_TIERS[event.eventTier]?.label, event.tier, 'Open at this issue'].filter(Boolean).join(' · ');
    return <EventCaption key={event.id} tier={event.eventTier} title={title}
      to={`/events/${encodeURIComponent(event.id)}?book=${encodeURIComponent(bookId)}`}>{event.name}</EventCaption>;
  };
  return (
    <div className="issue-tagrow series-event-tags">
      {visible.length > 0 && (
        <div className="event-caption-group">
          {caption(visible[0])}
          {visible.length > 1 && <button type="button" className="event-caption-more"
            aria-expanded={open} aria-label={open ? 'Hide additional events' : 'Also in ' + visible.slice(1).map(e => e.name).join(', ')}
            onClick={() => setOpen(!open)}>{open ? '−' : '+' + (visible.length - 1)}</button>}
          {open && visible.length > 1 && <div className="event-caption-others">{visible.slice(1).map(caption)}</div>}
        </div>
      )}
      {current && <span className="issue-here">▶ Reading</span>}
    </div>
  );
}
