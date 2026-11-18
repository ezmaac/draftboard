# 🍁 Leafs Ticket Draft

A draft room for splitting Toronto Maple Leafs season-ticket home games between partners.

## Features (draft v0.1)
- **Draft board**: home games in columns by month/year, colour-coded by the opponent's division. Taken games show who picked them and in which slot.
- **Filters**: by opponent, by day of the week (multi-select), "available only", and free-text search. Filters are remembered per browser.
- **Count-up clock**: starts when a partner goes on the clock and records the seconds each pick took. It can be paused, and the commissioner can undo the last pick.
- **Live updates**: every partner's board refreshes as soon as a pick is made, using Server-Sent Events.
- **Snake or linear order**, set by hand or randomized.
- **Accounts & profiles**: sign up with an invite code, log in, and set a display name, email, board colour, favourite Leaf and password.
- **History**: every draft is kept, with the draft order, a results-by-round grid, each partner's games and pick-time stats, and a full timestamped pick log.
- **Schedule import**: paste or upload a CSV (`date,time,opponent,notes`). Until the real schedule is loaded, a **sample** schedule is generated. It is placeholder data, *not* the real Leafs schedule.

## Run it
Requires Node 22.13+ (it uses the built-in `node:sqlite`; nothing to compile).

```bash
npm install
npm start           # http://localhost:3000
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `INVITE_CODE` | `goleafsgo` | Code needed to sign up (change it!) |
| `DB_FILE` | `data/draftboard.db` | SQLite database file |

The **first account created becomes the commissioner** (admin). Only the commissioner can create, start or delete drafts, undo picks, and draft on behalf of an absent partner.

## Layout
- `server.js`: Express API, auth (scrypt hashes plus session cookies), draft logic and SSE.
- `src/db.js`: SQLite schema.
- `src/schedule.js`: sample schedule generator and CSV import.
- `src/teams.js`: NHL teams and divisions.
- `public/`: single-page front end (vanilla JS, no build step).
