-- DigitalClass schema.
--
-- Every collection is one table shaped the same way:
--   id          the application's own id (text, not a uuid)
--   data        the document as jsonb
--   created_at / updated_at
--
-- The frequently-filtered fields are exposed as STORED generated columns, so
-- they are indexable and readable in the Supabase table editor without the
-- application having to maintain a column-per-field mapping.
--
-- RLS is enabled on every table and no policies are defined: the API server
-- connects with the service-role key (which bypasses RLS), while the anon and
-- authenticated roles can read nothing. Do not add permissive policies unless
-- you intend to expose the data to browsers directly.

create extension if not exists pgcrypto;

-- Shared shape ---------------------------------------------------------------

create or replace function dc_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = coalesce(new.updated_at, now());
  return new;
end $$;

-- users ----------------------------------------------------------------------
create table if not exists public.users (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  email       text generated always as (lower(data->>'email')) stored,
  role        text generated always as (data->>'role') stored,
  status      text generated always as (data->>'status') stored,
  xp          integer generated always as (nullif(data->>'xp','')::integer) stored
);
create unique index if not exists users_email_key on public.users (email);
create index if not exists users_role_idx on public.users (role);

-- courses --------------------------------------------------------------------
create table if not exists public.courses (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  title       text generated always as (data->>'title') stored,
  code        text generated always as (upper(data->>'code')) stored,
  teacher_id  text generated always as (data->>'teacherId') stored,
  topic       text generated always as (data->>'topic') stored,
  status      text generated always as (data->>'status') stored
);
create unique index if not exists courses_code_key on public.courses (code) where code is not null;
create index if not exists courses_teacher_idx on public.courses (teacher_id);

-- lessons --------------------------------------------------------------------
create table if not exists public.lessons (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  course_id   text generated always as (data->>'courseId') stored,
  "order"     integer generated always as (nullif(data->>'order','')::integer) stored
);
create index if not exists lessons_course_idx on public.lessons (course_id);

-- enrollments ----------------------------------------------------------------
create table if not exists public.enrollments (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     text generated always as (data->>'userId') stored,
  course_id   text generated always as (data->>'courseId') stored,
  status      text generated always as (data->>'status') stored
);
create index if not exists enrollments_user_idx on public.enrollments (user_id);
create index if not exists enrollments_course_idx on public.enrollments (course_id);

-- quizzes --------------------------------------------------------------------
create table if not exists public.quizzes (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  course_id   text generated always as (data->>'courseId') stored,
  title       text generated always as (data->>'title') stored,
  kind        text generated always as (data->>'kind') stored,
  published   boolean generated always as ((data->>'published')::boolean) stored
);
create index if not exists quizzes_course_idx on public.quizzes (course_id);

-- questions ------------------------------------------------------------------
create table if not exists public.questions (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  quiz_id     text generated always as (data->>'quizId') stored,
  course_id   text generated always as (data->>'courseId') stored,
  type        text generated always as (data->>'type') stored
);
create index if not exists questions_quiz_idx on public.questions (quiz_id);
create index if not exists questions_type_idx on public.questions (type);

