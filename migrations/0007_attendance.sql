create table if not exists attendance (
  user_id text not null references "user" ("id") on delete cascade,
  class_id text not null,
  day text not null,
  status text not null,
  primary key (user_id, class_id, day)
);
create index if not exists attendance_user_idx on attendance (user_id, day);
