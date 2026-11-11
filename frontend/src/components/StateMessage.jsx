import React from 'react';
import '../stateMessage.css';

// ─── Shared loading, empty and error messages (2026-10-26) ─────────
// One look for each; the page supplies the wording. The loading mark is the
// Omnibus logo (a 5 KB copy, the same art as the sidebar), turning slowly;
// with "reduce motion" it pulses instead.
export function Loading({ label = 'Loading…', compact = false }) {
  return (
    <div className={`state-loading${compact ? ' state-compact' : ''}`} role="status">
      <div className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children, action, icon }) {
  return (
    <div className="state-empty">
      {icon && <div className="state-empty-icon" aria-hidden="true">{icon}</div>}
      {title && <div className="state-empty-title">{title}</div>}
      {children && <div className="state-empty-text">{children}</div>}
      {action && <div className="state-empty-action">{action}</div>}
    </div>
  );
}

export function ErrorNote({ title, children, onRetry }) {
  return (
    <div className="state-error" role="alert">
      <div className="state-error-text">{title && <strong>{title}</strong>}{title && children ? ' ' : ''}{children}</div>
      {onRetry && <button type="button" className="btn btn-secondary" onClick={onRetry}>Try again</button>}
    </div>
  );
}
