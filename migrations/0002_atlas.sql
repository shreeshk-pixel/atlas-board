create table if not exists profiles (
  user_id text primary key references "user" ("id") on delete cascade,
  username text not null unique,
  display_name text not null,
  role text not null,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_one_admin on profiles (role) where role = 'admin';

create table if not exists invites (
  id text primary key,
  code text not null unique,
  created_by text not null references "user" ("id") on delete cascade,
  used_by text references "user" ("id") on delete set null,
  used_name text,
  used_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists classes (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  day text not null,
  time text not null,
  subject text not null,
  room text not null default '',
  position integer not null default 0
);
create index if not exists classes_user_idx on classes (user_id);

create table if not exists assignments (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  title text not null,
  subject text not null default '',
  due text not null,
  done boolean not null default false
);
create index if not exists assignments_user_idx on assignments (user_id);

create table if not exists courses (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  name text not null default '',
  credits integer not null default 4,
  grade text not null default 'A'
);
create index if not exists courses_user_idx on courses (user_id);

create table if not exists chats (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chats_user_idx on chats (user_id, created_at);

create table if not exists ai_prefs (
  user_id text primary key references "user" ("id") on delete cascade,
  endpoint text not null default 'https://openrouter.ai/api/v1',
  model text not null default 'openai/gpt-4o-mini',
  api_key text
);

create table if not exists shared_ai (
  id text primary key,
  endpoint text not null,
  model text not null,
  api_key text
);
