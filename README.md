# DigitalClass

An online computer-science education platform for **teachers, students and parents**,
trilingual in **French / English / Arabic** (with full RTL support), built on
plain Node.js — no build step, no framework, no external database.

## Highlights

- **20 quiz question types**, all auto-graded server-side: single/multiple choice,
  true/false, short answer, numeric, fill-in-the-blanks, matching, ordering,
  categorize, code output, write code (sandboxed JS with hidden tests), fix code,
  find the bug, SQL query, terminal command, base conversion, truth table,
  clickable hotspot, flashcard (spaced repetition) and essay (teacher-graded).
- **Live quiz "parties"** — Kahoot-style multiplayer over Socket.IO: a 6-character
  PIN, synchronized question rounds, speed + streak scoring, team/survival/marathon
  modes, reactions, and a podium at the end.
- **Live classroom** — microphone, camera and screen sharing over WebRTC, inside
  any course *and* any quiz. Everyone can speak and share; the teacher decides
  **who is on the board** (up to four spotlight tiles), can mute the room, raise
  hands are visible, and a screen share takes the board automatically. Media is a
  peer-to-peer mesh, so the server only relays signalling.
- **Courses**: 6-character **join codes** (students enrol by typing the code),
  lessons (Markdown), progress tracking, assignments with file submissions,
  course chat, roster, certificates on completion.
- **Gamification**: XP, levels, daily streaks, 19 badges, a global/per-course
  leaderboard.
- **Community**: a Stack-Overflow-style forum (voting, accepted answers), direct
  messages, notifications, announcements.
- **Teacher tools**: quiz builder for all 20 types, gradebook matrix, per-question
  item analysis (difficulty, common wrong answers), an essay-grading queue.
- **Parent accounts**: link to a child via a student code, read-only progress
  reports — no access to anything else.
- **Admin**: a plain three-tab console (overview / people / content). Admins run
  the platform and are *not* learners — the server refuses to open a quiz attempt
  for them, and they never appear in leaderboards.
- **Mobile-first**: a bottom tab bar, an off-canvas drawer, thumb-sized controls
  and 16px inputs (no iOS zoom-on-focus). Every page is verified free of
  horizontal overflow at 390px, in both LTR and RTL.
- **i18n**: every UI string and every piece of seeded content (courses, lessons,
  quizzes) ships in FR/EN/AR; Arabic renders full RTL (code blocks, join codes and
  PINs stay LTR).

## Stack

Node.js + Express 5 + Socket.IO on the server; a dependency-free vanilla-JS SPA
(ES modules, no bundler) on the client.

## Storage

`server/lib/db.js` is an in-memory document store with a pluggable durable
backend. Reads are synchronous and served from memory; every write updates
memory and is forwarded to the backend.

| Backend | When it is used | Durability |
|---|---|---|
| **Supabase (Postgres)** | automatically, whenever `SUPABASE_URL` + a service key are in the environment | source of truth, nothing touches disk, survives redeploys |
| **JSON files** | the zero-configuration fallback | `data/*.json`, fine for local development |

Nothing else in the codebase changes between the two — routes, gamification and
the realtime layer are unaware of which backend is live. `GET /api/health`
reports the active backend, row counts and any pending/failed writes.

### Pointing it at Supabase

1. Run `sql/001_initial_schema.sql` in the Supabase SQL editor (22 tables, one
   per collection, plus indexes and RLS).
