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
(ES modules, no bundler) on the client. Data is stored as JSON files in `/data`
via a small embedded document store (`server/lib/db.js`) — no database server to
install. Swapping in Postgres/Mongo later only touches that one file.

## Getting started

```bash
npm install
npm run seed     # creates data/*.json with a demo school
npm start         # http://localhost:3000
```

`npm run dev` runs with `--watch` for auto-restart. `npm run reset` wipes and
reseeds. Copy `.env.example` to `.env` and set `JWT_SECRET` before deploying.

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
server/
  index.js         Express app, static hosting, error handling
  realtime.js       Socket.IO: parties, live A/V signalling, course chat
  seed.js            Demo data generator
  lib/
    db.js            Embedded JSON document store
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
