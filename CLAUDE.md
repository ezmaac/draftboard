# Leafs Ticket Draft — notes for coding sessions

Private draft app for splitting Toronto Maple Leafs season tickets among partners (a handful of users, mostly on phones). Node 22.13+ + Express 5 + built-in `node:sqlite`; vanilla-JS single-page front end in `public/` (no build step). Only two dependencies: `express`, `nodemailer`.

## Run and verify
```bash
npm install
npm start                                   # http://localhost:3000
DB_FILE=/tmp/dev.db PORT=3999 npm start     # throwaway database — use this when testing changes
curl localhost:3999/healthz                 # → ok
```
- There is no automated test suite yet. To check a change, run the app against a throwaway `DB_FILE` and exercise it in a browser (Playwright is available in cloud sessions).
- The first account registered becomes the commissioner; the default invite code is `goleafsgo`. Register 2–3 accounts to test drafts, and load `schedules/TML_2026-2027.csv` (42 games) for a season draft.
- Check phone layout at 390px width (no horizontal scroll) as well as desktop.
- `docs/REQUIREMENTS.md` §13 is the acceptance checklist; re-check the items your change touches.
- Never point a dev run at `data/draftboard.db` if it holds real data.

## Keep the documentation in sync (required)
Four documents in `docs/` describe the app and **must be updated in the same change** whenever behaviour, screens, settings, data formats or rules change:

| Document | Audience | Update when… |
|---|---|---|
| `docs/REQUIREMENTS.md` | AI/developer rebuilding the app | Any behaviour, rule, screen, API route, schema column, env var, data-import rule or scoring weight changes. Keep the acceptance checklist (§13) true. |
| `docs/USER_GUIDE.md` | The partners | Anything a user sees or does changes (screens, buttons, options, wording, phone layout, FAQ). |
| `docs/WALKTHROUGH.md` | The commissioner presenting the app | A screen or headline feature is added, removed or changes how it's demonstrated. |
| `docs/ARCHITECTURE.md` | Anyone wanting the big picture | Components, data storage/tables, dependencies, API route count (currently 44 under `/api`), live-update approach, hosting or configuration change. |

Also update `README.md` when setup, configuration (env vars) or deployment changes. Bump the "Last updated" date in each document you touch. Before finishing a change, re-read the relevant sections and confirm they still match the code. Pure refactors with no visible or behavioural change need no doc update.

## Layout
- `server.js` — API routes, auth, draft/clock/trade logic, SSE live updates (`broadcast()`)
- `src/db.js` — SQLite schema + additive migrations; `src/teams.js` — teams, colours; `src/schedule.js` — CSV parsing; `src/suggest.js` — preferences and suggested-pick scoring; `src/mail.js` — email (logs to console when `SMTP_URL` is unset)
- `public/` — `index.html`, `app.css`, `app.js` (hash-routed SPA)
- `tools/convert_ticket_tracker.py` — converts the partners' workbook into `history/` (needs `openpyxl`; the workbook itself is not in the repo, so don't regenerate `history/` without it)
- `schedules/` — bundled official schedules; `history/` — converted past drafts
- Env vars (`PORT`, `INVITE_CODE`, `DB_FILE`, `APP_URL`, `SMTP_URL`, `MAIL_FROM`, `LOGO_URL`) are listed in `README.md` and `REQUIREMENTS.md` §11.

## Rules and conventions
- Prices are for the **pair** of seats; single-seat picks are worth half.
- Preferences and suggestions are private: only ever return the requester's own (commissioners included).
- Enforce rules on the server (turn order, commissioner-only actions, time-out blocking); the browser checks are only for convenience.
- Wrap multi-row writes (picks, trades, imports) in a transaction, and call `broadcast()` after any change other screens should see.
- Schema changes are **additive** migrations in `src/db.js` (new tables/columns with defaults). Never drop or rewrite existing data.
- Keep it small: no front-end framework, no build step, no new dependencies without asking first.
- Phone layout rules live in the `@media (max-width: 700px)` block in `app.css`; keep the desktop layout unaffected.
- Never commit secrets (real invite code, SMTP credentials, `.env`) or database files.

## Git
- Commit messages: short imperative summary of the user-visible change (e.g. "Time outs for draft participants; backup commissioners"), with code and doc updates in the same commit.
