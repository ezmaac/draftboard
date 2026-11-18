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

const BY_ABBR = Object.fromEntries(TEAMS.map(t => [t.abbr, t]));

function findTeam(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  return TEAMS.find(t =>
    t.abbr.toLowerCase() === s ||
    t.name.toLowerCase() === s ||
    `${t.city} ${t.name}`.toLowerCase() === s ||
    t.city.toLowerCase() === s
  ) || null;
}

module.exports = { TEAMS, BY_ABBR, findTeam };
