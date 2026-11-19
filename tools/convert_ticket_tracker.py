#!/usr/bin/env python3
"""
Convert the partners' Ticket Tracker workbook (one worksheet per season) into
history/<season>.csv files plus history/manifest.json, which the app can load
from Import past draft > "Load bundled history".

    python3 tools/convert_ticket_tracker.py TicketTracker.xlsx [out_dir]

Needs openpyxl. The workbook layout changed over the years; this handles:
  * 2017+ : header row with #, [Order], Selector, Month, Day, Date, Teams, [Ticket Tier], [Time], [Price], [TimeStamp]
  * 2009-2016 : #, Selector, Month, Day, Date, Teams (dates sometimes typed as text, e.g. "2 OCT 2016")
  * 2002-2008 : selection-order block top-left, then #, Selector, [Day], Date, Team
"""
import csv, datetime, json, re, sys
from pathlib import Path
import openpyxl

SKIP = {'RefData', 'Old2027', 'Exhibition Table', 'Game Schedule', '2023-24 Offical NHL Schedule', 'rawSched', 'Sheet2'}
PARTNERS = {'q': 'Q', 'abela': 'Abela', 'pope': 'Pope'}

# Every spelling seen in the workbook -> full team name (as known in the app).
TEAM_ALIASES = {
    'anaheim': 'Anaheim Ducks', 'ducks': 'Anaheim Ducks', 'ana': 'Anaheim Ducks', 'anh': 'Anaheim Ducks', 'mighty ducks': 'Anaheim Ducks',
    'arizona': 'Arizona Coyotes', 'coyotes': None, 'ari': 'Arizona Coyotes', 'phoenix': 'Phoenix Coyotes', 'phx': 'Phoenix Coyotes', 'pho': 'Phoenix Coyotes',
    'atlanta': 'Atlanta Thrashers', 'thrashers': 'Atlanta Thrashers', 'atl': 'Atlanta Thrashers',
    'boston': 'Boston Bruins', 'bruins': 'Boston Bruins', 'bos': 'Boston Bruins',
    'buffalo': 'Buffalo Sabres', 'sabres': 'Buffalo Sabres', 'buf': 'Buffalo Sabres', 'buff': 'Buffalo Sabres',
    'calgary': 'Calgary Flames', 'flames': 'Calgary Flames', 'cal': 'Calgary Flames', 'cgy': 'Calgary Flames',
    'carolina': 'Carolina Hurricanes', 'hurricanes': 'Carolina Hurricanes', 'car': 'Carolina Hurricanes', 'caro': 'Carolina Hurricanes',
    'chicago': 'Chicago Blackhawks', 'blackhawks': 'Chicago Blackhawks', 'chi': 'Chicago Blackhawks', 'hawks': 'Chicago Blackhawks',
    'colorado': 'Colorado Avalanche', 'avalanche': 'Colorado Avalanche', 'col': 'Colorado Avalanche', 'colo': 'Colorado Avalanche',
    'columbus': 'Columbus Blue Jackets', 'blue jackets': 'Columbus Blue Jackets', 'cbj': 'Columbus Blue Jackets', 'clb': 'Columbus Blue Jackets', 'colum': 'Columbus Blue Jackets', 'clmb': 'Columbus Blue Jackets',
    'dallas': 'Dallas Stars', 'stars': 'Dallas Stars', 'dal': 'Dallas Stars',
    'detroit': 'Detroit Red Wings', 'red wings': 'Detroit Red Wings', 'det': 'Detroit Red Wings',
    'edmonton': 'Edmonton Oilers', 'oilers': 'Edmonton Oilers', 'edm': 'Edmonton Oilers',
    'florida': 'Florida Panthers', 'panthers': 'Florida Panthers', 'fla': 'Florida Panthers', 'flo': 'Florida Panthers', 'flr': 'Florida Panthers', 'flor': 'Florida Panthers',
    'los angeles': 'Los Angeles Kings', 'kings': 'Los Angeles Kings', 'la': 'Los Angeles Kings', 'lak': 'Los Angeles Kings', 'l.a.': 'Los Angeles Kings',
    'minnesota': 'Minnesota Wild', 'wild': 'Minnesota Wild', 'min': 'Minnesota Wild', 'minn': 'Minnesota Wild',
    'montreal': 'Montreal Canadiens', 'canadiens': 'Montreal Canadiens', 'mtl': 'Montreal Canadiens', 'mon': 'Montreal Canadiens', 'mont': 'Montreal Canadiens', 'habs': 'Montreal Canadiens',
    'nashville': 'Nashville Predators', 'predators': 'Nashville Predators', 'nsh': 'Nashville Predators', 'nash': 'Nashville Predators', 'nas': 'Nashville Predators',
    'new jersey': 'New Jersey Devils', 'devils': 'New Jersey Devils', 'njd': 'New Jersey Devils', 'nj': 'New Jersey Devils',
    'islanders': 'New York Islanders', 'nyi': 'New York Islanders', 'ny islanders': 'New York Islanders', 'isl': 'New York Islanders',
    'rangers': 'New York Rangers', 'nyr': 'New York Rangers', 'ny rangers': 'New York Rangers', 'rang': 'New York Rangers',
    'ottawa': 'Ottawa Senators', 'senators': 'Ottawa Senators', 'ott': 'Ottawa Senators',
    'philadelphia': 'Philadelphia Flyers', 'flyers': 'Philadelphia Flyers', 'phi': 'Philadelphia Flyers', 'phil': 'Philadelphia Flyers', 'phila': 'Philadelphia Flyers', 'philly': 'Philadelphia Flyers',
    'pittsburgh': 'Pittsburgh Penguins', 'penguins': 'Pittsburgh Penguins', 'pens': 'Pittsburgh Penguins', 'pit': 'Pittsburgh Penguins', 'pitt': 'Pittsburgh Penguins',
    'san jose': 'San Jose Sharks', 'sharks': 'San Jose Sharks', 'sj': 'San Jose Sharks', 'sjs': 'San Jose Sharks',
    'seattle': 'Seattle Kraken', 'kraken': 'Seattle Kraken', 'sea': 'Seattle Kraken',
    'st. louis': 'St. Louis Blues', 'st louis': 'St. Louis Blues', 'blues': 'St. Louis Blues', 'stl': 'St. Louis Blues',
    'tampa bay': 'Tampa Bay Lightning', 'tampa': 'Tampa Bay Lightning', 'lightning': 'Tampa Bay Lightning', 'tb': 'Tampa Bay Lightning', 'tbl': 'Tampa Bay Lightning',
    'utah': 'Utah Mammoth', 'mammoth': 'Utah Mammoth', 'utah hockey club': 'Utah Mammoth', 'uta': 'Utah Mammoth',
    'vancouver': 'Vancouver Canucks', 'canucks': 'Vancouver Canucks', 'van': 'Vancouver Canucks', 'vanc': 'Vancouver Canucks',
    'vegas': 'Vegas Golden Knights', 'golden knights': 'Vegas Golden Knights', 'vgk': 'Vegas Golden Knights', 'veg': 'Vegas Golden Knights', 'las vegas': 'Vegas Golden Knights',
    'washington': 'Washington Capitals', 'capitals': 'Washington Capitals', 'wsh': 'Washington Capitals', 'was': 'Washington Capitals', 'wash': 'Washington Capitals',
    'winnipeg': 'Winnipeg Jets', 'jets': 'Winnipeg Jets', 'wpg': 'Winnipeg Jets', 'win': 'Winnipeg Jets', 'winn': 'Winnipeg Jets',
}
MONTHS = {m: i + 1 for i, m in enumerate(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}


def fold(s):
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFD', str(s)) if unicodedata.category(c) != 'Mn').strip().lower()


def as_date(v):
    if isinstance(v, datetime.datetime):
        return v.date() if v.year > 1990 else None
    if isinstance(v, datetime.date):
        return v
    if isinstance(v, str):
        m = re.match(r'^\s*(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{2,4})\s*$', v)
        if m and m.group(2).lower() in MONTHS:
            y = int(m.group(3)); y += 2000 if y < 100 else 0
            return datetime.date(y, MONTHS[m.group(2).lower()], int(m.group(1)))
    return None


def team_name(raw, season_year):
    s = fold(raw)
    pre = bool(re.search(r'\(pre|pre-?season|exhib', s))
    s = re.sub(r'\(.*?\)', '', s).replace('@', '').strip(' .*-')
    s = re.sub(r'\s+', ' ', s)
    if s in TEAM_ALIASES and TEAM_ALIASES[s]:
        name = TEAM_ALIASES[s]
    else:
        # full names / "City Nickname"
        name = next((v for k, v in sorted(TEAM_ALIASES.items(), key=lambda kv: -len(kv[0])) if v and (s == fold(v) or s.endswith(' ' + k) or s.startswith(k + ' '))), None)
    if name is None and s == 'coyotes':
        name = 'Arizona Coyotes' if season_year >= 2014 else 'Phoenix Coyotes'
    if name in ('Phoenix Coyotes', 'Arizona Coyotes'):
        name = 'Arizona Coyotes' if season_year >= 2014 else 'Phoenix Coyotes'
    return name, pre


def fmt_time(v):
    if isinstance(v, datetime.time):
        return v.strftime('%H:%M')
    if isinstance(v, datetime.datetime):
        return v.strftime('%H:%M')
    if isinstance(v, str):
        m = re.match(r'^\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)?', v, re.I)
        if m:
            h = int(m.group(1)); mi = m.group(2) or '00'; ap = (m.group(3) or '').lower()
            if ap == 'pm' and h < 12: h += 12
            if ap == 'am' and h == 12: h = 0
            if not ap and h < 10: h += 12
            return f'{h:02d}:{mi}'
    return ''


def season_of(title):
    t = title.strip()
    m = re.match(r'^(\d{4})-(\d{4})$', t)
    if m: return f'{m.group(1)}-{m.group(2)[2:]}', int(m.group(1))
    m = re.match(r'^(\d{4})\s*\(Lockout\)$', t)
    if m: return f'{int(m.group(1)) - 1}-{m.group(1)[2:]}', int(m.group(1)) - 1
    return t, None


def partner(v):
    if v is None: return None
    return PARTNERS.get(fold(v))


def convert_sheet(ws):
    season, year = season_of(ws.title)
    rows = list(ws.iter_rows(values_only=True))
    report = []
    # --- header row (the one whose first cell is '#')
    hi, cols = None, {}
    for i, r in enumerate(rows[:6]):
        if r and str(r[0] or '').strip() == '#':
            hi = i
            for j, c in enumerate(r):
                k = fold(c or '').rstrip(':')
                if k and k not in cols: cols[k] = j
            # Old2027-style second "Order" column holding timestamps
            break
    c_sel = cols.get('selector', 1)
    c_order = cols.get('selection order', cols.get('order'))
    c_price = cols.get('price'); c_time = cols.get('time'); c_tier = cols.get('ticket tier', cols.get('type'))
    c_ts = cols.get('timestamp'); c_notes = cols.get('notes')

    # --- selection order block: "Selection Order" label then [pos, name, count, value] rows
    order, counts, values = [], {}, {}
    for i, r in enumerate(rows[:12]):
        for j, c in enumerate(r):
            if isinstance(c, str) and c.strip() == 'Selection Order' and i != hi:
                for k in range(i + 1, i + 8):
                    rr = rows[k]
                    if isinstance(rr[j], (int, float)) and partner(rr[j + 1]):
                        order.append(partner(rr[j + 1]))
                        if isinstance(rr[j + 2], (int, float)): counts[partner(rr[j + 1])] = int(rr[j + 2])
                        if j + 3 < len(rr) and isinstance(rr[j + 3], (int, float)) and rr[j + 3]: values[partner(rr[j + 1])] = rr[j + 3]
                    elif order:
                        break
    if not order:
        # 2002-2008: rows like [2,'Abela'] / ['a','Abela'] above the game list
        slots = []
        for r in rows[:8]:
            if r and r[0] is not None and partner(r[1]) and as_date(r[2]) is None and as_date(r[3] if len(r) > 3 else None) is None:
                slots.append((r[0], partner(r[1])))
        if slots:
            if all(isinstance(s[0], (int, float)) for s in slots): slots.sort(key=lambda s: s[0])
            order_slots = [p for _, p in slots]
            order = list(dict.fromkeys(order_slots))
            if len(order_slots) != len(order):
                report.append(f'order slots per round: {", ".join(order_slots)}')
        # "Selector / # of Picks" table
        for i, r in enumerate(rows[:8]):
            for j, c in enumerate(r):
                if isinstance(c, str) and c.strip() == 'Selector' and j + 1 < len(r) and str(r[j + 1] or '').strip() == '# of Picks':
                    for k in range(i + 1, i + 6):
                        if partner(rows[k][j]) and isinstance(rows[k][j + 1], (int, float)):
                            counts[partner(rows[k][j])] = int(rows[k][j + 1])
    # --- freebie
    freebie = None
    for r in rows[:12]:
        for j, c in enumerate(r):
            if isinstance(c, str) and c.strip().startswith('Freebie'):
                vals = [str(x).strip() for x in r[j + 1:j + 5] if x and '@' not in str(x) and str(x).strip()]
                if vals: freebie = ' '.join(vals)

    # --- games
    picks, unassigned, fixes = [], [], []
    for i, r in enumerate(rows):
        if hi is not None and i <= hi: continue
        if not r or not isinstance(r[0], (int, float)): continue
        dcol = next((j for j in range(1, 7) if j < len(r) and as_date(r[j])), None)
        if dcol is None: continue
        date = as_date(r[dcol])
        if year:  # fix year typos: Aug-Dec belong to the start year, Jan-Jul to the next
            fixed = date.replace(year=year if date.month >= 8 else year + 1)
            if fixed != date: fixes.append(f'{date} -> {fixed}')
            date = fixed
        tcol = next((j for j in range(dcol + 1, min(dcol + 3, len(r))) if isinstance(r[j], str) and r[j].strip()), None)
        raw_team = r[tcol] if tcol is not None else ''
        name, pre = team_name(raw_team, year or date.year)
        tier = fold(r[c_tier]) if c_tier is not None and c_tier < len(r) and r[c_tier] else ''
        # The regular season has never started in September, so past September games are preseason.
        # (2026-27 onward is left as the sheet says.)
        gtype = 'Pre-Season' if pre or re.search(r'pre-?\s?season|exhib', tier) or (date.month == 9 and (year or date.year) < 2026) else 'Regular Season'
        sel_cell = r[c_sel] if c_sel < len(r) else None
        who = partner(sel_cell)
        price = r[c_price] if c_price is not None and isinstance(r[c_price], (int, float)) else ''
        time = fmt_time(r[c_time]) if c_time is not None and c_time < len(r) else ''
        game = {'date': date.isoformat(), 'team': name or raw_team, 'time': time, 'price': price, 'type': gtype}
        tier_raw = str(r[c_tier]).strip() if c_tier is not None and c_tier < len(r) and r[c_tier] else ''
        if tier_raw and not re.search(r'pre-?\s?season|^regular$|^x$', tier_raw, re.I):
            game['note'] = f'{tier_raw} tier'
        if not name:
            report.append(f'row {i + 1}: unknown team "{raw_team}" on {date} — imported as TBD')
            game['team'] = 'TBD'; game['note'] = f'spreadsheet says "{str(raw_team).strip()}"'
        if not who:
            game['note'] = str(sel_cell or '').strip() or (str(r[c_tier]).strip() if c_tier is not None and r[c_tier] else '') or 'not selected'
            unassigned.append(game); continue
        pick_no = r[c_order] if c_order is not None and isinstance(r[c_order], (int, float)) else None
        ts = r[c_ts] if c_ts is not None and isinstance(r[c_ts], datetime.datetime) else None
        picks.append({**game, 'partner': who, 'pick': int(pick_no) if pick_no else None, 'ts': ts, 'row': i})

    if fixes: report.append(f'corrected {len(fixes)} date year(s), e.g. {fixes[0]}')
    recorded = bool(picks) and all(p['pick'] for p in picks) and len({p['pick'] for p in picks}) == len(picks)
    if not recorded and picks and not any(p['pick'] for p in picks):
        # Some early sheets list games in the order they were picked rather than by date.
        # Treat row order as pick order when rows are out of date order AND not grouped by partner.
        dates = [p['date'] for p in picks]
        runs = sum(1 for a, b in zip(picks, picks[1:]) if a['partner'] != b['partner'])
        if dates != sorted(dates) and runs > len(picks) // 2:
            for n, p in enumerate(sorted(picks, key=lambda p: p['row']), 1): p['pick'] = n
            recorded = True
            report.append('games are listed in pick order — using row order as the pick sequence')
    if any(p['pick'] for p in picks) and not recorded:
        report.append(f'pick order only partly recorded ({sum(1 for p in picks if p["pick"])} of {len(picks)}) — ignored')
    if recorded:
        picks.sort(key=lambda p: p['pick'])
        prev = None
        for p in picks:
            p['seconds'] = round((p['ts'] - prev).total_seconds()) if p['ts'] and prev else ''
            prev = p['ts'] or prev
            if p['seconds'] != '' and p['seconds'] < 0: p['seconds'] = ''
    else:
        picks.sort(key=lambda p: p['date'])
        for p in picks: p['pick'] = None; p['seconds'] = ''
    # sanity vs counts block
    got = {}
    for p in picks: got[p['partner']] = got.get(p['partner'], 0) + 1
    for who, n in counts.items():
        if got.get(who, 0) != n: report.append(f'{who}: sheet says {n} picks, found {got.get(who, 0)}')
    if not order: order = list(dict.fromkeys(p['partner'] for p in picks)); report.append('no selection order block; order guessed')
    return {
        'sheet': ws.title, 'season': season, 'order': order, 'counts': got, 'ticket_value': values,
        'freebie': freebie, 'pick_order_recorded': recorded, 'picks': picks, 'unassigned': unassigned, 'report': report,
    }


def main():
    src = sys.argv[1]
    out = Path(sys.argv[2] if len(sys.argv) > 2 else 'history')
    out.mkdir(parents=True, exist_ok=True)
    wb = openpyxl.load_workbook(src, data_only=True)
    manifest = []
    for ws in wb.worksheets:
        if ws.title in SKIP: continue
        s = convert_sheet(ws)
        fname = f"{s['season']}.csv"
        with open(out / fname, 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['Pick', 'Partner', 'Date', 'Team', 'Time', 'Price', 'Type', 'Seconds', 'Notes'])
            for p in s['picks']:
                w.writerow([p['pick'] or '', p['partner'], p['date'], p['team'], p['time'], p['price'], p['type'], p['seconds'], p.get('note', '')])
            for g in s['unassigned']:  # games nobody drafted (free game, given away, ...)
                w.writerow(['', '', g['date'], g['team'], g['time'], g['price'], g['type'], '', f"not drafted: {g['note']}"])
        manifest.append({k: v for k, v in s.items() if k not in ('picks', 'unassigned')} | {'file': fname, 'picks': len(s['picks']), 'unassigned': len(s['unassigned'])})
        print(f"{s['season']:>8}  {len(s['picks']):>2} picks  order={'/'.join(s['order'])}  recorded={s['pick_order_recorded']}  "
              f"unassigned={len(s['unassigned'])}  {s['counts']}" + ''.join(f"\n          ! {m}" for m in s['report']))
    manifest.sort(key=lambda m: m['season'], reverse=True)
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=1, default=str))


if __name__ == '__main__':
    main()