2. Set these where your host keeps configuration — **no `.env` file needed**;
   on Hostinger add them under the Node.js app's environment variables:

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   ```

   `SUPABASE_PROJECT_URL` / `SUPABASE_SERVICE_KEY` / `SUPABASE_KEY` are also
   accepted, so whatever name your host's integration injects will be picked up.
3. Restart. The log line and `/api/health` will say `store: supabase`.
4. Optional — copy existing local data up once: `npm run migrate`
   (`npm run migrate:dry` previews it, `--wipe` replaces instead of merging).

Each table stores the document in a `data jsonb` column, with the
frequently-filtered fields (email, role, course_id, …) exposed as **generated
columns** so they are indexed and readable in the Supabase table editor without
the application maintaining a field-by-field mapping.

**Security**: the server connects with the service-role key, so RLS is bypassed
server-side. The schema enables RLS on every table and defines *no* policies,
which means the anon/publishable key can read nothing. Keep it that way unless
you deliberately want browsers talking to the database directly.

**Scope**: because the whole dataset is held in memory, this design assumes a
single app instance — the same assumption the Socket.IO party and live-class
rooms already make. Running multiple instances would need the routes converted
to async queries.

## Getting started

```bash
npm install
npm run seed     # writes a demo school into whichever store is configured
npm start         # http://localhost:3000
```

With no configuration this runs entirely on local JSON files. Set the Supabase
variables (see **Storage**) and the same commands target Postgres instead.

`npm run dev` runs with `--watch` for auto-restart. `npm run reset` wipes and
reseeds. Set `JWT_SECRET` in your host's environment before deploying.

### Demo accounts (password: `password123`)

| Role    | Email                       |
|---------|------------------------------|
| Admin   | admin@digitalclass.dev       |
| Teacher | nadia@digitalclass.dev (FR)  |
| Teacher | omar@digitalclass.dev (AR)   |
| Teacher | sarah@digitalclass.dev (EN)  |
| Student | yasmine@digitalclass.dev     |
| Parent  | parent@digitalclass.dev      |

## Project layout

```
sql/
  001_initial_schema.sql   Supabase/Postgres schema (run once)

server/
  index.js         Express app, static hosting, error handling
  realtime.js       Socket.IO: parties, live A/V signalling, course chat
  seed.js            Demo data generator
  migrate-to-supabase.js   One-shot copy of data/*.json into Postgres
  lib/
    db.js            In-memory store + pluggable durable backend
    supabase.js      Supabase backend: hydrate, ordered write queue, retry
    gamification.js  XP, levels, streaks, badges
    party.js         Live party room state machine
    live.js          Live A/V rooms: membership, spotlight, ICE config
  quiz/
    types.js         The 20 question-type catalogue
    grader.js         Auto-grading for every type + spaced repetition
    sandbox.js        vm-based JS runner for code_write/code_fix
  middleware/auth.js   JWT auth, roles, ownership checks
  routes/               auth, courses, quizzes, attempts, social, admin

public/
  index.html
  css/style.css      Design tokens, RTL-aware via logical CSS properties
  locales/{fr,en,ar}.json
  js/
    core.js           i18n, API client, router, small DOM helpers
    questions.js       Render + read-back for all 20 question types
    live.js            WebRTC mesh client + live classroom UI
    app.js             Shell, navigation, route table
    views/*.js          Page views
```

## Live classroom requirements

Browsers only grant camera/microphone access on **HTTPS** (or `localhost`), so the
live classroom needs a TLS certificate in production. Media flows peer-to-peer;
Google's public STUN servers are used by default. On restrictive school networks
peers may fail to connect without a TURN relay — set `TURN_URL`, `TURN_USER` and
`TURN_PASS` in `.env` and it is offered to clients automatically. Rooms are a full
mesh, capped at 16 participants (`MAX_PARTICIPANTS` in `server/lib/live.js`);
beyond that you would want an SFU.

## Notes on the code sandbox

`code_write` / `code_fix` questions run student JavaScript in a `vm` context
with a 1.5s timeout and no access to Node globals. It's adequate for a
classroom teaching tool; it is **not** a hardened multi-tenant sandbox — don't
expose it to the open internet without putting it behind a worker/container
isolate if abuse is a concern.

## Extending

- New question type: add it to `server/quiz/types.js`, a `case` in
  `server/quiz/grader.js`, and a `case` in both `render()`/`bind()` in
  `public/js/questions.js`.
- New language: add `public/locales/<code>.json` (copy `en.json` as a
  template) and add it to `LANGS` in `public/js/core.js`.
