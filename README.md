# 🍁 Leafs Ticket Draft

A draft room for splitting Toronto Maple Leafs season-ticket games between partners. Everyone drafts from their own device, wherever they are.

## Features
- **Draft board**: home games in columns by month/year, colour-coded by the opponent's division, with the ticket price for the pair of seats (as in the Ticket Tracker). Preseason games carry a `PRE` tag and playoff games a `PO` tag.
- **Filters**: opponent, day of week (multi-select), game type, "available only", "my games", and free-text search.
- **Count-up clock**: records how long every pick took. After a configurable warning time (default **2:00**), the clock turns red and the partner on the clock hears a beep. There is **no time limit**. The clock can be paused; the commissioner can undo the last pick or draft on someone's behalf.
- **Two kinds of draft**
  - **Season draft**: preseason + regular season. Each pick takes the **pair** of seats. The order is snake (or linear), and leftover games go to the first picks in the order.
  - **Playoff draft**: run separately, closer to the playoffs. Each pick takes **one seat**, so two partners can end up at the same game (one partner may take both seats if both are still open on their turn). The order is **drawn at random by the app** when the draft is created, so it can't be re-rolled. Games can be added as they're scheduled (opponent can be `TBD`).
- **Live or by email**: a live draft updates instantly for everyone. An email draft sends a "you're on the clock" message after each pick, and anyone can re-send a reminder (✉ button). The home page shows who's on the clock and for how long.
- **Trades**: once a draft is complete, any partner can propose a trade (games for games, or a one-sided give or request) with a message. The other partner accepts or declines, and the proposer can withdraw. Games already played can't be traded. Trades update current holdings; the original draft results are preserved.
- **History**: every draft is kept, with the draft order, each partner's holdings, dollar value and pick-time stats, a results-by-round grid, and a timestamped pick log. Past drafts can be imported from a spreadsheet.
- **Accounts & profiles**: invite-code sign-up, login, and a profile with display name, email, notification opt-out, board colour, favourite Leaf and password change.

## Run locally
Requires Node 22.13+ (uses the built-in `node:sqlite`; nothing to compile).

```bash
npm install
npm start           # http://localhost:3000
```

The **first account created becomes the commissioner**, who creates, starts and deletes drafts and imports history.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `INVITE_CODE` | `goleafsgo` | Code needed to sign up. **Change it.** |
| `DB_FILE` | `data/draftboard.db` | SQLite database file |
| `APP_URL` | `http://localhost:PORT` | Public URL, used for links in emails |
| `SMTP_URL` | *(unset)* | e.g. `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com`. Unset = emails are only printed to the server log. |
| `MAIL_FROM` | `Leafs Ticket Draft <no-reply@localhost>` | Sender address |

## Schedules
`schedules/*.csv` appear as "official" sources when you create a draft. `TML_2026-2027.csv` (42 home games) is included. Any CSV with a header row containing **Date** and **Team** (or Opponent) works. **Time**, **Type** (`Pre-Season` / `Regular Season` / `Playoffs`), **Price** and **Notes** are optional, and extra columns are ignored. Dates can be `29-Sep-26`, `2026-09-29` or `9/29/2026`. Games can also be added or removed by hand before a draft is created, and the commissioner can add games to an unfinished draft (**+ Game** on the board).

## Importing past drafts
**Ticket Tracker history (bundled).** `history/` holds every season from the partners' Ticket Tracker workbook (2002-03 to 2026-27), converted by `tools/convert_ticket_tracker.py`. To load it, go to **Import past drafts**, match each spreadsheet name (Q, Abela, Pope) to an account, and import. Each season keeps who got which game, the round-1 order, prices where recorded, the freebie, and games nobody drafted. The exact pick sequence exists only where the sheet recorded it (2026-27, 2021-22, 2019-20, 2002-03); 2026-27 also has pick times derived from its timestamps. To regenerate after editing the workbook:

```bash
pip install openpyxl
python3 tools/convert_ticket_tracker.py TicketTracker.xlsx history
```

**Any other CSV.** The single-draft import takes one row per pick:
```
Pick,Partner,Date,Team,Time,Price,Seconds
1,Mark,7-Oct-25,Montreal Canadiens,7:00 PM,$404,
2,Dave,11-Oct-25,Ottawa Senators,7:00 PM,$304,1:42
```
`Partner` must match an account's username or display name. Round 1's order comes from each partner's first pick. Imported drafts can be deleted and re-imported.

## Hosting
Partners in different places need the app on the internet. It's a single Node process with a SQLite file, so any host with a **persistent disk** works.

**Fly.io (recommended, ~US$2–5/month)**: Toronto region, HTTPS included.
```bash
fly launch --copy-config --no-deploy        # pick a unique app name
fly volumes create draftboard_data --region yyz --size 1
fly secrets set INVITE_CODE=... APP_URL=https://<app>.fly.dev SMTP_URL=... MAIL_FROM="Leafs Draft <you@gmail.com>"
fly deploy
```
Other options: Render or Railway (needs a paid plan with a disk), or any small VPS using the `Dockerfile`. Back up the SQLite file occasionally (`fly ssh sftp get /data/draftboard.db`).

## Layout
- `server.js`: Express API, auth (scrypt + session cookies), draft/trade logic, imports, Server-Sent Events.
- `src/db.js`: SQLite schema. `src/schedule.js`: CSV parsing. `src/mail.js`: email. `src/teams.js`: NHL teams.
- `public/`: single-page front end (vanilla JS, no build step).
