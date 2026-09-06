# DigitalClass

An online computer-science education platform for **teachers, students and parents**,
trilingual in **French / English / Arabic** (with full RTL support), built on
plain Node.js — no build step, no framework, no external database.

## Highlights

- **24 quiz question types**, all auto-graded server-side: single/multiple choice,
  true/false, short answer, numeric, fill-in-the-blanks, matching, ordering,
  categorize, code output, write code (sandboxed JS with hidden tests), fix code,
  find the bug, SQL query, terminal command, base conversion, truth table,
  clickable hotspot, flashcard (spaced repetition) and essay (teacher-graded).
- **Visual questions**: pick the right image, **click a spot on a diagram**,
  **label a diagram** point by point, and put images in order. On top of that any
  question of any type can carry an illustration — image, diagram, video or audio.
  Teachers author them by clicking directly on the picture; see **Image questions**.
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
| **MySQL / MariaDB** | whenever `DB_USER` + `DB_NAME` (or `DATABASE_URL`) are in the environment | source of truth, nothing touches disk, survives redeploys |
| **Supabase (Postgres)** | whenever `SUPABASE_URL` + a service key are set and MySQL is not | same |
| **JSON files** | the zero-configuration fallback | `data/*.json`, fine for local development |

Nothing else in the codebase changes between them — routes, gamification and
the realtime layer are unaware of which backend is live. `GET /api/health`
reports the active backend, row counts and any pending/failed writes.

### Pointing it at MySQL (the shared-hosting database)

Set these where your host keeps configuration — **no `.env` file needed**; on
Hostinger they go under the Node.js app's environment variables:

```
DB_HOST=localhost          # the app and the database share a server
DB_PORT=3306
DB_USER=<db user>
DB_PASSWORD=<db password>
DB_NAME=<db name>
```

`MYSQL_HOST` / `MYSQL_USER` / … are accepted too, as is a single
`DATABASE_URL=mysql://user:pass@host:3306/dbname`.

Restart and that is it: **the app creates its own schema on first boot** — one
table per collection, `CREATE TABLE IF NOT EXISTS`, so deploying to an empty
database just works and there is no migration step to forget. Each table holds
the document in a `data JSON` column alongside `id`, `created_at` and
`updated_at`. Where the server supports it, the frequently-filtered fields
(email, role, course_id, …) are added as **generated columns** with indexes, so
the data is browsable in phpMyAdmin without the app maintaining a
field-by-field mapping; a server that rejects them simply gets the base table.

Verified against MariaDB 11.8 on Hostinger shared hosting: 22 tables created
automatically, generated columns and indexes applied, Arabic content stored and
queried correctly through `utf8mb4`.

### Uploads

Uploaded files default to `public/uploads`, which is inside the deployed
directory and therefore erased by each release. Set `UPLOAD_DIR` to a path
outside the deploy root to keep them:

```
UPLOAD_DIR=/home/<account>/persistent/uploads
```

The server warns on startup when running in production without it.

### Pointing it at Supabase instead

Run `sql/001_initial_schema.sql` in the SQL editor, then set `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. The server connects with the service-role key, so
RLS is bypassed server-side; the schema enables RLS everywhere with *no*
policies, which means the anon key can read nothing. Keep it that way unless
you deliberately want browsers talking to the database directly.

`npm run migrate` copies an existing `data/*.json` store into Supabase
(`npm run migrate:dry` previews, `--wipe` replaces instead of merging).

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
    mysql.js         MySQL/MariaDB backend: self-creating schema, write queue
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

## Image questions

Four types are built around a picture, and all of them are authored by clicking
on the image itself rather than by typing coordinates:

| Type | The student… | The teacher… |
|---|---|---|
| `image_choice` | picks the right picture from a grid | uploads images, marks the correct one(s) |
| `image_hotspot` | clicks the right spot on a diagram | clicks to drop zones, marks which is correct |
| `image_label` | gives each numbered point its label | clicks to drop points, picks each one's label |
| `image_order` | puts pictures into the right order | uploads them already in order |

Any question, of any type, can also carry a `media` illustration shown above the
prompt (`{ url, kind, alt }`, or just a URL — `kind` is inferred from the
extension when omitted).

Two details worth knowing:

- **Answers never reach the browser.** Hotspot zones and label answers are
  stripped by `sanitize()`, so a student cannot read the target out of the
  markup. A hotspot click is submitted as `{ x, y }` percentages and the server
  decides which zone it landed in.
- **Coordinates are percentages of the image box**, which is why the CSS gives
  the image an explicit width and lets it set its own height. Capping the height
  instead would letterbox it and silently shift every click.

## Notes on the code sandbox

`code_write` / `code_fix` questions run student JavaScript in a `vm` context
with a 1.5s timeout and no access to Node globals. It's adequate for a
classroom teaching tool; it is **not** a hardened multi-tenant sandbox — don't
expose it to the open internet without putting it behind a worker/container
isolate if abuse is a concern.

## Extending

- New question type: add it to `server/quiz/types.js`, a `case` in
  `server/quiz/grader.js`, a `case` in both `render()`/`bind()` in
  `public/js/questions.js`, and the authoring fields in `questionEditor()`
  (`public/js/views/quiz.js`). If it hides an answer key, extend `sanitize()` in
  `server/routes/quizzes.js` too.
- New language: add `public/locales/<code>.json` (copy `en.json` as a
  template) and add it to `LANGS` in `public/js/core.js`.
