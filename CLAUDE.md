# Leafs Ticket Draft — notes for coding sessions

Private draft app for splitting Toronto Maple Leafs season tickets among partners. Node 22 + Express 5 + built-in `node:sqlite`; vanilla-JS single-page front end in `public/` (no build step). Run with `npm install && npm start` (http://localhost:3000).

## Keep the documentation in sync (required)
Three documents in `docs/` describe the app and **must be updated in the same change** whenever behaviour, screens, settings, data formats or rules change:

| Document | Audience | Update when… |
|---|---|---|
| `docs/REQUIREMENTS.md` | AI/developer rebuilding the app | Any behaviour, rule, screen, API route, schema column, env var, data-import rule or scoring weight changes. Keep the acceptance checklist (§13) true. |
| `docs/USER_GUIDE.md` | The partners | Anything a user sees or does changes (screens, buttons, options, wording, phone layout, FAQ). |
| `docs/WALKTHROUGH.md` | The commissioner presenting the app | A screen or headline feature is added, removed or changes how it's demonstrated. |

Also update `README.md` when setup, configuration or deployment changes. Bump the "Last updated" date in each document you touch. Before finishing a change, re-read the relevant sections and confirm they still match the code.

## Layout
- `server.js` — API routes, draft/clock/trade logic, SSE live updates
- `src/db.js` — SQLite schema + additive migrations; `src/teams.js` — teams, colours; `src/schedule.js` — CSV parsing; `src/suggest.js` — preferences and suggested-pick scoring; `src/mail.js` — email
- `public/` — `index.html`, `app.css`, `app.js` (hash-routed SPA)
- `tools/convert_ticket_tracker.py` — converts the partners' workbook into `history/`
- `schedules/` — bundled official schedules; `history/` — converted past drafts

## Conventions
- Prices are for the **pair** of seats; single-seat picks are worth half.
- Preferences and suggestions are private: only ever return the requester's own.
- Phone layout rules live in the `@media (max-width: 700px)` block in `app.css`; keep the desktop layout unaffected.
