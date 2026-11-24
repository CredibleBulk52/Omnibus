import React, { useState, useEffect } from 'react';
import { authHeader } from '../../App';
import { DirectoryPicker } from './AddSeriesModal';
import { FolderIcon } from './shared';

// ─── Settings panel ───────────────────────────────────────────────
// ─── Import Tab ───────────────────────────────────────────────────
function ConfidenceBadge({ score }) {
  const color = score >= 80 ? '#4caa60' : score >= 50 ? '#f5c518' : '#888';
  const label = score >= 80 ? 'High' : score >= 50 ? 'Medium' : 'Low';
  return (
    <span className="a-fs-10 a-fw7" style={{ padding: '1px 6px', borderRadius: 3, background: color + '22', color, border: `1px solid ${color}44` }}>
      {label} {score}%
    </span>
  );
}

// Loads the first-issue cover from disk via the backend extraction endpoint.
// Must use fetch() + blob URL because <img> tags cannot send the Authorization
// header that requireAuth demands — bare <img src> always gets a 401.
function DiskCoverThumb({ directory, width = 46, height = 66 }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'error'

  useEffect(() => {
    let objectUrl = null;
    const url = `/api/import/disk-cover?directory=${encodeURIComponent(directory)}`;
    fetch(url, { headers: authHeader() })
      .then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.blob();
      })
      .then(blob => {
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        setStatus('ok');
      })
      .catch(() => setStatus('error'));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [directory]);

  return (
    <div className="a-rel a-noshrink" style={{ width, height }}>
      {status !== 'ok' && (
        <div className="a-flex a-ai-c a-jc-c" style={{ position: 'absolute', inset: 0, background: 'var(--adm-g1)', borderRadius: 2 }}>
          {status === 'error'
            ? <span className="a-dim a-fs-18">?</span>
            : <span className="a-fs-10" style={{ color: 'var(--adm-g3)' }}>…</span>
          }
        </div>
      )}
      {blobUrl && (
        <img src={blobUrl} alt=""
          className="a-block" style={{ width, height, objectFit: 'cover', borderRadius: 2 }} />
      )}
    </div>
  );
}

