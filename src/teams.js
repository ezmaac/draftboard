// NHL opponents. `div` is used to colour-code game cards on the board.
const TEAMS = [
  ['ANA', 'Anaheim', 'Ducks', 'Pacific'],
  ['BOS', 'Boston', 'Bruins', 'Atlantic'],
  ['BUF', 'Buffalo', 'Sabres', 'Atlantic'],
  ['CGY', 'Calgary', 'Flames', 'Pacific'],
  ['CAR', 'Carolina', 'Hurricanes', 'Metropolitan'],
  ['CHI', 'Chicago', 'Blackhawks', 'Central'],
  ['COL', 'Colorado', 'Avalanche', 'Central'],
  ['CBJ', 'Columbus', 'Blue Jackets', 'Metropolitan'],
  ['DAL', 'Dallas', 'Stars', 'Central'],
  ['DET', 'Detroit', 'Red Wings', 'Atlantic'],
  ['EDM', 'Edmonton', 'Oilers', 'Pacific'],
  ['FLA', 'Florida', 'Panthers', 'Atlantic'],
  ['LAK', 'Los Angeles', 'Kings', 'Pacific'],
  ['MIN', 'Minnesota', 'Wild', 'Central'],
  ['MTL', 'Montréal', 'Canadiens', 'Atlantic'],
  ['NSH', 'Nashville', 'Predators', 'Central'],
  ['NJD', 'New Jersey', 'Devils', 'Metropolitan'],
  ['NYI', 'New York', 'Islanders', 'Metropolitan'],
  ['NYR', 'New York', 'Rangers', 'Metropolitan'],
  ['OTT', 'Ottawa', 'Senators', 'Atlantic'],
  ['PHI', 'Philadelphia', 'Flyers', 'Metropolitan'],
  ['PIT', 'Pittsburgh', 'Penguins', 'Metropolitan'],
  ['SJS', 'San Jose', 'Sharks', 'Pacific'],
  ['SEA', 'Seattle', 'Kraken', 'Pacific'],
  ['STL', 'St. Louis', 'Blues', 'Central'],
  ['TBL', 'Tampa Bay', 'Lightning', 'Atlantic'],
  ['UTA', 'Utah', 'Mammoth', 'Central'],
  ['VAN', 'Vancouver', 'Canucks', 'Pacific'],
  ['VGK', 'Vegas', 'Golden Knights', 'Pacific'],
  ['WSH', 'Washington', 'Capitals', 'Metropolitan'],
  ['WPG', 'Winnipeg', 'Jets', 'Central'],
].map(([abbr, city, name, div]) => ({ abbr, city, name, div }));

// Former franchises, kept so past seasons import cleanly. Not offered for new games.
TEAMS.push(
  { abbr: 'PHX', city: 'Phoenix', name: 'Coyotes', div: 'Pacific', defunct: true },
  { abbr: 'ARI', city: 'Arizona', name: 'Coyotes', div: 'Central', defunct: true },
  { abbr: 'ATL', city: 'Atlanta', name: 'Thrashers', div: 'Metropolitan', defunct: true },
);

// Tile colours: [main colour, second colour (stripe), text colour] — close to each club's colours,
// tuned so the text stays readable.
const COLORS = {
  ANA: ['#F47A38', '#111111', '#111111'], BOS: ['#FFB81C', '#111111', '#111111'], BUF: ['#003087', '#FFB81C', '#FFFFFF'],
  CGY: ['#C8102E', '#F1BE48', '#FFFFFF'], CAR: ['#CE1126', '#111111', '#FFFFFF'], CHI: ['#CF0A2C', '#111111', '#FFFFFF'],
  COL: ['#6F263D', '#236192', '#FFFFFF'], CBJ: ['#002654', '#CE1126', '#FFFFFF'], DAL: ['#006847', '#8F8F8C', '#FFFFFF'],
  DET: ['#CE1126', '#FFFFFF', '#FFFFFF'], EDM: ['#FF4C00', '#041E42', '#041E42'], FLA: ['#C8102E', '#B9975B', '#FFFFFF'],
  LAK: ['#111111', '#A2AAAD', '#FFFFFF'], MIN: ['#154734', '#A6192E', '#FFFFFF'], MTL: ['#AF1E2D', '#192168', '#FFFFFF'],
  NSH: ['#FFB81C', '#041E42', '#041E42'], NJD: ['#CE1126', '#111111', '#FFFFFF'], NYI: ['#00539B', '#F47D30', '#FFFFFF'],
  NYR: ['#0038A8', '#CE1126', '#FFFFFF'], OTT: ['#DA1A32', '#B79257', '#FFFFFF'], PHI: ['#F74902', '#111111', '#FFFFFF'],
  PIT: ['#FCB514', '#111111', '#111111'], SJS: ['#006D75', '#EA7200', '#FFFFFF'], SEA: ['#001628', '#99D9D9', '#FFFFFF'],
  STL: ['#002F87', '#FCB514', '#FFFFFF'], TBL: ['#002868', '#FFFFFF', '#FFFFFF'], UTA: ['#6CACE4', '#010101', '#010101'],
  VAN: ['#00205B', '#00843D', '#FFFFFF'], VGK: ['#B4975A', '#333F42', '#111111'], WSH: ['#C8102E', '#041E42', '#FFFFFF'],
  WPG: ['#041E42', '#AC162C', '#FFFFFF'], PHX: ['#8C2633', '#E2D6B5', '#FFFFFF'], ARI: ['#8C2633', '#E2D6B5', '#FFFFFF'],
  ATL: ['#041E42', '#B9975B', '#FFFFFF'],
};
for (const t of TEAMS) [t.color, t.accent, t.text] = COLORS[t.abbr];

const BY_ABBR = Object.fromEntries(TEAMS.map(t => [t.abbr, t]));

const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

function findTeam(input) {
  if (!input) return null;
  const s = fold(input);
  return TEAMS.find(t =>
    fold(t.abbr) === s ||
    fold(t.name) === s ||
    fold(`${t.city} ${t.name}`) === s ||
    fold(t.city) === s
  ) || TEAMS.find(t => !t.defunct && s.endsWith(fold(t.name))) || null;
}

module.exports = { TEAMS, BY_ABBR, findTeam };
