// Schedule helpers: a generated SAMPLE home schedule (placeholder until the real
// one is imported) and a CSV parser for importing the official schedule.
const { TEAMS, findTeam } = require('./teams');

// Deterministic pseudo-random so the sample is the same every time.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * 41 home games between early October and mid April. Every opponent appears at
 * least once; Atlantic rivals fill the remaining 10 dates. NOT the real schedule.
 */
function sampleSchedule(seasonStartYear = 2026) {
  const rand = rng(seasonStartYear);
  const atlantic = TEAMS.filter(t => t.div === 'Atlantic').map(t => t.abbr);
  const opponents = TEAMS.map(t => t.abbr).concat(atlantic.slice(0, 7), ['MTL', 'BOS', 'OTT']);
  // shuffle
  for (let i = opponents.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [opponents[i], opponents[j]] = [opponents[j], opponents[i]];
  }
  // Season-opener vs MTL is a tradition worth faking.
  const mtl = opponents.indexOf('MTL');
  [opponents[0], opponents[mtl]] = [opponents[mtl], opponents[0]];

  const start = new Date(Date.UTC(seasonStartYear, 9, 7)); // Oct 7
  const end = new Date(Date.UTC(seasonStartYear + 1, 3, 15)); // Apr 15
  const span = (end - start) / 86400000;
  const games = [];
  let prev = -3;
  for (let i = 0; i < 41; i++) {
    let offset = Math.round((span * i) / 40 + (rand() - 0.5) * 3);
    if (offset <= prev + 1) offset = prev + 2;
    let d = new Date(start.getTime() + offset * 86400000);
    // Avoid Christmas day.
    if (d.getUTCMonth() === 11 && d.getUTCDate() === 25) d = new Date(d.getTime() + 86400000);
    prev = Math.round((d - start) / 86400000);
    const dow = d.getUTCDay();
    const time = dow === 6 ? '19:00' : dow === 0 ? (rand() < 0.5 ? '17:00' : '19:00') : rand() < 0.75 ? '19:00' : '19:30';
    games.push({ date: iso(d), time, opponent: opponents[i], notes: '' });
  }
  return games;
}

/** Split a CSV line, honouring double-quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normTime(t) {
  if (!t) return '19:00';
  const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return '19:00';
  let h = Number(m[1]);
  const min = m[2] || '00';
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h < 10) h += 12; // "7:00" almost certainly means evening
  return `${String(h).padStart(2, '0')}:${min}`;
}

function normDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // MM/DD/YYYY
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : iso(d);
}

/**
 * Parse CSV text with a header row containing at least `date` and `opponent`
 * (optional `time`, `notes`). Rows that are away games (opponent column starting
 * with "@" or containing "at ") are skipped. Returns { games, errors }.
 */
function parseScheduleCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { games: [], errors: ['CSV is empty'] };
  const header = splitCsv(lines[0]).map(h => h.toLowerCase());
  const col = name => header.findIndex(h => h.includes(name));
  const iDate = col('date'), iOpp = col('opp') >= 0 ? col('opp') : col('team');
  const iTime = col('time'), iNotes = col('note');
  if (iDate < 0 || iOpp < 0) return { games: [], errors: ['Header row needs "date" and "opponent" columns'] };
  const games = [], errors = [];
  lines.slice(1).forEach((line, n) => {
    const cells = splitCsv(line);
    let opp = cells[iOpp] || '';
    if (/^@|^at\s/i.test(opp)) return; // away game
    opp = opp.replace(/^vs\.?\s*/i, '');
    const team = findTeam(opp);
    const date = normDate(cells[iDate]);
    if (!team) errors.push(`Row ${n + 2}: unknown opponent "${opp}"`);
    else if (!date) errors.push(`Row ${n + 2}: bad date "${cells[iDate]}"`);
    else games.push({ date, time: normTime(iTime >= 0 ? cells[iTime] : ''), opponent: team.abbr, notes: iNotes >= 0 ? cells[iNotes] || '' : '' });
  });
  games.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { games, errors };
}

module.exports = { sampleSchedule, parseScheduleCsv };
