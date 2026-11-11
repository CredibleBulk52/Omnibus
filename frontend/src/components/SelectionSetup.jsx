import React, { useState } from 'react';

// The reader's choices before Comic Book Guy builds anything new (backend/ai/selectionSetup.js):
// a box of series or a reading order, then the questions for that kind. Every shown
// question needs an answer; nothing is preselected unless the reader already said it.
// Styled as his list cards: black head, numbered questions, choice tiles (2026-11-04).
export default function SelectionSetup({ setup, locked, onSubmit, onCancel }) {
  const [values, setValues] = useState(setup.values || {});
  const fields = setup.fields.filter(f => !f.only || values.format === f.only);
  const needsDetail = values.format === 'order' && values.start === 'specific';
  const valid = fields.every(f => f.choices.some(([id]) => id === values[f.key])) && (!needsDetail || values.startDetail?.trim());
  const set = (key, value) => setValues(v => ({ ...v, [key]: value }));
  const submit = e => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({ ...values, kind: setup.kind, subject: setup.subject, saved: setup.saved, options: setup.options });
  };
  return <form className="cbg-list cbg-setup" onSubmit={submit}>
    <div className="cbg-list-head"><span className="cbg-list-tag">Your call</span><span className="cbg-list-name">{setup.subject}</span></div>
    <div className="cbg-setup-body">
      {fields.map((f, k) => <fieldset key={f.key} disabled={locked} className="cbg-setup-q">
        <legend><span className="cbg-setup-step">{k + 1}</span>{f.title}</legend>
        <div className={`cbg-setup-opts${f.choices.length === 2 ? ' cbg-setup-opts--two' : ''}`}>
          {f.choices.map(([id, label, text]) => <label key={id} className={`cbg-setup-opt${values[f.key] === id ? ' is-on' : ''}`}>
            <input type="radio" name={f.key} value={id} checked={values[f.key] === id} onChange={() => set(f.key, id)} />
            <span className="cbg-setup-opt-label">{label}</span>
            {text && <span className="cbg-setup-text">{text}</span>}
          </label>)}
        </div>
      </fieldset>)}
      {needsDetail && <label className="cbg-setup-field">Which era or story?
        <input required maxLength={200} value={values.startDetail || ''} disabled={locked} placeholder="e.g. Rebirth, or Emerald Twilight" onChange={e => set('startDetail', e.target.value)} />
      </label>}
      {values.format && <label className="cbg-setup-field">Anything to include or avoid? <em>(optional)</em>
        <textarea rows={2} maxLength={600} value={values.notes || ''} disabled={locked} placeholder="Favourite runs, things to skip…" onChange={e => set('notes', e.target.value)} />
      </label>}
    </div>
    <div className="cbg-list-foot">
      <button type="submit" className="cbg-save" disabled={locked || !valid}>{values.format === 'box' ? 'Build the box' : values.format === 'order' ? 'Build the reading order' : 'Build it'}</button>
      <button type="button" className="cbg-save cbg-save--alt" onClick={onCancel} disabled={locked}>Cancel</button>
    </div>
    <p className="cbg-setup-hint">Nothing is saved until you choose to save it.</p>
  </form>;
}
