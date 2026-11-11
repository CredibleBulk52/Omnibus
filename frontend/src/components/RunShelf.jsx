import React, { useEffect, useRef, useState } from 'react';
import ShelfRow from './ShelfRow';


// Hero covers for a run: spread across the run (1st, 5th, 9th owned issue).
export function runCoverIds(issues) {
  const ids = [...new Set(issues.map(issue => issue.scanned_book_id).filter(Boolean))];
  return [ids[0], ids[4] || ids[1], ids[8] || ids[2]].filter(Boolean);
}

export default function RunShelf({ issues, renderIssue }) {
  const ref = useRef(null);
  const [layout, setLayout] = useState({ cols: 1, gap: 12, phone: false });
  useEffect(() => {
    const measure = () => {
      const width = ref.current?.clientWidth || 0;
      const available = Math.max(164, width - 40);
      const cols = Math.max(1, Math.floor((available + 12) / 176));
      setLayout({
        cols,
        gap: cols > 1 ? (available - cols * 164) / (cols - 1) : 0,
        phone: window.innerWidth < 600,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return (
    <div ref={ref}>
      {layout.phone ? (
        <div className="issues-bookshelf">
          <div className="shelf-wall" style={{ padding: '16px 0 0' }}>
            <div className="issues-books">
              {issues.map((issue, index) => renderIssue(issue, index, false))}
            </div>
          </div>
          <div className="shelf-plank" />
        </div>
      ) : (
        <div className="run-shelf-rows">
          {Array.from(
            { length: Math.ceil(issues.length / layout.cols) },
            (_, row) => {
              const start = row * layout.cols;
              return (
                <ShelfRow
                  key={row}
                  books={issues.slice(start, start + layout.cols)}
                  cols={layout.cols}
                  gap={layout.gap}
                  bookWidth={164}
                  bookHeight={246}
                  renderBook={(issue, index) =>
                    renderIssue(issue, start + index, true)
                  }
                  renderLabel={(issue, index) => (
                    <>
                      <span className="shelf-book-label">
                        #{issue.issue_number ?? start + index + 1}
                      </span>
                      {issue.series_name && (
                        <span className="shelf-book-count">
                          {issue.series_name}
                        </span>
                      )}
                    </>
                  )}
                />
              );
            },
          )}
        </div>
      )}
    </div>
  );
}