-- attempts -------------------------------------------------------------------
create table if not exists public.attempts (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     text generated always as (data->>'userId') stored,
  quiz_id     text generated always as (data->>'quizId') stored,
  course_id   text generated always as (data->>'courseId') stored,
  status      text generated always as (data->>'status') stored,
  percent     numeric generated always as (nullif(data#>>'{result,percent}','')::numeric) stored
);
create index if not exists attempts_user_idx on public.attempts (user_id);
create index if not exists attempts_quiz_idx on public.attempts (quiz_id);
create index if not exists attempts_status_idx on public.attempts (status);

-- assignments ----------------------------------------------------------------
create table if not exists public.assignments (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  course_id   text generated always as (data->>'courseId') stored
);
create index if not exists assignments_course_idx on public.assignments (course_id);

-- submissions ----------------------------------------------------------------
create table if not exists public.submissions (
  id            text primary key,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  assignment_id text generated always as (data->>'assignmentId') stored,
  user_id       text generated always as (data->>'userId') stored,
  course_id     text generated always as (data->>'courseId') stored,
  status        text generated always as (data->>'status') stored
);
create index if not exists submissions_assignment_idx on public.submissions (assignment_id);
create index if not exists submissions_user_idx on public.submissions (user_id);

-- badges (reserved for teacher-defined badges) --------------------------------
create table if not exists public.badges (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- awards ---------------------------------------------------------------------
create table if not exists public.awards (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     text generated always as (data->>'userId') stored,
  badge_id    text generated always as (data->>'badgeId') stored
);
create index if not exists awards_user_idx on public.awards (user_id);

-- parties --------------------------------------------------------------------
create table if not exists public.parties (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  pin         text generated always as (data->>'pin') stored,
  host_id     text generated always as (data->>'hostId') stored,
  course_id   text generated always as (data->>'courseId') stored
);
create index if not exists parties_host_idx on public.parties (host_id);

-- threads --------------------------------------------------------------------
create table if not exists public.threads (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  course_id   text generated always as (data->>'courseId') stored,
  author_id   text generated always as (data->>'authorId') stored,
  solved      boolean generated always as ((data->>'solved')::boolean) stored
);
create index if not exists threads_course_idx on public.threads (course_id);

-- posts ----------------------------------------------------------------------
create table if not exists public.posts (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  thread_id   text generated always as (data->>'threadId') stored,
  author_id   text generated always as (data->>'authorId') stored
);
create index if not exists posts_thread_idx on public.posts (thread_id);
create index if not exists posts_author_idx on public.posts (author_id);

-- messages -------------------------------------------------------------------
create table if not exists public.messages (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  room_id     text generated always as (data->>'roomId') stored,
  kind        text generated always as (data->>'kind') stored,
  author_id   text generated always as (data->>'authorId') stored,
  to_id       text generated always as (data->>'toId') stored
);
create index if not exists messages_room_idx on public.messages (room_id);

-- notifications --------------------------------------------------------------
create table if not exists public.notifications (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     text generated always as (data->>'userId') stored,
  kind        text generated always as (data->>'kind') stored,
  is_read     boolean generated always as ((data->>'read')::boolean) stored
);
create index if not exists notifications_user_idx on public.notifications (user_id, is_read);

-- announcements --------------------------------------------------------------
create table if not exists public.announcements (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  course_id   text generated always as (data->>'courseId') stored,
  author_id   text generated always as (data->>'authorId') stored
);

-- certificates ---------------------------------------------------------------
create table if not exists public.certificates (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     text generated always as (data->>'userId') stored,
  course_id   text generated always as (data->>'courseId') stored,
  serial      text generated always as (data->>'serial') stored
);
create unique index if not exists certificates_serial_key on public.certificates (serial) where serial is not null;

-- events (XP ledger) ---------------------------------------------------------
create table if not exists public.events (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     text generated always as (data->>'userId') stored,
  kind        text generated always as (data->>'kind') stored
);
create index if not exists events_user_idx on public.events (user_id);

-- links (parent <-> student) -------------------------------------------------
create table if not exists public.links (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  parent_id   text generated always as (data->>'parentId') stored,
  student_id  text generated always as (data->>'studentId') stored
);
create index if not exists links_parent_idx on public.links (parent_id);

-- resources ------------------------------------------------------------------
create table if not exists public.resources (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  course_id   text generated always as (data->>'courseId') stored
);

-- flashcard_states (spaced repetition) ---------------------------------------
create table if not exists public.flashcard_states (
  id           text primary key,
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  user_id      text generated always as (data->>'userId') stored,
  question_id  text generated always as (data->>'questionId') stored,
  due          timestamptz generated always as (nullif(data->>'due','')::timestamptz) stored
);
create index if not exists flashcard_states_due_idx on public.flashcard_states (user_id, due);

-- Lock everything down: only the service role (which bypasses RLS) gets in.
do $$
declare t text;
begin
  foreach t in array array[
    'users','courses','lessons','enrollments','quizzes','questions','attempts',
    'assignments','submissions','badges','awards','parties','threads','posts',
    'messages','notifications','announcements','certificates','events','links',
    'resources','flashcard_states'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
