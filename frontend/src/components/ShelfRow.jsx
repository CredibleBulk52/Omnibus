import React from 'react';

export default function ShelfRow({
  books,
  cols,
  gap,
  renderBook,
  renderLabel,
  bookWidth = 150,
  bookHeight = 225,
}) {
  const pads = Math.max(0, cols - books.length);
  return (
    <div className="shelf-section">
      <div className="bookshelf">
        <div className="shelf-wall">
          <div className="shelf-row" style={{ padding: `14px ${20}px 0`, gap }}>
            {books.map((s, index) => (
              <React.Fragment key={s.id}>{renderBook(s, index)}</React.Fragment>
            ))}
            {Array.from({ length: pads }).map((_, i) => (
              <div
                key={`ph${i}`}
                style={{
                  width: bookWidth,
                  flexShrink: 0,
                  height: bookHeight,
                  visibility: 'hidden',
                }}
                aria-hidden
              />
            ))}
          </div>
        </div>
        <PlankWithLabels
          books={books}
          cols={cols}
          gap={gap}
          bookWidth={bookWidth}
          renderLabel={renderLabel}
        />
      </div>
    </div>
  );
}

// ─── Plank ────────────────────────────────────────────────────────
function PlankWithLabels({ books, cols, gap, bookWidth, renderLabel }) {
  const pads = Math.max(0, cols - books.length);
  return (
    <div
      className="shelf-plank shelf-plank-inline"
      style={{
        height: 58,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 20,
        paddingRight: 20,
        gap,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          pointerEvents: 'none',
          background:
            'linear-gradient(90deg,transparent,rgba(255,255,255,0.22) 20%,rgba(255,255,255,0.30) 50%,rgba(255,255,255,0.22) 80%,transparent)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'linear-gradient(90deg,transparent,rgba(255,255,255,0.04) 25%,rgba(255,255,255,0.07) 50%,rgba(255,255,255,0.04) 75%,transparent)',
        }}
      />
      {books.map((s, index) => (
        <div
          key={s.id}
          style={{
            width: bookWidth,
            flexShrink: 0,
            overflow: 'hidden',
            textAlign: 'center',
          }}
        >
          {renderLabel ? (
            renderLabel(s, index)
          ) : (
            <>
              <span className="shelf-book-label">
                {s.displayTitle || s.metadata?.title || s.name || ''}
              </span>
              {s.book_count > 0 && (
                <span className="shelf-book-count">
                  {s.book_count} issue{s.book_count !== 1 ? 's' : ''}
                </span>
              )}
            </>
          )}
        </div>
      ))}
      {Array.from({ length: pads }).map((_, i) => (
        <div
          key={`lp${i}`}
          style={{ width: bookWidth, flexShrink: 0 }}
          aria-hidden
        />
      ))}
    </div>
  );
}
