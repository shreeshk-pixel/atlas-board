create table if not exists focus_sessions (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  preset text not null,
  focus_min integer not null,
  break_min integer not null,
  course_id text,
  assignment_id text,
  objective text not null default '',
  label text not null default '',
  subject_key text not null default '',
  phase text not null,
  status text not null,
  phase_ends_at timestamptz,
  remaining_ms integer,
  focus_ms integer not null default 0,
  auto_break boolean not null default true,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create unique index if not exists focus_one_active
  on focus_sessions (user_id)
  where status in ('running', 'paused');

create index if not exists focus_user_idx on focus_sessions (user_id, started_at desc);
