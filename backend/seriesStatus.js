'use strict';
// ─── Monitored series status (2026-10-28) ─────────────────────────
// The weekly Comic Vine check decides ongoing / ended from issue dates; Metron is a second
// opinion both ways (user's choice):
//   • Comic Vine: new issues this poll, or an issue in the last 4 months → ongoing; else ended;
//     no issue dates at all → unknown.
//   • Metron "Completed"/"Cancelled" ends a series at once when we already have every issue
//     Metron counts (a finished mini-series is not wanted for four more months), or when Comic
//     Vine also has nothing recent.
//   • Metron "Ongoing"/"Hiatus" keeps a quiet series ongoing for up to 12 months after its
//     last issue (late books, breaks between arcs).
//   • Metron unmatched, unreachable or without a token → Comic Vine alone decides.
// The old "final issue / last issue / finale" title test was dropped: story-arc titles
// ("Part 6: Finale") ended long-running series.
const DAY = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 120;
const METRON_HOLD_DAYS = 365;

// Metron's status text → 'ongoing' | 'ended' | null (no opinion, e.g. "Limited Series").
function metronStatusOf(s) {
  const t = String((s && typeof s === 'object' ? s.name : s) || '').toLowerCase();
  if (/ongoing|hiatus/.test(t)) return 'ongoing';
  if (/complet|cancel|ended|finished/.test(t)) return 'ended';
  return null;
}

// newCount: issues added this poll; latestDate: newest store/cover date we hold;
// issueCount: issues we hold for the series; metron: { status, raw, issueCount } or null.
function decideSeriesStatus({ newCount = 0, latestDate = null, issueCount = 0, metron = null, now = Date.now() }) {
  const ms = latestDate ? new Date(latestDate).getTime() : NaN;
  const age = Number.isNaN(ms) ? null : (now - ms) / DAY;
  const recent = newCount > 0 || (age != null && age <= RECENT_DAYS);
  const cv = newCount > 0 ? 'ongoing' : age == null ? 'unknown' : recent ? 'ongoing' : 'ended';
  const cvReason = newCount > 0 ? 'new issues this poll' : age == null ? 'no issue dates' : `last issue ${latestDate}`;
  const said = metron ? `Metron says ${metron.raw || metron.status}` : '';
  if (metron && metron.status === 'ended') {
    const haveAll = metron.issueCount > 0 && issueCount >= metron.issueCount;
    if (!recent || haveAll) return { status: 'ended', source: 'metron', reason: `${said}${haveAll ? `, all ${metron.issueCount} issues in` : ''}; ${cvReason}` };
  }
  if (metron && metron.status === 'ongoing' && cv === 'ended' && age != null && age <= METRON_HOLD_DAYS) {
    return { status: 'ongoing', source: 'metron', reason: `${said}; ${cvReason}` };
  }
  return { status: cv, source: 'cv', reason: cvReason };
}

module.exports = { decideSeriesStatus, metronStatusOf, RECENT_DAYS, METRON_HOLD_DAYS };
