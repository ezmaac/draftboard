# Leafs Ticket Draft — Build Specification

> **Purpose of this document.** A complete, self-contained specification for (re)building the Leafs Ticket Draft web application. Give it to an AI coding assistant (Claude Code, Antigravity, etc.) or a developer, together with the data files listed in §14, and ask them to build the app. It describes *what* the app must do and the decisions already made, plus the reference architecture of the current build.
>
> **Keep this document current.** Every change to the app's behaviour must be reflected here (see `CLAUDE.md`). Last updated: 2026-11-23 (show/hide password toggle; invite code management).

---

## 1. Overview

A private web app that three (possibly more) partners use to divide their **Toronto Maple Leafs season tickets** — a pair of seats for every home game — by running a fantasy-style **draft**. It replaces a spreadsheet ("Ticket Tracker") that has been used since 2002.

Core ideas:
- A **draft board** shows every home game as a tile, in columns by month (or by playoff round). Partners take turns picking games in a snake order.
- A **count-up clock** records how long each pick took. There is a warning, never a hard limit.
- Partners draft from **different locations**; every screen updates live.
- Each season the partners hold a **season draft** (preseason + regular season, pairs of seats) and, nearer the playoffs, one or more **playoff drafts** (by round and game number).
- After a draft, partners can **trade** games.
- **History** of every draft back to 2002-03 is kept and summarized.
- Each partner can set **private preferences** and see a **suggested next pick** that only they can see.

## 2. Users and roles

| Role | Who | Can |
|---|---|---|
| **Partner** | Every account | Draft when on the clock, view board/history, trade, edit own profile and preferences, pause the clock *when they are on the clock*, **call a time out** (when in the draft) and call time in on their own time out, send an email reminder |
| **Commissioner** | First account created; **any number of others can be promoted** (e.g. a backup) | Everything a partner can, plus: end anyone's time out, set the time-out length, create/start/delete drafts, choose participants and order, draft on behalf of anyone, pause/resume, undo, restart/reset drafts, edit games, import history, manage partners (activate/deactivate, promote, reset password links, delete) |

Rules:
- Sign-up requires an **invite code** (env `INVITE_CODE`). It is a server setting only — never displayed or editable in the app; changing it affects only future sign-ups. The **first** account becomes commissioner.
- **Multiple commissioners** are allowed (e.g. a backup to run the draft when the main one is away); all have the same powers.
- There must always be **at least one active commissioner** (block demoting/deactivating/deleting the last one).
- A commissioner cannot deactivate or delete their own account.
- **Inactive** partners cannot log in (existing sessions are ended), are not offered for new drafts, and keep their history.
- **Deleting** a profile: if the person has any draft history, keep the row as a *removed* profile (name kept on past results; login, email, preferences removed; username freed). Otherwise delete completely. Blocked while the person is in an unfinished draft. Pending trades involving them are cancelled.

## 3. Domain rules

### 3.1 Seasons, games and prices
- A **season** is labelled `YYYY-YY` (e.g. `2026-27`).
- **Prices are for the pair of seats** (this matches the Ticket Tracker). A single-seat pick is worth `price ÷ seats` (seats = 2).
- Game **types**: `preseason`, `regular`, `playoff`.
- Opponent may be `TBD` (playoffs).

