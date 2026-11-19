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
    games.push({ date: iso(d), time, opponent: opponents[i], type: 'regular', price: null, notes: '' });
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

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
const year = y => (String(y).length === 2 ? `20${y}` : String(y));

function normDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s,]+(\d{2,4})$/i); // 29-Sep-26
  if (m && MON[m[2].toLowerCase()]) return `${year(m[3])}-${pad(MON[m[2].toLowerCase()])}-${pad(m[1])}`;
  m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{2,4})$/i); // Sep 29, 2026
  if (m && MON[m[1].toLowerCase()]) return `${year(m[3])}-${pad(MON[m[1].toLowerCase()])}-${pad(m[2])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // MM/DD/YYYY
  if (m) return `${year(m[3])}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

function normType(s) {
  s = String(s || '').toLowerCase();
  if (/pre|exhib/.test(s)) return 'preseason';
  if (/playoff|post/.test(s)) return 'playoff';
  return 'regular';
}

function normPrice(s) {
  const n = parseFloat(String(s || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Parse "1:23", "83", "1:02:03" into seconds. */
function normSeconds(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Read CSV text into { header, rows } where the header is the first row that
 * contains all of `required` (so leading blank rows are fine). Columns are
 * looked up by exact name first, then by substring.
 */
function readCsv(text, required) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let hi = -1, header = [];
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const cells = splitCsv(lines[i]).map(h => h.toLowerCase());
    if (required.every(alts => alts.some(a => cells.some(c => c === a || c.includes(a))))) { hi = i; header = cells; break; }
  }
  if (hi < 0) return null;
  const col = (...alts) => {
    for (const a of alts) { const i = header.indexOf(a); if (i >= 0) return i; }
    for (const a of alts) { const i = header.findIndex(h => h.includes(a)); if (i >= 0) return i; }
    return -1;
  };
  const rows = lines.slice(hi + 1).map((l, n) => ({ line: hi + n + 2, cells: splitCsv(l) }))
    .filter(r => r.cells.some(c => c));
  return { col, rows };
}

/**
 * Parse a schedule CSV. Needs `date` and an opponent column (`opponent` or
 * `team`); optional `time`, `type` (Regular Season / Pre-Season / Playoffs),
 * `price`, `notes`. Away games (opponent starting with "@" / "at ") are skipped.
 */
function parseScheduleCsv(text) {
  const csv = readCsv(text, [['date'], ['opponent', 'team', 'opp']]);
  if (!csv) return { games: [], errors: ['Could not find a header row with "date" and "team"/"opponent" columns'] };
  const { col, rows } = csv;
  const iDate = col('date'), iOpp = col('opponent', 'team', 'opp'), iTime = col('time'),
    iType = col('type'), iPrice = col('price'), iNotes = col('notes', 'note');
  const games = [], errors = [];
  for (const { line, cells } of rows) {
    let opp = cells[iOpp] || '';
    if (!opp && !cells[iDate]) continue;
    if (/^@|^at\s/i.test(opp)) continue; // away game
    opp = opp.replace(/^vs\.?\s*/i, '');
    const team = /^tbd$/i.test(opp) ? { abbr: 'TBD' } : findTeam(opp);
    const date = normDate(cells[iDate]);
    if (!team) errors.push(`Row ${line}: unknown opponent "${opp}"`);
    else if (!date) errors.push(`Row ${line}: bad date "${cells[iDate]}"`);
    else games.push({
      date, time: normTime(iTime >= 0 ? cells[iTime] : ''), opponent: team.abbr,
      type: normType(iType >= 0 ? cells[iType] : ''), price: iPrice >= 0 ? normPrice(cells[iPrice]) : null,
      notes: iNotes >= 0 ? cells[iNotes] || '' : '',
    });
  }
  games.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { games, errors };
}

module.exports = { sampleSchedule, parseScheduleCsv, readCsv, normDate, normTime, normPrice, normType, normSeconds };
