import React from 'react';

// Available fields for smart collection rules
export const FIELDS = [
  { value: 'title',           label: 'Title',           operators: ['contains', 'starts_with'] },
  { value: 'character',       label: 'Character',       operators: ['contains', 'is'] },
  { value: 'genre',           label: 'Genre',           operators: ['contains', 'is'] },
  { value: 'era',             label: 'Era',             operators: ['is', 'contains'] },
  { value: 'publisher',       label: 'Publisher',       operators: ['is', 'contains'] },
  { value: 'imprint',         label: 'Imprint',         operators: ['is', 'contains'] },
  { value: 'status',          label: 'Status',          operators: ['is'] },
  { value: 'year',            label: 'Year',            operators: ['is', 'greater_than', 'less_than', 'between'] },
  { value: 'writer',          label: 'Writer',          operators: ['contains', 'is'] },
  { value: 'artist',          label: 'Artist',          operators: ['contains', 'is'] },
  { value: 'metadata_status', label: 'Metadata Status', operators: ['is'] },
];

export const OPERATOR_LABELS = {
  is:           'is',
  contains:     'contains',
  starts_with:  'starts with',
  greater_than: 'greater than',
  less_than:    'less than',
  between:      'between',
};

export const STATUS_OPTIONS = [
  { value: 'Continuing', label: 'Ongoing / Continuing' },
  { value: 'Ended',      label: 'Ended / Completed' },
  { value: 'Abandoned',  label: 'Abandoned' },
  { value: 'Hiatus',     label: 'Hiatus' },
];

// Three tiers of metadata completeness
export const METADATA_STATUS_OPTIONS = [
  { value: 'none',     label: 'No series.json' },
  { value: 'basic',    label: 'Has series.json (unenriched)' },
  { value: 'enriched', label: 'Fully enriched (CV + AI)' },
];

