'use strict';
// ─── Specials shelves and the Shelf Sorter: routes (moved out of server.js 2026-11-19, split step 3) ───
// The /api/grouping routes (Library › Specials shelves panel: rules, modes, events, removed series,
// the Shelf Sorter's ask / estimate / apply / undo and its series answers), the series page's shelf
// routes (/api/series/:id/grouping, /shelf, /keep-visible), the Shelf Sorter and Metron series-type
// services, the rules run 60 s after startup and hourly, and the hourly Metron type batch. Moved
// unchanged. The rules are seriesGrouping.js; the AI review is shelfSorter.js (claude/SHELF_SORTER.md).
const cron = require('node-cron');
const modelCatalog = require('./modelCatalog');

module.exports.registerShelfRoutes = function registerShelfRoutes(deps) {
  const missing = ['ai', 'aiModels', 'aiRouting', 'app', 'db', 'getSetting', 'hasAiProvider', 'logger', 'metron', 'metronToken', 'minisOn', 'requireAdmin', 'requireAuth', 'seriesGroupOf', 'seriesGrouping', 'setAiJobOutcome', 'shelvesMode', 'shelvesOn'].filter(k => deps[k] === undefined);
  if (missing.length) throw new Error(`registerShelfRoutes: missing ${missing.join(', ')}`);
  const { ai, aiModels, aiRouting, app, db, getSetting, hasAiProvider, logger, metron, metronToken, minisOn, requireAdmin, requireAuth, seriesGroupOf, seriesGrouping, setAiJobOutcome, shelvesMode, shelvesOn } = deps;

  const groupingRoute = fn => (req, res) => { try { res.json(fn(req) ?? { ok: true }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  // Shelf Sorter (shelfSorter.js, 2026-11-13): the AI's review of the shelves. Its answers are added
  // to each event (`ai`); its changes go through seriesGrouping like the admin's.
  // Metron's kind of series (seriesTypes.js, 2026-11-14): an ongoing cut short is kept as its own series
  // without asking the AI; the kind is shown to the AI for the rest.
  const seriesTypes = require('./seriesTypes').createSeriesTypes({ db, metron, logger });
  const shelfSorter = require('./shelfSorter').createShelfSorter({ db, grouping: seriesGrouping, ai, getSetting,
    setSetting: (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v),
    modelFor: id => aiRouting.modelFor(id), logger, setJobOutcome: setAiJobOutcome, seriesTypes, minisEnabled: () => minisOn(),
    aiAvailable: () => { try { return hasAiProvider(aiModels.providerOfModel(aiRouting.modelFor('shelf_sorter'))); } catch { return false; } },
    modelName: m => { if (m === 'metron') return 'Metron'; if (m === 'omnibus') return 'Omnibus (no AI)'; try { return modelCatalog.displayName(m) || m; } catch { return m; } } });
  app.get('/api/grouping', requireAdmin, groupingRoute(() => {
    if (!shelvesOn()) return { enabled: false, mode: 'off' };
    const s = seriesGrouping.summary();
    s.enabled = true;
    s.mode = shelvesMode();
    const ready = shelfSorter.annotate(s) + shelfSorter.seriesReady();
    // outdated: open suggestions made by another model or an older prompt (a hint to ask again; nothing runs on its own).
    let outdated = null; try { outdated = shelfSorter.estimate({ scope: 'outdated' }); } catch {}
    s.ai = { ...shelfSorter.status(), ready, outdated };
    return s;
  }));
  app.get('/api/grouping/ai', requireAdmin, groupingRoute(() => shelfSorter.status()));
  const SHELF_SCOPES = require('./shelfSorter').SCOPES;
  const shelfAskOpts = body => {
    const kinds = Array.isArray(body?.kinds) ? body.kinds.filter(k => k === 'event' || k === 'series') : [];
    return { scope: SHELF_SCOPES.includes(body?.scope) ? body.scope : 'new', ...(kinds.length ? { kinds } : {}),
      eventIds: Array.isArray(body?.eventIds) ? body.eventIds.map(String) : null };
  };
  // Ask runs in the background (about a minute for every event); the panel polls GET /api/grouping/ai.
  app.post('/api/grouping/ai/ask', requireAdmin, groupingRoute(req => {
    if (!shelvesOn()) throw Object.assign(new Error('Specials shelves are off (Library › Specials shelves)'), { status: 400 });
    // Only ever on an admin's click (no AI call runs on its own). scope: new | suggested | outdated | all
    // (shelfSorter.js plan()); the panel shows the estimate first.
    shelfSorter.ask(shelfAskOpts(req.body)).catch(e => logger.warn('shelf-sorter', 'Ask failed', e.message));
    return shelfSorter.status();
  }));
  // What an ask would cover and cost, before it runs: { [scope]: { events, series, calls, model, local } }.
  app.post('/api/grouping/ai/estimate', requireAdmin, groupingRoute(req => {
    if (!shelvesOn()) throw Object.assign(new Error('Specials shelves are off (Library › Specials shelves)'), { status: 400 });
    const scopes = (Array.isArray(req.body?.scopes) ? req.body.scopes : [req.body?.scope || 'new']).filter(x => SHELF_SCOPES.includes(x));
    const out = {};
    for (const scope of scopes) out[scope] = shelfSorter.estimate({ ...shelfAskOpts(req.body), scope });
    return out;
  }));
  app.post('/api/grouping/ai/stop', requireAdmin, groupingRoute(() => shelfSorter.stop()));
  app.post('/api/grouping/ai/apply', requireAdmin, groupingRoute(req => {
    const ids = Array.isArray(req.body?.eventIds) ? req.body.eventIds.map(String) : null;
    const sids = Array.isArray(req.body?.seriesIds) ? req.body.seriesIds.map(String) : null;
    if (ids) return shelfSorter.apply({ eventIds: ids, sureOnly: false, mode: 'row' });
    if (sids) return shelfSorter.apply({ seriesIds: sids, sureOnly: false, mode: 'row' });
    return shelfSorter.apply({});
  }));
  // Stage B (shelfSorterSeries.js): the AI's answers about minis and one-shots on no shelf.
  app.get('/api/grouping/series', requireAdmin, groupingRoute(() => shelfSorter.seriesSummary()));
  // Look up Metron's kind of series now (a few hundred at Metron's pace: minutes; runs in the background).
  app.post('/api/grouping/series/types/run', requireAdmin, groupingRoute(() => {
    if (!metronToken()) throw Object.assign(new Error('Set a Metron API token first (Settings → Connections)'), { status: 400 });
    shelfSorter.lookUpTypes({ limit: 300 }).catch(e => logger.warn('series-types', 'Lookup failed', e.message));
    return { started: true };
  }));
  app.post('/api/grouping/series/:id/decline', requireAdmin, groupingRoute(req => shelfSorter.decline(req.params.id)));
  app.post('/api/grouping/series/:id/undecline', requireAdmin, groupingRoute(req => shelfSorter.undecline(req.params.id, req.body?.previous ?? null)));
  // Keep a series the AI shelved although its latest answer disagrees ({ undo, previous } puts it back).
  app.post('/api/grouping/series/:id/keep', requireAdmin, groupingRoute(req => shelfSorter.keep(req.params.id, { undo: !!req.body?.undo, previous: req.body?.previous ?? null })));
  app.post('/api/grouping/ai/runs/:id/undo', requireAdmin, groupingRoute(req => shelfSorter.undo(req.params.id)));
  app.post('/api/grouping/ai/auto', requireAdmin, groupingRoute(req => shelfSorter.setAuto(!!req.body?.on)));
  app.post('/api/grouping/run', requireAdmin, groupingRoute(() => seriesGrouping.run('manual')));
  // Turn Specials shelves on (the rules run at once) or off (nothing grouped or hidden; links kept).
  app.post('/api/grouping/enabled', requireAdmin, groupingRoute(req => {
    const on = !!req.body?.on;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('shelves_enabled', on ? '1' : '0');
    const r = on ? seriesGrouping.run('turned on') : null;
    seriesGrouping.changed();
    logger.info('grouping', `Specials shelves turned ${on ? 'on' : 'off'}`);
    return { enabled: on, mode: shelvesMode(), run: r };
  }));
  // Off / Events only / Events and minis (2026-11-14). Switching to Events only stops new minis work;
  // what is already on a shelf stays (take it off in the panel), as with Off.
  app.post('/api/grouping/mode', requireAdmin, groupingRoute(req => {
    const mode = ['off', 'events', 'all'].includes(req.body?.mode) ? req.body.mode : null;
    if (!mode) throw Object.assign(new Error('mode must be off, events or all'), { status: 400 });
    const was = shelvesOn();
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    put.run('shelves_enabled', mode === 'off' ? '0' : '1');
    if (mode !== 'off') put.run('shelves_minis', mode === 'all' ? '1' : '0');
    const r = mode !== 'off' && !was ? seriesGrouping.run('turned on') : null;
    seriesGrouping.changed();
    logger.info('grouping', `Specials shelves: ${mode === 'off' ? 'off' : mode === 'events' ? 'events only' : 'events and minis'}`);
    return { mode: shelvesMode(), run: r };
  }));
  app.post('/api/grouping/events/confirm-all', requireAdmin, groupingRoute(() => seriesGrouping.confirmAll()));
  // Undo (2026-11-13): put back the event states an action returned as `previous`.
  app.post('/api/grouping/events/restore', requireAdmin, groupingRoute(req => seriesGrouping.restoreEvents(Array.isArray(req.body?.states) ? req.body.states : [])));
  app.post('/api/grouping/events/:id/empty', requireAdmin, groupingRoute(req => seriesGrouping.emptyEvent(req.params.id)));
  app.post('/api/grouping/events/:id', requireAdmin, groupingRoute(req => seriesGrouping.setEvent(req.params.id, {
    homeSeriesId: req.body?.homeSeriesId, initiative: req.body?.initiative, confirm: !!req.body?.confirm,
    reset: !!req.body?.reset, restore: req.body?.restore && typeof req.body.restore === 'object' ? req.body.restore : undefined })));
  app.get('/api/grouping/removed', requireAdmin, groupingRoute(() => ({ items: seriesGrouping.removed() })));
  app.post('/api/grouping/restore', requireAdmin, groupingRoute(req => seriesGrouping.restore(Array.isArray(req.body?.items) ? req.body.items : [])));
  // The series page: its own homes and the series on its shelf.
  app.get('/api/series/:id/grouping', requireAuth, groupingRoute(req => ({ homes: seriesGrouping.homesOf(req.params.id), members: seriesGrouping.members(req.params.id),
    keepVisible: !!seriesGroupOf(req.params.id)?.keepVisible })));
  app.post('/api/series/:id/shelf', requireAdmin, groupingRoute(req => { seriesGrouping.link(req.params.id, String(req.body?.homeId || '')); }));
  app.delete('/api/series/:id/shelf/:homeId', requireAdmin, groupingRoute(req => { const source = seriesGrouping.unlink(req.params.id, req.params.homeId); return { ok: !!source, source: source || null }; }));
  app.post('/api/series/:id/keep-visible', requireAdmin, groupingRoute(req => { seriesGrouping.keepVisible(req.params.id, !!req.body?.on); }));
  setTimeout(() => { try { seriesGrouping.run('startup'); } catch (e) { logger.warn('grouping', 'Rules failed', e.message); } }, 60000);
  cron.schedule('17 * * * *', () => {
    try { seriesGrouping.run('hourly'); } catch (e) { logger.warn('grouping', 'Rules failed', e.message); }
    // No AI here (2026-11-14): the Shelf Sorter asks only when an admin clicks (claude/SHELF_SORTER.md).
  });
  // Metron series types for the Shelf Sorter, a batch an hour (about 7 minutes of Metron's pace).
  cron.schedule('29 * * * *', () => {
    if (!metronToken() || !minisOn()) return;
    shelfSorter.lookUpTypes({ limit: 60 }).catch(e => logger.warn('series-types', 'Hourly lookup failed', e.message));
  });

  return { shelfSorter, seriesTypes };
};
