create table if not exists recordings (
  recording_id text primary key,
  chat_id bigint not null,
  label text,
  status text not null default 'pending', -- pending | recording | stop_requested | done
  created_at timestamptz not null default now()
);

-- جلسة المحادثة (عشان يتذكر إنه ينتظر منك رابط بعد ما تضغط "بدء تسجيل")
create table if not exists bot_sessions (
  chat_id bigint primary key,
  state text not null,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
