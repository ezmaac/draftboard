// Personal draft preferences and the "suggested next pick" built from them.
// Preferences are private to each partner; suggestions are only ever computed for the requester.
const { BY_ABBR } = require('./teams');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const OPP_POINTS = [50, 40, 30, 20, 12];   // favourite opponent #1..#5
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Clean user input into a preferences object (unknown or neutral values dropped). */
function cleanPrefs(p = {}) {
  const out = { days: {}, opponents: [], cost: 'any', max_price: null, spread: false, preseason: 'any', time: 'any', min_gap: 0, avoid_dates: [] };
  for (const [d, v] of Object.entries(p.days || {})) if (/^[0-6]$/.test(d) && (v === 'prefer' || v === 'avoid')) out.days[d] = v;
  out.opponents = [...new Set((p.opponents || []).filter(a => BY_ABBR[a] && !BY_ABBR[a].defunct))].slice(0, 5);
  if (['low', 'high'].includes(p.cost)) out.cost = p.cost;
  const mp = Number(p.max_price);
  if (p.max_price !== '' && p.max_price != null && mp > 0) out.max_price = Math.round(mp);
  out.spread = !!p.spread;
  if (['prefer', 'avoid'].includes(p.preseason)) out.preseason = p.preseason;
  if (['early', 'evening'].includes(p.time)) out.time = p.time;
  out.min_gap = Math.max(0, Math.min(14, Math.round(Number(p.min_gap) || 0)));
  out.avoid_dates = (p.avoid_dates || []).filter(r => isDate(r.from))
    .map(r => { const to = isDate(r.to) && r.to >= r.from ? r.to : r.from; return { from: r.from, to, label: String(r.label || '').slice(0, 40) }; })
    .slice(0, 40);
  return out;
}

/** True when at least one preference is set — otherwise no suggestion is shown. */
function hasPrefs(p) {
  return !!p && (Object.keys(p.days).length || p.opponents.length || p.cost !== 'any' || p.max_price || p.spread
    || p.preseason !== 'any' || p.time !== 'any' || p.min_gap || p.avoid_dates.length);
}

const dayOf = date => new Date(`${date}T12:00:00Z`).getUTCDay();
const daysBetween = (a, b) => Math.abs(new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000;
const money = n => `$${Math.round(n)}`;

/**
 * Rank the games still open to `userId`.
 * state: draftState() output; myPickCount: how many picks this partner gets in total.
 * Returns [{ game_id, score, reasons: [{ text, good }] }] best first.
 */
function suggest(prefs, state, userId, myPickCount) {
  const { games, picks } = state;
  const taken = {};
  for (const p of picks) taken[p.game_id] = (taken[p.game_id] || 0) + 1;
  const open = games.filter(g => (taken[g.id] || 0) < (g.single ? g.seats : 1));
  if (!open.length) return [];
  const mine = picks.filter(p => p.owner_id === userId).map(p => games.find(g => g.id === p.game_id)).filter(Boolean);

  // Even spread: each month's share of the season's games, applied to this partner's pick count.
  const monthOf = g => (g.date ? g.date.slice(0, 7) : null);
  const monthTotals = {}; games.forEach(g => { const m = monthOf(g); if (m) monthTotals[m] = (monthTotals[m] || 0) + 1; });
  const datedTotal = Object.values(monthTotals).reduce((a, b) => a + b, 0);
  const heldByMonth = {}; mine.forEach(g => { const m = monthOf(g); if (m) heldByMonth[m] = (heldByMonth[m] || 0) + 1; });

  const prices = open.map(g => g.price).filter(x => x != null);
  const lo = Math.min(...prices), hi = Math.max(...prices);

  const scored = open.map(g => {
    let score = 0; const reasons = [];
    const add = (pts, text) => { score += pts; if (text) reasons.push({ text, good: pts >= 0, pts }); };
    const t = BY_ABBR[g.opponent];
    if (g.date) {
      const range = prefs.avoid_dates.find(r => g.date >= r.from && g.date <= r.to);
      if (range) add(-200, `Inside a date you avoid${range.label ? ` (${range.label})` : ''}`);
      const d = dayOf(g.date), dp = prefs.days[d];
      if (dp === 'prefer') add(30, `${DAY_NAMES[d]} — a day you prefer`);
      if (dp === 'avoid') add(-40, `${DAY_NAMES[d]} — a day you avoid`);
      if (prefs.min_gap) {
        const near = mine.filter(h => h.date && daysBetween(h.date, g.date) < prefs.min_gap);
        if (near.length) add(-25, `Within ${prefs.min_gap} days of a game you already have`);
      }
      if (prefs.spread && datedTotal && myPickCount) {
        const m = monthOf(g), target = (monthTotals[m] / datedTotal) * myPickCount, held = heldByMonth[m] || 0;
        const gap = target - held;
        const monthName = MONTHS[Number(m.slice(5)) - 1];
        if (gap >= 0.5) add(Math.min(24, 12 * gap), `Evens out your season — ${held} of ~${Math.round(target)} games in ${monthName}`);
        else if (gap <= -0.5) add(Math.max(-24, 12 * gap), `You already have ${held} in ${monthName} (~${Math.round(target)} is your share)`);
      }
    }
    const rank = prefs.opponents.indexOf(g.opponent);
    if (rank >= 0) add(OPP_POINTS[rank], `vs ${t ? t.name : g.opponent} — your #${rank + 1} opponent`);
    if (g.type === 'preseason') {
      if (prefs.preseason === 'prefer') add(15, 'Preseason game — you like these');
      if (prefs.preseason === 'avoid') add(-35, 'Preseason game — you avoid these');
    }
    if (g.price != null) {
      if (prefs.max_price && g.price > prefs.max_price) add(-60, `${money(g.price)} is over your ${money(prefs.max_price)} limit`);
      if (hi > lo && prefs.cost !== 'any') {
        const norm = (g.price - lo) / (hi - lo);
        if (prefs.cost === 'low') add(20 * (1 - norm), norm < 0.34 ? `Cheaper ticket (${money(g.price)})` : null);
        if (prefs.cost === 'high') add(20 * norm, norm > 0.66 ? `Premium game (${money(g.price)})` : null);
      }
    }
    if (g.time && prefs.time !== 'any') {
      const early = g.time < '19:00';
      if (prefs.time === 'early' && early) add(10, 'Earlier start');
      if (prefs.time === 'evening' && !early) add(10, 'Evening start');
    }
    if (g.single && (taken[g.id] || 0) === 1) {
      const holder = picks.find(p => p.game_id === g.id);
      if (holder?.owner_id === userId) add(8, 'You hold the other seat');
    }
    // Strongest reasons first: biggest pluses, then biggest minuses.
    reasons.sort((a, b) => b.good - a.good || Math.abs(b.pts) - Math.abs(a.pts));
    return { game_id: g.id, score: Math.round(score * 10) / 10, reasons: reasons.map(({ text, good }) => ({ text, good })) };
  });
  // Best score first; ties go to the earlier game.
  const order = new Map(games.map((g, i) => [g.id, i]));
  return scored.sort((a, b) => b.score - a.score || order.get(a.game_id) - order.get(b.game_id));
}

module.exports = { cleanPrefs, hasPrefs, suggest };
