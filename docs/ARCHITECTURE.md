# Leafs Ticket Draft — Architecture Overview

*A plain-language summary of how the app is built and how its data is managed. Last updated: 2026-11-23.*

> Keep this document current: any change to the app's components, data storage, dependencies, hosting or live-update approach must be reflected here (see `CLAUDE.md`). For full technical detail see §10 of [`REQUIREMENTS.md`](REQUIREMENTS.md).

## In one sentence
A **full-stack** web app — browser front end, server back end and database — deliberately kept small: **one Node.js program and one database file**, with only two outside libraries.

```
  Browser (phone / computer)                Server (one Node.js process)                 Storage
 ┌──────────────────────────┐   HTTPS   ┌───────────────────────────────────┐   ┌────────────────────────┐
 │ Single-page app          │──JSON────▶│ Express web server                │──▶│ SQLite file            │
 │ index.html, app.js,      │◀──────────│  • 44 API routes                  │   │ data/draftboard.db     │
 │ app.css (no framework)   │           │  • draft engine, clock, trades    │   └────────────────────────┘
 │                          │◀──live────│  • live-update hub (SSE)          │   ┌────────────────────────┐
 │ EventSource (live feed)  │  updates  │  • suggestion scoring             │──▶│ Bundled files:         │
 └──────────────────────────┘           │  • time-out timers                │   │ schedules/*.csv        │
          │                             │  • email sender (nodemailer) ─────┼──▶│ history/*.csv          │
          └─▶ NHL logo images, Google Fonts (loaded directly by the browser)│   └────────────────────────┘
                                        └───────────────────────────────────┘
```

## 1. Front end — runs in the browser
- **A single page that redraws itself** for each screen. Screens are addresses after `#` (e.g. `#/board/5`, `#/history`).
- **No framework, no build step:** three plain files in `public/` — `index.html`, `app.css`, `app.js` — served as-is.
- **Talks to the server with JSON requests** ("get draft 5", "make pick: game 12").
- **Live updates:** keeps an open Server-Sent Events connection. When anything changes (a pick, pause, time out, someone joining), the server sends a short "changed" message and every open screen re-fetches the latest state — so all partners see picks instantly. The same connection reports who is in the draft room.
- **Stores almost nothing locally** — only your board filter choices. Everything else lives on the server.
- **The clock** is drawn by the browser from timestamps the server provides, so it ticks smoothly without asking the server every second.
- **Phone layout** is handled in the same files (a phone-only section of `app.css`).

## 2. Back end — the server
- **Node.js 22 + Express 5**: serves the front-end files and the JSON API (44 routes).
- **Rules are enforced here**, not just in the browser:
  - **Accounts and security:** invite-code sign-up; passwords stored hashed (scrypt), never in plain text; 30-day login via a secure, HttpOnly session cookie; single-use password-reset links.
  - **Permissions:** partner vs commissioner (several commissioners allowed, at least one always kept).
  - **Draft engine:** whose turn it is (snake/linear), playoff seat rules, order rotation, server-side random draws, blocking picks during a time out.
  - **Clock:** the server stores *when* a pick went on the clock and how long it has been paused, rather than counting itself — so it stays accurate across restarts.
  - **Trades, history imports and suggestion scoring** (`src/suggest.js`) — suggestions are only ever calculated for the person asking.
- **Timers** end time outs on schedule even if nobody has the board open (re-armed if the server restarts).
- **Email** via nodemailer once a mail account is configured; until then messages go to the server log.

**Server files:** `server.js` (routes and logic) · `src/db.js` (database setup) · `src/teams.js` (teams, colours) · `src/schedule.js` (CSV reading) · `src/suggest.js` (preferences and scoring) · `src/mail.js` (email).

## 3. Data — how it is managed
- **Database: SQLite**, built into Node 22 — no separate database server to install or run. The whole database is **one file**, `data/draftboard.db`. Backing up = copying that file.

| Table | Holds |
|---|---|
| `users` | Accounts, commissioner role, active/removed status, colour, private draft preferences |
| `sessions`, `password_resets` | Logins and single-use reset links |
| `drafts` | Each draft's settings and status, clock timestamps, current time out |
| `draft_order` | Who picks in which position |
| `games` | Games in each draft: date, opponent, price (for the pair), playoff round/game, single-seat flag |
| `picks` | Every pick: who drafted it, **who owns it now** (trades change this), seat, time taken |
| `trades`, `trade_items` | Trade requests and the games involved |

- **The server is the single source of truth.** Browsers never change data directly; they ask the server, which checks the rules and saves.
- **Transactions** wrap picks, trades and imports, so two people clicking at the same moment can't both take the same game.
- **Automatic upgrades:** new columns are added when the server starts, so updates don't wipe existing data.
- **Reference data ships with the app as files:** the official 2026-27 schedule (`schedules/`), 24 seasons of converted history (`history/`), and the team list and colours (in code).
- **One separate, offline tool:** a Python script (`tools/convert_ticket_tracker.py`) converted the partners' Excel workbook into the history files. It is run by hand when needed and is not part of the running app.

## Developer tools — not part of the running app
- **Automated tests** (`test/`, run with `npm test`): Node's built-in test runner, no extra libraries. Each test file starts the real server on its own temporary database and drives it through the same JSON API the browser uses, covering the acceptance checklist in `REQUIREMENTS.md` §13 (except the phone layout). Takes about 2 seconds.
- **Demo data** (`tools/seed.js`, run with `npm run seed`): builds a separate database (`data/dev.db` by default) with three partners, all bundled history, a live draft and a playoff draft — also through the API, so the data always follows the app's rules.
- Both use a small shared helper (`tools/lib/harness.js`) that starts the server and keeps a login cookie.

## 4. What it needs to run
| Need | Detail |
|---|---|
| Software | **Node.js 22.13+** only. `npm install` adds just two libraries: **express** and **nodemailer**. |
| Hosting | One small server with a **persistent disk** (so the database file survives restarts) and **HTTPS**. A `Dockerfile` and Fly.io config are included (Toronto region, ~US$2–5/month). |
| Settings (optional) | Invite code, mail account (`SMTP_URL`), site address (`APP_URL`), logo source (`LOGO_URL`), port, database location. |
| External services | NHL logo images and Google Fonts (loaded by the browser); an email provider if email is wanted. |

## 5. Why it's built this way
- **Good fit for a handful of partners:** cheap to host, nothing to administer, one file to back up, very few dependencies to keep up to date.
- **The trade-off:** it is designed to run as **one server instance** — the SQLite file and the live-update connections both live inside that one process. That is fine for a few (or even dozens of) users. Serving thousands across several servers would mean swapping in a database server (e.g. PostgreSQL) and a shared messaging service for live updates — not needed here.

## 6. Example: what happens when you make a pick
1. You tap a tile and **Lock it in** → the browser sends "pick game 12 in draft 5".
2. The server checks you're logged in, it's your turn (or you're a commissioner), there's no time out, and the game is still open.
3. In one transaction it saves the pick (with time taken, excluding paused/time-out time) and restarts the clock for the next partner.
4. It sends emails if this is an email draft, then broadcasts "draft 5 changed" over the live connection.
5. Every open board re-fetches the draft and redraws — the game turns grey with your name, and the next partner hears the "you're on the clock" beep.
