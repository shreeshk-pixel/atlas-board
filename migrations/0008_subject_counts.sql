create table if not exists subject_counts (
  user_id text not null references "user" ("id") on delete cascade,
  subject text not null,
  attended integer not null default 0,
  held integer not null default 0,
  primary key (user_id, subject)
);