### 3.2 Season draft
- Games come from a schedule (bundled official CSV, pasted/uploaded CSV, entered by hand, or a generated *sample* for testing).
- Each pick takes **both seats** of a game.
- **Snake** order by default (1-2-3, 3-2-1, …); **linear** also supported.
- Leftover picks (when games don't divide evenly) fall naturally to the **first partners in the order**.
- **Order rotation:** the new season's suggested order is the most recent season draft's order (status ≠ setup, latest season) **rotated so the last pick moves to first** (e.g. Q/Abela/Pope → Pope/Q/Abela → Abela/Pope/Q → Q/Abela/Pope). Inactive partners are dropped; partners not in last year's order are appended. Last season's order is shown for reference. The commissioner can reorder, re-apply the rotation, or randomize.
- Default season for a new season draft = the season after the latest season draft.

### 3.3 Playoff drafts
- Games are identified by **round (1–4) and game number (1–7)**, not by date.
- Per round the commissioner sets **home ice**: yes → home games **1, 2, 5, 7**; no → **3, 4, 6**. Games 5–7 get the note "if necessary".
- The commissioner chooses **which rounds** each playoff draft covers (e.g. rounds 1–3 now, round 4 later). A round may appear in only **one** playoff draft per season; rounds already drafted are shown greyed out.
- **Rounds 1–3: each pick takes both seats. Round 4 (the Final): each pick takes one seat** (a game has two picks; the same partner may take both if both are open on their turn).
- Optional per-round opponent (default TBD) and price (pair). Dates/times/opponents are filled in later with the games editor.
- **Order:** the first playoff draft of a season gets an order **drawn at random by the server** (cannot be re-rolled from the browser). A later playoff draft in the same season offers a choice: **reuse the earlier playoff draft's order** (default) or **draw a new random order**. The same choice is offered when editing partners in setup. With reuse, partners not in the earlier order are placed randomly after the others. The draft's notes record which happened ("Order carried over from …" / "Draft order drawn at random by the app on …").
- Default season for a playoff draft = the latest season draft's season.

### 3.4 Pick slots
- Total picks = Σ over games of (single-seat ? seats : 1).
- For 0-based overall index `i` with `n` partners: round = ⌊i/n⌋+1, pick-in-round = (i mod n)+1; in **snake** mode even rounds run in reverse order.

### 3.5 The clock
- Counts **up** from when a partner goes on the clock. Shown as MM:SS (H:MM:SS past an hour).
- **Warning** after `warn_secs` (default 120; configurable per draft; 0 = none; email drafts default to 0): clock turns red and pulses; the partner on the clock hears a short beep and sees a toast. **No hard limit.**
- **Pause/resume:** commissioner or the partner on the clock. Paused time is excluded from the pick's recorded time.
- **Making a pick always restarts the clock (running) for the next partner, even if it was paused.**
- **Time outs:**
  - Any partner **participating in the draft** (or a commissioner) can call a time out while the draft is live; only one at a time; no approval needed.
  - It **stops the clock** and **blocks picks** (enforced on the server; tiles can't be selected and the Draft button is disabled). Everyone can still view, search and filter the board.
  - Every viewer sees a banner: "⏸ TIME OUT — <name> called a time out · M:SS left · picks are paused — you can still browse and filter", with a live countdown. Others get a toast when one starts; everyone gets "Time in" when it ends.
  - It ends when the caller taps **Time in**, a commissioner taps **End time out**, or the **time-out length** runs out (enforced by a server timer, so it ends even if nobody has the board open; also re-armed on server restart).
  - On ending, the clock resumes if the time out stopped it (if the clock was already paused, it stays paused). Time-out time never counts toward the pick.
  - **Time-out length** is set per draft: default **3 minutes** (30 s – 30 min), on the New Draft form and changeable any time in ⚙ Commissioner controls → Settings.
  - While a time out runs, the commissioner's pause button is disabled; undo still works and keeps the clock stopped; restart/reset end the time out.
- **Undo** (commissioner) removes the last pick and puts that partner back on the clock with the time they had used. A pick that has been traded cannot be undone.
- Each pick records: overall, round, pick-in-round, drafter, current owner, game, seat (0 = pair, 1/2 = single), made-by (if entered on someone's behalf), seconds taken, timestamp.

### 3.6 Draft modes
- **Live:** everyone together; board updates instantly.
- **By email (async):** after each pick (and at start) the partner now on the clock gets a "You're on the clock" email with a link. Any partner can re-send it (✉ reminder).

### 3.7 Commissioner draft controls
- Start draft; draft on behalf of the partner on the clock.
- Pause/resume; **end time out**; **restart this pick's clock** (back to 0:00); undo last pick.
- **Settings** (any time): time-out length and clock-warning minutes.
- **Restart draft:** clear all picks (and any trades from it) and start again at pick 1 (stays live).
- **Reset to setup:** clear all picks (and trades) and stop; partners and order can then be edited.
- **Edit partners & order** (setup only); playoff drafts use the reuse/re-draw choice.
- **Games editor:** edit date, time, opponent, price, notes of any game at any time; add a game (season: by date; playoff: by round + game number); remove an unpicked game while in setup.
- Delete a draft (not allowed for completed app drafts; imported drafts can be deleted).

### 3.8 Trades
- Open once a draft is **complete**.
- A partner proposes: games they give and/or games they want, from one other partner in that draft, with an optional message. Only **upcoming** games (date ≥ today in Toronto, or no date yet) can be traded.
- Recipient **accepts** (ownership re-validated; game owners swap) or **declines**; proposer can **withdraw**. Accepting expires any other pending trade involving the same games.
- Emails on proposal and on accept/decline. A badge on the Trades menu shows incoming pending requests.
- Trades change the game's **current owner**; the original drafter is kept for history (shown as "⇄ via trade").

### 3.9 Presence
The board shows which participants currently have **that draft board open** (green dot) vs away (grey), plus a "+N watching" count for non-participants. Implemented from the live-update connections.

## 4. Draft preferences and suggested next pick

### 4.1 Preferences (Profile page; **private** — only the owner can read or write them)
All optional. If none are set, no suggestion is shown.
- **Days of the week:** each day Prefer / no preference / Avoid.
- **Favourite opponents:** up to **5**, ranked by importance (reorderable). Active teams only.
- **Ticket cost:** "Prioritize premium games" or no preference. (No "cheaper" option — tickets are prepaid.)
- **Repeat opponents:** "Happy to repeat" / no preference / "Prefer variety".
- **Preseason games:** Prefer / no preference / Avoid.
- **Start time:** Earlier starts (before 7 PM) / no preference / Evening (7 PM+).
- **Even out games per month** across the season (checkbox).
- **Minimum days between my games** (0–14).
- **Dates to avoid:** single dates or ranges with a label (up to 40).

### 4.2 Scoring (server-side, for the requesting partner only)
For each game still open to the partner, sum:

| Rule | Points |
|---|---|
| Date inside an avoided range | −200 |
| Preferred day / avoided day | +30 / −40 |
| Within `min_gap` days of a game the partner already holds | −25 |
| Even spread: month target = (games in month ÷ dated games) × partner's total picks; gap = target − held | +12×gap (max +24) if gap ≥ 0.5; 12×gap (min −24) if gap ≤ −0.5 |
| Repeat opponents — happy to repeat, already hold ≥1 vs this team | +12 |
| Repeat opponents — prefer variety | −18 × games already held vs this team; +6 for a team not yet held (once the partner has any game) |
| Favourite opponent rank #1…#5 | +50, +40, +30, +20, +12 |
| Preseason prefer / avoid | +15 / −35 |
| Premium (if enabled): normalized price among open games | +25 × norm |
| Start time matches preference | +10 |
| Single-seat game where the partner holds the other seat | +8 |

Sort by score (ties → earlier game). Return the **top 3** with reasons (each reason flagged good/bad; strongest first). Do not count undated games for day/spread/gap rules.

### 4.3 Display
- A **"💡 Your next pick — suggested"** line under the board toolbar: game, price, two strongest reasons, two alternatives (clickable), **Select** (highlights and scrolls to the tile), **Why?** (top 3 with every ✓/✗ reason and an "Edit preferences" link). A small 💡 on the suggested tile.
- Refreshes after every pick. Hidden for partners with no preferences, for non-participants, and on completed drafts. On phones only the 💡, game and buttons show.
- The suggestion endpoint must only ever return the caller's own suggestion; preferences must never appear in other users' API responses.

## 5. Screens

Navigation (top bar): **Drafts · History · Trades · Partners** (commissioner only) **· Profile · Log out**. On phones (≤700px) the links collapse behind a ☰ menu.

1. **Log in / Sign up** — username, password; sign-up adds display name, email, invite code. "Forgot your password?" link. **Every password box (here, Reset password and Profile) has a Show/Hide toggle** (switches the input between hidden and visible text; accessible label/pressed state).
2. **Forgot password** — username or email → emails a single-use reset link valid 2 hours. Always answers the same way (no account discovery). If email isn't configured, says so and suggests asking the commissioner.
3. **Reset password** (`#/reset/<token>`) — new password + confirm; logs the user in; ends other sessions.
4. **Drafts (home)** — current drafts (live/setup) with status pills, kind, mode, "who's on the clock and for how long", a "⏸ time out" note when one is running, buttons (Enter draft room / Your pick → / Preview board / Start draft / Delete); the latest four past drafts with a link to all. Commissioner: **+ New draft**.
5. **New draft** (commissioner)
   - Details: draft type (season / playoff), name (auto-filled), season, order type, live vs email, clock warning minutes, **time-out length** (minutes, default 3).
   - **Participating partners** (checkboxes; active partners only; any number ≥2).
   - **Selection order**: season → last season's order shown, rotated order pre-filled, reorder ▲▼, Use rotation, Randomize. Playoff → random-draw note, or reuse/new-random choice.
   - Season: **Schedule** source (bundled official CSV(s), paste/upload CSV, by hand, sample) with summary (games by type/month, picks each, extras) and a **games table** (remove rows, add a game).
   - Playoff: **Playoff rounds** table (include, home ice, home games, seats per pick, opponent, price) and summary.
6. **Draft board**
   - **Time-out banner** (when one is running) above the scoreboard, with countdown and Time in / End time out.
   - Scoreboard: clock (with control buttons: pause, undo, ✉ reminder, **⏱ time out**, ⚙), round and pick, who's on the clock (avatar, "YOU'RE ON THE CLOCK"), next up (4), Start/Edit partners in setup, results link when complete.
   - Toolbar: opponent filter (teams in this draft), game-type filter (only if mixed), day-of-week chips (multi; hidden when no game has a date), **Show** chips — Available / My games / Taken by others (a game shows if it matches **any** selected chip), search (team, date, month, round/game, notes), Clear, Games… (commissioner), **Draft game / Draft seat / Draft for <name>**. Filters persist per browser.
   - Suggestion line (§4.3). Banner: draft name, picks made/total, mode; **In the draft room** presence.
   - Board: columns by month (season) or by round (playoffs). Open tiles are **team-coloured** (main colour background, second-colour stripe, readable text; logo on a white disc), showing date/time (or "Game N" + date/TBD), city, price, name, notes, "1 SEAT" badge, seats left. Taken tiles are dark grey with the owner's colour bar, owner name, ⇄ if traded, S1/S2 seat, round.pick. Completed drafts show undrafted games with their note.
   - During a time out open tiles are dimmed and can't be selected.
   - Tap/click selects; double-click or the Draft button opens a confirmation ("Lock it in"). Esc clears selection.
   - Ticker of the last 15 picks with times (desktop).
   - ⚙ Commissioner controls sheet (§3.7). Browser tab title shows "🍁 YOUR PICK" when on the clock; toast + beep when you go on the clock.
7. **History** — header with **Import past drafts** (commissioner). **All-time**: per partner total games, Saturdays, Fri–Sun; season-by-season table (games and value per partner, completed season drafts, after trades; "order not recorded" flag). **All drafts** list.
8. **Draft results** — notes (freebie, spreadsheet notes, order origin), draft order, one panel per partner (games/picks, Fri–Sun, value, avg pick, longest; list of games with **pick # and ticket cost**, ⇄ via trade), **Results by round** grid (only when order recorded and each partner has ≤1 pick per round), **Pick log** (or "Games by date" when order unknown): #, Rd.Pick (regular rounds only), partner (and "entered by commissioner"), game, price, time taken, picked at; **Not drafted** list.
9. **Import past drafts** (commissioner) — **Ticket Tracker history** panel (map spreadsheet names Q/Abela/Pope to accounts; table of seasons with picks, order, recorded?, notes; import selected; optional re-import) and **single CSV import**.
10. **Trades** — propose (draft, partner, two checklists of upcoming games with values, message, live value summary), open requests (accept/decline/withdraw), trade history.
11. **Partners** (commissioner) — note that several commissioners are allowed (at least one); table: partner, username, email, drafts count, role, status; actions Activate/Deactivate, Make/Remove commissioner, Reset password (shows a copyable link; also emailed if possible), Delete. Removed profiles listed.
12. **Profile** — display name, email, email-notification toggle, favourite Leaf, board colour; change password; **Draft preferences** (§4.1); "My drafts" table (games held, value, avg pick time, draft slot).

## 6. Data import

### 6.1 Schedule CSV
Header row anywhere in the first 20 lines containing **Date** and **Team/Opponent**; optional Time, Type (`Pre-Season` / `Regular Season` / `Playoffs`), Price, Notes. Extra columns ignored. Dates accepted: `29-Sep-26`, `2026-09-29`, `Sep 29, 2026`, `9/29/2026`. Times like `7:00 PM` (bare `7:00` = evening). Away games (`@ …`, `at …`) skipped. Team names matched by abbreviation, nickname, city or full name, accent-insensitive (Montréal = Montreal). UTF-8 BOM tolerated.

### 6.2 Single past-draft CSV
One row per pick: **Partner** (username or display name, or mapped alias), **Date**, **Team** required; optional Pick (overall #), Time, Price, Type, Seconds (`1:42`), Notes. Rows with a blank partner are games nobody drafted. If no row has a pick number, the pick sequence is "not recorded" (rows sorted by date). Round-1 order = first appearance (or a supplied order). Errors list every bad row; unknown partner names are returned so the UI can explain.

### 6.3 Ticket Tracker workbook converter (`tools/convert_ticket_tracker.py`, Python + openpyxl)
Converts the partners' workbook (one worksheet per season, 2002-03 → 2026-27) into `history/<season>.csv` + `history/manifest.json`. Must handle:
- Skipped sheets: RefData, Old2027, Exhibition Table, Game Schedule, 2023-24 Offical NHL Schedule, rawSched, Sheet2.
- Layouts: 2017+ header row (#, [Order/Selection Order], Selector, Month, Day, Date, Teams, [Ticket Tier], [Time], [Price], [TimeStamp]); 2009–2016 (#, Selector, Month, Day, Date, Teams); 2002–2008 (order block top-left, then #, Selector, [Day], Date, Team).
- Selectors `Q`, `Abela`, `Pope` (any case). Other/blank selectors (e.g. "Free Game", tier "X") → "not drafted" games.
- **Selection Order block** read **by position number** (rows are not always in order); the block's # of picks and ticket value used for checks only when the layout matches. Old a/b/c… slot blocks give the order; irregular slots noted (2002-03 used an 8-slot 3/8-share rotation).
- Text dates (`2 OCT 2016`); **year correction** from the season (Aug–Dec = start year, Jan–Jul = next).
- Team spellings: abbreviations (Bos, Phil, Pitt, Mtl, Nash, Buff, Mont, Flr, Pens, Anh, …), nicknames in caps with trailing spaces, cities only, "(Pre…)" suffix; former teams Phoenix/Arizona Coyotes (by season) and Atlanta Thrashers.
- Preseason: "Pre-Season" tier, "(Pre…)" in the name, or **September games before 2026-27**. Other tiers (Premium, Super Premium, …) kept as game notes.
- Pick order: Order column when complete (2026-27, 2021-22, 2019-20); **row order** when rows are out of date order and not grouped by partner (2002-03). 2026-27 pick times derived from consecutive TimeStamps.
- **Price checks against the sheet's Ticket Value:** if every partner's value = 2 × the sum of prices, prices were per seat → double them (2013-14, 2014-15). Explain the known sheet formula bug that omits the last row (2023-24, 2024-25: Pope's last game).
- Partner-confirmed fixes: 2003-04 game on 2004-02-12 = Columbus Blue Jackets (sheet said "Feb"); 2012-13 tally of 9 for Abela is wrong (8 listed games are right).
- Manifest per season: sheet, season, round-1 order, counts, ticket values, freebie, pick_order_recorded, report notes, file, picks, unassigned.

The app's **bundled history import** reads the manifest, imports chosen seasons as completed `import` drafts named `<season> Season Draft`, with notes built from the manifest (order not recorded, freebie, spreadsheet notes, source sheet). Already-imported seasons are skipped unless "re-import" is ticked (which replaces them). Trades are allowed from imported drafts (past games are blocked anyway).

## 7. Teams and colours

Tiles use the team's main colour, a stripe in the second colour and the given text colour. Former franchises are used only for history and are not offered for new games or preferences.

| Abbr | City | Name | Division | Tile colour | Stripe | Text |
|---|---|---|---|---|---|---|
| ANA | Anaheim | Ducks | Pacific | #F47A38 | #111111 | #111111 |
| BOS | Boston | Bruins | Atlantic | #FFB81C | #111111 | #111111 |
| BUF | Buffalo | Sabres | Atlantic | #003087 | #FFB81C | #FFFFFF |
| CGY | Calgary | Flames | Pacific | #C8102E | #F1BE48 | #FFFFFF |
| CAR | Carolina | Hurricanes | Metropolitan | #CE1126 | #111111 | #FFFFFF |
| CHI | Chicago | Blackhawks | Central | #CF0A2C | #111111 | #FFFFFF |
| COL | Colorado | Avalanche | Central | #6F263D | #236192 | #FFFFFF |
| CBJ | Columbus | Blue Jackets | Metropolitan | #002654 | #CE1126 | #FFFFFF |
| DAL | Dallas | Stars | Central | #006847 | #8F8F8C | #FFFFFF |
| DET | Detroit | Red Wings | Atlantic | #CE1126 | #FFFFFF | #FFFFFF |
| EDM | Edmonton | Oilers | Pacific | #FF4C00 | #041E42 | #041E42 |
| FLA | Florida | Panthers | Atlantic | #C8102E | #B9975B | #FFFFFF |
| LAK | Los Angeles | Kings | Pacific | #111111 | #A2AAAD | #FFFFFF |
| MIN | Minnesota | Wild | Central | #154734 | #A6192E | #FFFFFF |
| MTL | Montréal | Canadiens | Atlantic | #AF1E2D | #192168 | #FFFFFF |
| NSH | Nashville | Predators | Central | #FFB81C | #041E42 | #041E42 |
| NJD | New Jersey | Devils | Metropolitan | #CE1126 | #111111 | #FFFFFF |
| NYI | New York | Islanders | Metropolitan | #00539B | #F47D30 | #FFFFFF |
| NYR | New York | Rangers | Metropolitan | #0038A8 | #CE1126 | #FFFFFF |
| OTT | Ottawa | Senators | Atlantic | #DA1A32 | #B79257 | #FFFFFF |
| PHI | Philadelphia | Flyers | Metropolitan | #F74902 | #111111 | #FFFFFF |
| PIT | Pittsburgh | Penguins | Metropolitan | #FCB514 | #111111 | #111111 |
| SJS | San Jose | Sharks | Pacific | #006D75 | #EA7200 | #FFFFFF |
| SEA | Seattle | Kraken | Pacific | #001628 | #99D9D9 | #FFFFFF |
| STL | St. Louis | Blues | Central | #002F87 | #FCB514 | #FFFFFF |
| TBL | Tampa Bay | Lightning | Atlantic | #002868 | #FFFFFF | #FFFFFF |
| UTA | Utah | Mammoth | Central | #6CACE4 | #010101 | #010101 |
| VAN | Vancouver | Canucks | Pacific | #00205B | #00843D | #FFFFFF |
| VGK | Vegas | Golden Knights | Pacific | #B4975A | #333F42 | #111111 |
| WSH | Washington | Capitals | Metropolitan | #C8102E | #041E42 | #FFFFFF |
| WPG | Winnipeg | Jets | Central | #041E42 | #AC162C | #FFFFFF |
| PHX | Phoenix | Coyotes (former) | Pacific | #8C2633 | #E2D6B5 | #FFFFFF |
| ARI | Arizona | Coyotes (former) | Central | #8C2633 | #E2D6B5 | #FFFFFF |
| ATL | Atlanta | Thrashers (former) | Metropolitan | #041E42 | #B9975B | #FFFFFF |

**Logos** load from a URL template (env `LOGO_URL`, default `https://assets.nhle.com/logos/nhl/svg/{abbr}_{variant}.svg`, variant `light`/`dark`; empty = off). A logo that fails to load is simply removed. Logos are NHL trademarks — fine for this private app; do not make the site public with them.

## 8. Look and feel
- Inspired by fantasy-football draft boards: dark background, bold condensed type (Barlow Condensed for headings, Barlow for text), Leafs blue `#00205B` top bar with a white rule, yellow `#FFCF3F` clock and primary "go" buttons.
- Status pills (live/setup/complete), partner avatars (initials on the partner's chosen colour).
- **Phones (≤700px):** compact top bar with ☰; on the board the top bar scrolls away and a slim sticky header holds clock, round/pick, who's on the clock and a ⋯ menu (pause, reminder, commissioner controls, games, results), plus a line with next up and presence dots; search + **Filters (count)** button opening the filter panel; games as a **two-column list** with sticky month/round headings; a large floating **Draft** button naming the selected game; dialogs as bottom sheets; ticker hidden. Desktop layout unchanged by these rules. No horizontal page scroll at 390px.

## 9. Notifications (email)
- SMTP via env `SMTP_URL` (e.g. `smtps://user:app-password@smtp.gmail.com`), `MAIL_FROM`, links built from `APP_URL`. Without `SMTP_URL`, messages are written to the server log.
- Emails: on the clock (email drafts; start and after each pick), reminder, trade proposed, trade accepted/declined, password reset (self-service and commissioner). Each user can turn notifications off (password resets always send).

## 10. Reference architecture (current build)
- **Runtime:** Node.js ≥ 22.13, **Express 5**, **built-in `node:sqlite`** (no native modules), `nodemailer` 6. No front-end framework or build step: a single-page app in `public/` (`index.html`, `app.css`, `app.js`) with hash routing (`#/`, `#/new`, `#/board/:id`, `#/history`, `#/history/:id`, `#/import`, `#/trades`, `#/partners`, `#/profile`, `#/login`, `#/forgot`, `#/reset/:token`).
- **Auth:** scrypt password hashes (random salt); session token in `sessions` table; cookie `sid` HttpOnly, SameSite=Lax, 30 days, `Secure` behind HTTPS (`trust proxy`).
- **Live updates:** Server-Sent Events at `/api/events/:key` (`key` = draft id, `home`, or `trades`); events `update` (refetch) and `presence` (`{online:[userIds]}`); 25s keep-alive pings. Clients refetch state on `update`.
- **Files:** `server.js` (routes and draft/trade logic), `src/db.js` (schema + additive migrations), `src/schedule.js` (CSV parsing, sample schedule), `src/teams.js` (teams, colours, lookup), `src/suggest.js` (preferences + scoring), `src/mail.js`, `tools/convert_ticket_tracker.py`, `schedules/*.csv`, `history/*`.
- **Robustness details:** route-sequence guard so a slow page never draws over a newer one; popups close on navigation; live-update listeners torn down on navigation; transactions (`BEGIN IMMEDIATE`) around picks, trades, imports.

### 10.1 Data model (SQLite)
- `users`(id, username UNIQUE NOCASE, display_name, email, notify_email, color, favorite_player, is_admin, active, deleted_at, prefs JSON, password_hash, created_at)
- `sessions`(token PK, user_id, expires_at)
- `password_resets`(token_hash PK [sha256], user_id, expires_at, used_at)
- `drafts`(id, name, season, kind season|playoff, seat_mode pair|single|mixed, mode live|async, order_type snake|linear, warn_secs, timeout_secs [default 180], timeout_by, timeout_ends_at, timeout_paused_clock, status setup|live|complete, source app|import, notes, order_recorded, created_by, created_at, started_at, completed_at, clock_started_at, paused_at, paused_ms)
- `draft_order`(draft_id, position, user_id)
- `games`(id, draft_id, date '' or YYYY-MM-DD, time '' or HH:MM, opponent, type, price [pair], seats=2, single 0|1, round, game_no, notes)
- `picks`(id, draft_id, overall, round, pick_in_round, user_id [drafter], owner_id [current], game_id, seat, made_by, seconds_taken NULL for imports, picked_at; UNIQUE(draft_id, overall), UNIQUE(draft_id, game_id, seat))
- `trades`(id, draft_id, from_user, to_user, status pending|accepted|declined|cancelled|expired, message, created_at, resolved_at); `trade_items`(trade_id, pick_id, side give|get)

### 10.2 API (JSON; all under `/api` except `/healthz`)
Auth: `POST register | login | logout`, `GET/PUT me`, `GET/PUT me/prefs`, `PUT me/password`, `POST password/forgot | password/reset`.
Partners (commissioner): `GET users` (any user), `PUT users/:id` {active, is_admin}, `DELETE users/:id`, `POST users/:id/reset-link`.
Reference: `GET teams`, `GET schedules`, `POST schedule/preview` {source bundled|csv|none|sample}.
Drafts: `GET drafts`, `POST drafts` (season: games; playoff: rounds + playoff_order), `GET drafts/next-order`, `GET drafts/playoff-prior?season=&before=`, `GET drafts/:id`, `GET drafts/:id/suggestion`, `DELETE drafts/:id`, `POST drafts/:id/start | pick {game_id} | pause | undo | nudge | control {action: reset_clock|restart|reset} | timeout {action: start|end}`, `PUT drafts/:id/settings {timeout_secs, warn_secs}`, `PUT drafts/:id/order {user_ids, playoff_order}`, `POST drafts/:id/games`, `PUT/DELETE drafts/:id/games/:gid`.
History: `POST drafts/import`, `GET/POST history/bundled`, `GET history/summary`.
Trades: `GET trades[?draft_id]`, `POST trades`, `POST trades/:id/accept|decline|cancel`.
Live: `GET events/:key` (SSE).

## 11. Configuration
| Env var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `INVITE_CODE` | `goleafsgo` | Sign-up code (change it) |
| `DB_FILE` | `data/draftboard.db` | SQLite file |
| `APP_URL` | `http://localhost:PORT` | Public URL for email links |
| `SMTP_URL` | — | Outgoing mail; unset = log only |
| `MAIL_FROM` | `Leafs Ticket Draft <no-reply@localhost>` | Sender |
| `LOGO_URL` | NHL logo CDN template | Team logo images; empty = off |

## 12. Deployment
Single Node process + SQLite file on a **persistent volume**. Provided: `Dockerfile` (node:22-slim, `DB_FILE=/data/draftboard.db`, port 8080) and `fly.toml` (Toronto region `yyz`, volume `draftboard_data` at `/data`, HTTPS forced, `/healthz` check). Recommended host: Fly.io (~US$2–5/month). Back up the database file periodically.

## 13. Acceptance checklist
A rebuild is complete when all of these work:
1. First sign-up becomes commissioner; invite code enforced; inactive users can't log in.
2. Season draft from the bundled 2026-27 CSV: 42 games → 14 picks each, snake order, rotation pre-filled from last season.
3. Clock counts up, warns at 2:00 (no limit), pauses, and **restarts automatically after a pick made while paused**; times exclude paused time.
   - Any participant can call a **time out** (default 3 min): clock stops, picks blocked for everyone (server-enforced), banner + countdown on every screen, board still browsable; ends by caller's Time in, a commissioner, or automatically at the limit; the commissioner can change the length.
   - A second commissioner can be promoted and has full powers (e.g. ends time outs, undo); the last commissioner can't be removed.
4. Two browsers see picks, presence and clock changes instantly; email mode sends on-the-clock emails (or logs them).
5. Filters: Available + My games, and My games + Taken by others, behave as OR; day chips, opponent, search.
6. Commissioner: undo, restart pick clock, restart draft, reset to setup, edit partners/order, games editor, draft on behalf.
7. Playoff draft for rounds 1–3 (home ice yes/no/yes → 11 pair games), then a round-4 draft (4 single-seat games, 8 picks) with reuse-or-redraw order; a round can't be drafted twice; the same partner can take both Final seats.
8. Trades: propose, accept (owners swap, other pending trades expire), decline, withdraw; past games blocked; undated playoff games allowed.
9. Bundled history imports all 23 seasons (974 picks); totals match the sheet's Ticket Value (e.g. 2026-27 Q $3,732, Abela $3,708, Pope $3,940); all-time table; results pages adapt when order wasn't recorded.
10. Preferences save privately; suggestion appears only for that partner, respects avoided dates, updates after picks, disappears when preferences are cleared.
11. Phone layout at 390px: no horizontal scroll, games visible on first screen, floating Draft button.
12. Password reset via emailed link and via commissioner link (single use, 2 hours).

## 14. Data files to supply with this document
- `schedules/TML_2026-2027.csv` — official 2026-27 home schedule (Type, Month, Day, Date, Team, Time, Price, TimeStamp, …).
- `history/*.csv` + `history/manifest.json` — converted Ticket Tracker history — **or** the original workbook `TicketTrackerv2026-2027-Post-Draft.xlsx` plus the converter rules in §6.3.
