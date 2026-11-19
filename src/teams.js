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