function RuleRow({ rule, onChange, onRemove }) {
  const field = FIELDS.find(f => f.value === rule.field) || FIELDS[0];
  const operators = field.operators || ['is'];

  return (
    <div className="rule-row">
      <select className="rule-select" value={rule.field}
        onChange={e => onChange({ ...rule, field: e.target.value, operator: 'is', value: '', value2: '' })}>
        {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>

      <select className="rule-select" value={rule.operator}
        onChange={e => onChange({ ...rule, operator: e.target.value, value2: '' })}>
        {operators.map(op => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
      </select>

      {rule.field === 'status' ? (
        <select className="rule-input" value={rule.value}
          onChange={e => onChange({ ...rule, value: e.target.value })}>
          <option value="">Select...</option>
          {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      ) : rule.field === 'metadata_status' ? (
        <select className="rule-input" value={rule.value}
          onChange={e => onChange({ ...rule, value: e.target.value })}>
          <option value="">Select...</option>
          {METADATA_STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      ) : rule.operator === 'between' ? (
        <div style={{ display: 'flex', gap: 6, flex: 1 }}>
          <input className="rule-input" placeholder="From" value={rule.value}
            onChange={e => onChange({ ...rule, value: e.target.value })} />
          <input className="rule-input" placeholder="To" value={rule.value2 || ''}
            onChange={e => onChange({ ...rule, value2: e.target.value })} />
        </div>
      ) : (
        <input className="rule-input" placeholder="Value..." value={rule.value}
          onChange={e => onChange({ ...rule, value: e.target.value })} />
      )}

      <button className="rule-remove" onClick={onRemove} title="Remove rule">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>
  );
}

function ConditionGroup({ group, onChange, onRemove, depth = 0 }) {
  const addRule = () => onChange({
    ...group,
    rules: [...group.rules, { id: Date.now(), field: 'era', operator: 'is', value: '', value2: '' }]
  });

  const addGroup = () => onChange({
    ...group,
    rules: [...group.rules, { id: Date.now(), type: 'group', condition: 'AND', rules: [] }]
  });

  const updateRule = (i, updated) => {
    const rules = [...group.rules]; rules[i] = updated;
    onChange({ ...group, rules });
  };

  const removeRule = (i) => onChange({ ...group, rules: group.rules.filter((_, idx) => idx !== i) });

  return (
    <div className={`condition-group ${depth > 0 ? 'nested' : ''}`}>
      <div className="condition-group-header">
        <span className="condition-label">Condition:</span>
        <select className="condition-select" value={group.condition}
          onChange={e => onChange({ ...group, condition: e.target.value })}>
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
        <button className="condition-btn" onClick={addRule}>+ Add Rule</button>
        {depth < 2 && (
          <button className="condition-btn" onClick={addGroup}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" style={{ marginRight: 4 }}>
              <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
            </svg>
            Add Group
          </button>
        )}
        {onRemove && (
          <button className="condition-btn danger" onClick={onRemove} style={{ marginLeft: 'auto' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            </svg>
          </button>
        )}
      </div>

      <div className="condition-rules">
        {group.rules.length === 0 && (
          <div className="condition-empty">No conditions — add a rule to filter series</div>
        )}
        {group.rules.map((rule, i) => (
          rule.type === 'group' ? (
            <ConditionGroup key={rule.id} group={rule}
              onChange={updated => updateRule(i, updated)}
              onRemove={() => removeRule(i)}
              depth={depth + 1} />
          ) : (
            <RuleRow key={rule.id} rule={rule}
              onChange={updated => updateRule(i, updated)}
              onRemove={() => removeRule(i)} />
          )
        ))}
      </div>
    </div>
  );
}

export default ConditionGroup;

// ─── Test a series against a condition group ──────────────────────
export function testSeriesAgainstGroup(series, group) {
  if (!group || !group.rules || group.rules.length === 0) return true;
  const results = group.rules.map(rule =>
    rule.type === 'group' ? testSeriesAgainstGroup(series, rule) : testSeriesAgainstRule(series, rule)
  );
  return group.condition === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

function testSeriesAgainstRule(series, rule) {
  // metadata_status: compare series.metadataStatus directly
  if (rule.field === 'metadata_status') {
    if (!rule.value) return false;
    return (series.metadataStatus || 'none') === rule.value;
  }

  if (!rule.value && rule.operator !== 'between') return false;

  const val  = rule.value.toLowerCase().trim();
  const val2 = (rule.value2 || '').toLowerCase().trim();
  const normaliseStatus = v => v === 'ongoing' ? 'continuing' : v;

  const getField = () => {
    switch (rule.field) {
      case 'era':
        return [series.displayEra || series.seriesJson?.era || ''].map(v => v.toLowerCase());
      case 'publisher':
        return [series.displayPublisher || series.seriesJson?.publisher || series.metadata?.publisher || ''].map(v => v.toLowerCase());
      case 'imprint':
        return [series.displayImprint || series.seriesJson?.imprint || ''].map(v => v.toLowerCase());
      case 'genre':
        return (series.displayGenres || series.seriesJson?.genres || series.metadata?.genres || []).map(v => v.toLowerCase());
      case 'character':
        return (series.displayCharacters || series.seriesJson?.characters || []).map(v => v.toLowerCase());
      case 'year':
        return [String(series.displayYear || series.seriesJson?.year || '')];
      case 'status':
        return [normaliseStatus((series.displayStatus || series.seriesJson?.status || series.metadata?.status || '').toLowerCase())];
      case 'title':
        return [(series.displayTitle || series.seriesJson?.name || series.metadata?.title || series.name || '')
          .replace(/\s*\(\d{4}\)\s*$/, '').toLowerCase()];
      case 'writer':
        // series.json writers are authoritative; displayWriters may include ComicInfo fallback
        return (series.displayWriters || series.seriesJson?.writers || []).map(v => v.toLowerCase());
      case 'artist':
        return (series.displayArtists || series.seriesJson?.artists || []).map(v => v.toLowerCase());
      default:
        return [];
    }
  };

  const fieldValues = getField();

  switch (rule.operator) {
    case 'is':           return fieldValues.some(fv => fv === normaliseStatus(val));
    case 'contains':     return fieldValues.some(fv => fv.includes(val));
    case 'starts_with':  return fieldValues.some(fv => fv.startsWith(val));
    case 'greater_than': return fieldValues.some(fv => parseFloat(fv) > parseFloat(val));
    case 'less_than':    return fieldValues.some(fv => parseFloat(fv) < parseFloat(val));
    case 'between':      return fieldValues.some(fv => {
      const n = parseFloat(fv);
      return n >= parseFloat(val) && n <= parseFloat(val2);
    });
    default: return false;
  }
}
