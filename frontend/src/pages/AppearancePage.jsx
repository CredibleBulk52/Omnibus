import ThemeMotif from '../components/ThemeMotif';
import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import { COLOR_ROLES, DEFAULT_COLORS, actionColor, actionInk, sameColors, PRESETS, PRESET_GROUPS, checkColors, readableOn, setAppearance, useAppearance } from '../components/appearance';
import { isRealAdmin, setViewAsUser, useViewAsUser } from '../App';
import '../appearance.css';

// Appearance (each user, saved to their account): presets, a colour picker per root colour,
// readability checks, and the switch for character / cover colours on reading pages.
export default function AppearancePage() {
  const { colors: saved, pageColors, saveStatus, themeId, decorations, aiInfo } = useAppearance();
  const asUser = useViewAsUser();
  const colors = saved || DEFAULT_COLORS;
  const problems = checkColors(colors);
  const setColor = (key, value) => setAppearance({ colors: { ...colors, [key]: value.toLowerCase() } });
  const active = PRESETS.find(p => p.id===themeId && sameColors(p.colors, colors));
  return (
    <div className="ap-page">
      <PageHeader title="APPEARANCE" borderSeed={3} />
      <div className="ap-body">
        <section className="ap-section">
          <h2>Presets</h2><p className="ap-note">Ten comic-inspired designs. Choose a theme to apply its colors and, when an admin has uploaded it, its character art; reading pages can keep their own character palettes.</p>
          {PRESET_GROUPS.map(g => (
            <div key={g.id} className="ap-preset-group">
              {g.label && <h3 className="ap-preset-group-title">{g.label}</h3>}
              <div className="ap-presets">
                {PRESETS.filter(p => p.group === g.id).map(p => (
                  <button key={p.id} type="button" className={`ap-preset${active?.id === p.id ? ' on' : ''}`} aria-pressed={active?.id === p.id}
                    onClick={() => setAppearance({ colors: { ...p.colors }, themeId:p.id, decorations:true })}>
                    <span className="ap-preset-swatch" style={{ background: p.colors.base, color:p.colors.text }} aria-hidden="true">
                      <span className="ap-sw-banner ap-sw-themed" style={{ background: p.colors.secondary, color: p.colors.bannerText || p.colors.highlight }}><ThemeMotif theme={p.id}/><span className="ap-sw-title">YOUR LIBRARY</span></span>
                      <span className="ap-sw-tabs"><span style={{color:p.colors.highlight,borderColor:p.colors.highlight}}>Issues</span><span>Details</span></span>
                      <span className="ap-sw-panel" style={{background:'color-mix(in srgb, '+p.colors.base+' 92%, white)'}}><span>Pick up your next story.</span><span className="ap-sw-action" style={{background:actionColor(p.colors),color:actionInk(p.colors)}}>▶ Read next</span></span>
                    </span>
                    <span className="ap-preset-name">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="ap-section">
          <h2>Your colours</h2>
          <label className="ap-switch ap-decoration-switch"><input type="checkbox" role="switch" checked={decorations} disabled={!themeId} onChange={e=>setAppearance({decorations:e.target.checked})}/><span><b>Banner artwork</b><small>Show the character art an admin uploaded for the selected theme (Settings › Branding). Colors stay in place when artwork is off.</small></span></label>
          <p className="ap-note">Changes show straight away across the app.</p>
          {colors.action && <button type="button" className="btn btn-ghost ap-action-reset" onClick={()=>{const {action,...linked}=colors;setAppearance({colors:linked});}}>Use Secondary for actions</button>}
          <div className="ap-roles">
            {[...COLOR_ROLES,...(colors.bannerText?[{key:'bannerText',label:'Banner lettering',hint:'Large outlined page headings'}]:[])].map(r => (
              <ColorRow key={r.key} role={r} value={r.key === 'action' ? actionColor(colors) : colors[r.key]} onChange={v => setColor(r.key, v)}
                problem={problems.find(p => p.key === r.key)}
                onFix={r.key === 'text' || r.key === 'highlight' ? () => setColor(r.key, readableOn(colors[r.key], colors.base, r.key === 'text' ? 7 : 3)) : null} />
            ))}
          </div>
        </section>

        <section className="ap-section">
          <h2>Reading pages</h2>
          <label className="ap-switch">
            <input type="checkbox" role="switch" checked={pageColors} onChange={e => setAppearance({ pageColors: e.target.checked })} />
            <span>
              <b>Use character and cover colours</b>
              <small>{pageColors
                ? 'Lists, events, runs and series named after a known character take that character’s colours; others take colours from their cover.'
                : 'Your colours are used everywhere, including reading pages.'}</small>
            </span>
          </label>
        </section>

        {isRealAdmin() && (
          <section className="ap-section">
            <h2>Admin view</h2>
            <label className="ap-switch">
              <input type="checkbox" role="switch" checked={asUser} onChange={e => setViewAsUser(e.target.checked)} />
              <span>
                <b>View Omnibus as a regular user</b>
                <small>{asUser
                  ? 'Admin controls are hidden in this browser (admin bars, editors, Settings, Library). Turn this off here or with “Viewing as user” in the top bar.'
                  : 'Hides every admin control in this browser so you see what users see. Your account stays an admin; the server is unchanged.'}</small>
              </span>
            </label>
            <label className="ap-switch">
              <input type="checkbox" role="switch" checked={aiInfo !== false} onChange={e => setAppearance({ aiInfo: e.target.checked })} />
              <span>
                <b>Show AI cost details</b>
                <small>An ⓘ next to Comic Book Guy's replies and other AI results, and AI activity in the top bar: models, tokens and estimated cost of each call. Saved to your account.</small>
              </span>
            </label>
          </section>
        )}

        <div className="ap-foot">
          <button type="button" className="btn btn-secondary" disabled={!saved && !themeId} onClick={() => setAppearance({ colors: null, themeId:null, decorations:true })}>Reset to default</button>
          <span className={`ap-status ap-status--${saveStatus}`} role="status">
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Couldn’t save to your account; kept on this device for now.' : 'Saved to your account'}
          </span>
        </div>
      </div>
    </div>
  );
}

function ColorRow({ role, value, onChange, problem, onFix }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => { const v = text.trim().startsWith('#') ? text.trim() : '#' + text.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v); else setText(value); };
  return (
    <div className={`ap-role${problem ? ' ap-role--warn' : ''}`}>
      <label className="ap-swatch" style={{ background: value }} title={`Pick a ${role.label.toLowerCase()} colour`}>
        <input type="color" value={value} onInput={e => onChange(e.target.value)} onChange={e => onChange(e.target.value)} aria-label={`${role.label} colour`} />
      </label>
      <div className="ap-role-copy">
        <b>{role.label}</b>
        <small>{role.hint}</small>
        {problem && <span className="ap-warn">{problem.msg}{onFix && <button type="button" onClick={onFix}>Make readable</button>}</span>}
      </div>
      <input className="ap-hex" value={text} maxLength={7} spellCheck={false} aria-label={`${role.label} hex value`}
        onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }} />
    </div>
  );
}