function ImportSeriesRow({ item, selected, onToggle, onCvOverride }) {
  const [altOpen, setAltOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [customQuery, setCustomQuery] = useState(item.parsedName);
  const [rescanning, setRescanning] = useState(false);
  const [rescanResults, setRescanResults] = useState(null); // alternatives from manual search
  const cv = item.cvMatch;

  const rescan = async () => {
    setRescanning(true);
    try {
      const r = await fetch('/api/import/rescan-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: item.directory, query: customQuery }),
      });
      const d = await r.json();
      if (d.cvMatch?.alternatives) {
        // Show results as a pickable list — don't auto-apply
        setRescanResults(d.cvMatch.alternatives);
        setSearchOpen(false);
        setAltOpen(false); // close old alternatives, show rescan results instead
      }
    } catch {}
    setRescanning(false);
  };

  return (
    <div className="a-mb-6 a-ovh" style={{ background: selected ? 'color-mix(in srgb, var(--om-base) 95%, black)' : '#08080a', border: `1px solid ${selected ? 'color-mix(in srgb, var(--td-yellow) 27%, transparent)' : 'color-mix(in srgb, var(--om-base) 95%, white)'}`, borderRadius: 5 }}>
      {/* Main row */}
      <div className="dm-import-row a-flex a-ai-c a-gap-10" style={{ padding: '10px 12px' }}>
        {/* Checkbox */}
        <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${item.parsedName}`} disabled={item.alreadyAdded || !cv}
          onClick={() => onToggle(item.directory)}
          className="a-noshrink a-flex a-ai-c a-jc-c" style={{ width: 18, height: 18, borderRadius: 3, cursor: item.alreadyAdded ? 'default' : 'pointer', background: selected ? 'var(--td-yellow)' : 'var(--om-base)', border: `2px solid ${selected ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-base) 85%, white)'}` }}
        >
          {selected && <span className="a-fs-12" style={{ color: 'var(--adm-g0)', fontWeight: 900 }}>✓</span>}
        </button>

        {/* Covers: disk issue #1 (left) + CV match (right) */}
        <div className="a-flex a-gap-4 a-noshrink a-ai-e">
          <div className="a-flex a-col a-ai-c a-gap-2">
            <DiskCoverThumb directory={item.directory} width={46} height={66} />
            <span className="a-fs-10 a-mono a-upper" style={{ color: 'var(--adm-g4)', letterSpacing: '0.05em' }}>disk</span>
          </div>
          <div className="a-flex a-col a-ai-c a-gap-2">
            {cv?.image_url
              ? <img src={cv.image_url} alt="" className="a-block" style={{ width: 46, height: 66, objectFit: 'cover', borderRadius: 2 }} />
              : <div style={{ width: 46, height: 66, background: 'var(--om-base)', borderRadius: 2 }} />
            }
            <span className="a-fs-10 a-mono a-upper" style={{ color: 'var(--adm-g4)', letterSpacing: '0.05em' }}>cv</span>
          </div>
        </div>

        {/* Folder + file count */}
        <div className="dm-import-identity a-grow a-min0">
          <div className="a-text a-fw6 a-fs-13">{item.parsedName}</div>
          <div className="a-faint a-fs-11 a-mt-2 a-mono">
            {item.folderName} · {item.fileCount} file{item.fileCount !== 1 ? 's' : ''}
          </div>

        </div>

        {/* CV match */}
        {cv ? (
          <div className="dm-import-match a-ta-r" style={{ minWidth: 180 }}>
            <div className="a-flex a-ai-c a-gap-6 a-jc-e">
              <ConfidenceBadge score={cv.confidence} />
              {item.alreadyAdded && (
                <span className="a-fs-10 a-muted" style={{ padding: '1px 6px', borderRadius: 3, background: 'var(--adm-g3)' }}>
                  Already monitored
                </span>
              )}
            </div>
            {cv.cv_url
              ? <a href={cv.cv_url} target="_blank" rel="noopener noreferrer"
                  className="a-accent a-fs-12 a-mt-2 a-block" style={{ textDecoration: 'none' }}
                  onClick={e => e.stopPropagation()}
                  title="Open on Comic Vine">
                  {cv.name} ↗
                </a>
              : <div className="a-text2 a-fs-12 a-mt-2">{cv.name}</div>
            }
            <div className="a-faint a-fs-11">
              {cv.publisher} · {cv.year} · {cv.total_issues} issues
            </div>
            {cv.description && /trade paperback|collected edition|tpb|hardcover collection/i.test(cv.description) && (
              <div className="a-text2 a-fs-10 a-mt-2">⚠ may be collected edition</div>
            )}
            <div className="a-flex a-gap-6 a-jc-e a-mt-4 a-wrap">
              {(cv.alternatives?.length > 1) && (
                <button
                  className="adm-icon-btn a-fs-10 a-faint"
                  onClick={e => { e.stopPropagation(); setAltOpen(o => !o); setSearchOpen(false); setRescanResults(null); }}
                >
                  {altOpen ? '▲ Hide matches' : `▼ ${cv.alternatives.length - 1} other matches`}
                </button>
              )}
              <button
                className="adm-icon-btn a-fs-10 a-faint"
                onClick={e => { e.stopPropagation(); setSearchOpen(o => !o); setAltOpen(false); }}
                title="Search with custom terms"
              >🔍</button>
            </div>
          </div>
        ) : (
          <div className="dm-import-match a-ta-r">
            <div className="a-faint a-fs-12 a-mb-4">No CV match found</div>
            <button
              className="a-fs-10 a-muted a-ptr" style={{ padding: '2px 8px', borderRadius: 3, background: 'transparent', border: '1px solid var(--adm-g4)' }}
              onClick={e => { e.stopPropagation(); setSearchOpen(o => !o); }}
            >🔍 Search manually</button>
          </div>
        )}
      </div>

      {/* Manual search override */}
      {searchOpen && (
        <div className="a-flex a-gap-6 a-ai-c" style={{ borderTop: '1px solid var(--adm-g2)', background: 'var(--adm-g0)', padding: '8px 12px' }}>
          <input
            value={customQuery}
            onChange={e => setCustomQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !rescanning && rescan()}
            placeholder="Search terms, CV URL, or numeric ID..."
            className="a-grow a-text a-fs-12" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 3, padding: '4px 8px', outline: 'none' }}
            autoFocus
          />
          <button
            onClick={rescan} disabled={rescanning || !customQuery.trim()}
            className="a-fs-11 a-ptr" style={{ padding: '4px 12px', borderRadius: 3, background: rescanning ? 'var(--om-base)' : 'color-mix(in srgb, var(--td-yellow) 13%, transparent)', border: '1px solid color-mix(in srgb, var(--td-yellow) 27%, transparent)', color: rescanning ? 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))' : 'var(--td-yellow)' }}
          >{rescanning ? 'Searching…' : 'Search'}</button>
          <button onClick={() => setSearchOpen(false)}
            className="a-fs-11 a-ptr a-faint" style={{ padding: '4px 8px', borderRadius: 3, background: 'transparent', border: '1px solid var(--adm-g3)' }}>✕</button>
        </div>
      )}

      {/* Rescan results — shown after manual search, user picks one */}
      {rescanResults && (
        <div style={{ borderTop: '1px solid var(--om-base)', background: '#080808' }}>
          <div className="a-fs-10 a-faint a-mono a-upper" style={{ padding: '6px 12px 4px', letterSpacing: '0.1em' }}>
            Search results — click to select
            <button onClick={() => setRescanResults(null)}
              className="a-dim a-ptr a-fs-11" style={{ float: 'right', background: 'transparent', border: 'none' }}>✕</button>
          </div>
          {rescanResults.length === 0 && (
            <div className="a-faint a-fs-12" style={{ padding: '8px 12px' }}>No results found</div>
          )}
          {rescanResults.map((alt) => (
            <div key={alt.id}
              className="a-flex a-ai-c a-gap-8 a-ptr" style={{ padding: '7px 12px', borderBottom: '1px solid var(--adm-g1)', background: cv?.id === alt.id ? 'color-mix(in srgb, var(--om-base) 95%, black)' : 'transparent' }}
              onClick={() => { onCvOverride(item.directory, alt); setRescanResults(null); }}
            >
              {alt.image_url
                ? <img src={alt.image_url} alt="" className="a-noshrink" style={{ width: 40, height: 56, objectFit: 'cover', borderRadius: 2 }} />
                : <div className="a-noshrink" style={{ width: 40, height: 56, background: 'var(--adm-g1)', borderRadius: 2 }} />
              }
              <div className="a-grow">
                {alt.cv_url
                  ? <a href={alt.cv_url} target="_blank" rel="noopener noreferrer"
                      className="a-accent a-fs-12" style={{ textDecoration: 'none' }}
                      onClick={e => e.stopPropagation()}>{alt.name} ↗</a>
                  : <div className="a-text2 a-fs-12">{alt.name}</div>
                }
                <div className="a-faint a-fs-11">
                  {alt.publisher} · {alt.year} · {alt.total_issues} issues
                  {alt.description && /trade paperback|collected edition|tpb|hardcover collection/i.test(alt.description)
                    && <span className="a-text2 a-ml-6">· TPB?</span>}
                </div>
              </div>
              <ConfidenceBadge score={alt.confidence} />
              {cv?.id === alt.id && <span className="a-accent a-fs-11">✓ current</span>}
            </div>
          ))}
        </div>
      )}

      {/* Alternatives picker */}
      {altOpen && cv?.alternatives && (
        <div style={{ borderTop: '1px solid var(--om-base)', background: '#080808' }}>
          {cv.alternatives.map((alt, i) => (
            <div key={alt.id}
              className="a-flex a-ai-c a-gap-8 a-ptr" style={{ padding: '7px 12px', borderBottom: '1px solid var(--adm-g1)', background: cv.id === alt.id ? 'color-mix(in srgb, var(--om-base) 95%, black)' : 'transparent' }}
              onClick={() => { onCvOverride(item.directory, alt); }}
            >
              {alt.image_url
                ? <img src={alt.image_url} alt="" className="a-noshrink" style={{ width: 40, height: 56, objectFit: 'cover', borderRadius: 2 }} />
                : <div className="a-noshrink" style={{ width: 40, height: 56, background: 'var(--adm-g1)', borderRadius: 2 }} />
              }
              <div className="a-grow">
                {alt.cv_url
                  ? <a href={alt.cv_url} target="_blank" rel="noopener noreferrer"
                      className="a-accent a-fs-12" style={{ textDecoration: 'none' }}
                      onClick={e => e.stopPropagation()} title="Open on Comic Vine">
                      {alt.name} ↗
                    </a>
                  : <div className="a-text2 a-fs-12">{alt.name}</div>
                }
                <div className="a-faint a-fs-11">
                  {alt.publisher} · {alt.year} · {alt.total_issues} issues
                  {alt.description && /trade paperback|collected edition|tpb|hardcover collection/i.test(alt.description)
                    && <span className="a-text2 a-ml-6">· TPB?</span>}
                </div>
              </div>
              <ConfidenceBadge score={alt.confidence} />
              {cv.id === alt.id && <span className="a-accent a-fs-11">✓ selected</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ImportTab({ onImported }) {
  const [reviewFilter, setReviewFilter] = useState('all');
  const [scanPath, setScanPath] = useState('/comics');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState(null); // null = not scanned yet
  const [selected, setSelected] = useState(new Set());
  const [cvOverrides, setCvOverrides] = useState({}); // directory → cv object
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState(null);
  const [scanError, setScanError] = useState('');

  const scan = async () => {
    setScanning(true);
    setScanResults(null);
    setScanError('');
    setSelected(new Set());
    setCvOverrides({});
    setImportResults(null);
    try {
      const r = await fetch('/api/import/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanPath }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { setScanError(d.error || 'Scan failed'); }
      else {
        setScanResults(d.series || []);
        // Auto-select all non-already-monitored series with a CV match
        const autoSelect = new Set(
          (d.series || [])
            .filter(s => !s.alreadyAdded && (cvOverrides[s.directory] || s.cvMatch))
            .map(s => s.directory)
        );
        setSelected(autoSelect);
      }
    } catch (e) { setScanError(e.message); }
    setScanning(false);
  };

  const toggleAll = () => {
    const eligible = (scanResults || []).filter(s => !s.alreadyAdded && (cvOverrides[s.directory] || s.cvMatch)).map(s => s.directory);
    if (selected.size === eligible.length) setSelected(new Set());
    else setSelected(new Set(eligible));
  };

  const toggleOne = (dir) => {
    setSelected(s => {
      const n = new Set(s);
      n.has(dir) ? n.delete(dir) : n.add(dir);
      return n;
    });
  };

  const setCvOverride = (dir, cv) => {
    setCvOverrides(o => ({ ...o, [dir]: cv }));
  };

  const runImport = async () => {
    if (!selectedWithCv.length) return;
    setImporting(true);
    setImportResults(null);

    const selections = selectedWithCv.map(dir => {
      const item = scanResults.find(s => s.directory === dir);
      const cv = cvOverrides[dir] || item?.cvMatch;
      return {
        directory: dir,
        cvId: cv.id, name: cv.name, publisher: cv.publisher,
        year: cv.year, total_issues: cv.total_issues,
        image_url: cv.image_url, cv_url: cv.cv_url,
      };
    });

    try {
      const r = await fetch('/api/import/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections }),
      });
      const d = await r.json();
      if (!r.ok || !Array.isArray(d.results)) throw new Error(d.error || 'Import failed');
      setImportResults(d.results);
      if (onImported) onImported();
    } catch (e) {
      setImportResults([{ status: 'error', error: e.message }]);
    }
    setImporting(false);
  };

  const eligible = (scanResults || []).filter(s => !s.alreadyAdded && (cvOverrides[s.directory] || s.cvMatch));
  const selectedWithCv = [...selected].filter(dir => {
    const item = scanResults?.find(s => s.directory === dir);
    return cvOverrides[dir] || item?.cvMatch;
  });

  return (
    <div className="dm-import">
      <div className="dm-workflow-steps" aria-label="Import stages"><strong>1 · Scan folders</strong><strong>2 · Review matches</strong><strong>3 · Import results</strong></div>
      {/* Scan controls */}
      <div className="a-mb-16" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 6, padding: '14px 16px' }}>
        <div className="a-fs-11 a-muted a-fw7 a-upper a-mb-10" style={{ letterSpacing: '0.08em' }}>
          Scan Directory
        </div>
        <div className="a-flex a-gap-8 a-ai-c">
          <div className="a-mono a-fs-12 a-accent a-grow" style={{ background: 'var(--adm-g0)', border: '1px solid var(--adm-g3)', borderRadius: 4, padding: '6px 10px' }}>
            {scanPath}
          </div>
          <button className="adm-btn a-flex a-ai-c a-gap-6"
            disabled={scanning || importing} onClick={() => setPickerOpen(true)}>
            <FolderIcon /> Browse
          </button>
          <button className="adm-btn adm-btn-primary" style={{ minWidth: 80 }}
            onClick={scan} disabled={scanning || importing}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {scanning && (
          <div className="a-mt-10 a-fs-12 a-faint">
            Searching Comic Vine for each series — this may take a minute…
          </div>
        )}
        {scanError && <div className="a-mt-8 a-err a-fs-12">{scanError}</div>}
      </div>

      {/* Results */}
      {scanResults !== null && (
        <>
          {scanResults.length === 0 ? (
            <div className="adm-empty">No series directories found in {scanPath}</div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="a-flex a-ai-c a-gap-12 a-mb-10">
                <button className="adm-btn a-fs-12" style={{ padding: '4px 10px' }} disabled={importing} onClick={toggleAll}>
                  {selected.size === eligible.length && eligible.length > 0 ? 'Deselect All' : 'Select All'}
                </button>
                <span className="a-faint a-fs-12">
                  {selectedWithCv.length} of {eligible.length} matched series selected
                  {scanResults.filter(s => s.alreadyAdded).length > 0 &&
                    ` · ${scanResults.filter(s => s.alreadyAdded).length} already monitored`}
                </span>
                <div className="a-grow" />
                {selectedWithCv.length > 0 && !importResults && (
                  <button
                    className="adm-btn adm-btn-primary" style={{ opacity: importing ? 0.6 : 1 }}
                    onClick={runImport}
                    disabled={importing}
                  >
                    {importing ? 'Importing…' : `Import ${selectedWithCv.length} Series`}
                  </button>
                )}
              </div>

              {/* Import results summary */}
              {importResults && (
                <div className="a-mb-12" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 5, padding: '10px 14px' }}>
                  <div className="a-fw6 a-fs-13 a-mb-6" role="status">{importResults.some(r => r.status === 'error') ? 'Import finished with errors' : 'Import complete'}</div>
                  {importResults.map((r, i) => (
                    <div key={i} className="a-fs-12 a-mb-2" style={{ color: r.status === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))' }}>
                      {r.status === 'imported'
                        ? `✓ ${r.name} — ${r.issues_fetched} issues fetched, ${r.files_matched} files matched`
                        : r.status === 'linked-annual'
                        ? `◈ ${r.name} — linked as annual`
                        : `✕ ${r.name || r.directory} — ${r.error}`}
                    </div>
                  ))}
                </div>
              )}

              <div className="dm-triage-toolbar"><label>Review<select className="adm-input" value={reviewFilter} onChange={e => setReviewFilter(e.target.value)}><option value="all">All folders</option><option value="matched">Matched</option><option value="review">Needs a match</option><option value="added">Already monitored</option></select></label></div>
              {/* Series list */}
              {scanResults.filter(item => reviewFilter === 'all' || (reviewFilter === 'added' ? item.alreadyAdded : reviewFilter === 'matched' ? !item.alreadyAdded && (cvOverrides[item.directory] || item.cvMatch) : !item.alreadyAdded && !(cvOverrides[item.directory] || item.cvMatch))).map(item => (
                <ImportSeriesRow
                  key={item.directory}
                  item={{ ...item, cvMatch: cvOverrides[item.directory]
                    ? { ...cvOverrides[item.directory], alternatives: item.cvMatch?.alternatives }
                    : item.cvMatch }}
                  selected={selected.has(item.directory)}
                  onToggle={importing ? () => {} : toggleOne}
                  onCvOverride={setCvOverride}
                />
              ))}
            </>
          )}
        </>
      )}

      {pickerOpen && (
        <DirectoryPicker
          onSelect={dir => { setScanPath(dir); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>


  );
}
