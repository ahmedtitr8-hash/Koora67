create table if not exists recordings (
  recording_id text primary key,
  chat_id bigint not null,
  label text,
  status text not null default 'pending', -- pending | recording | stop_requested | done
  created_at timestamptz not null default now()
);

-- صف واحد بس (id='main') يمثل حالة "الاستعداد" — هل فيه مهمة GitHub جاهزة تنتظر
-- تكليف بتسجيل جديد بدون ما نحتاج نفتح مهمة جديدة (يوفر وقت الانتظار المعتاد).
create table if not exists standby (
  id text primary key default 'main',
  status text not null default 'idle', -- idle | pending | ready | assigned
  source_url text,
  recording_id text,
  label text,
  chat_id bigint,
  updated_at timestamptz not null default now()
);
insert into standby (id, status) values ('main', 'idle') on conflict (id) do nothing;

-- جلسة المحادثة (عشان يتذكر إنه ينتظر منك رابط بعد ما تضغط "بدء تسجيل")
create table if not exists bot_sessions (
  chat_id bigint primary key,
  state text not null,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
