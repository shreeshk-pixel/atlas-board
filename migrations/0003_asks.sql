create table if not exists asks (
  user_id text not null references "user" ("id") on delete cascade,
  day text not null,
  ref_key text not null,
  label text not null,
  tab text not null,
  opened boolean not null default false,
  primary key (user_id, day)
);

create index if not exists asks_user_open_idx on asks (user_id, opened, day);
