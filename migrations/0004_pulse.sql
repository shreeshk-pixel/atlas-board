create table if not exists pulse_events (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  kind text not null,
  ref_id text not null,
  label text not null,
  subject text not null default '',
  at timestamptz not null default now(),
  unique (user_id, kind, ref_id)
);

create index if not exists pulse_events_user_idx on pulse_events (user_id, at);

create table if not exists pulse_prefs (
  user_id text primary key references "user" ("id") on delete cascade,
  enabled boolean not null default true
);
