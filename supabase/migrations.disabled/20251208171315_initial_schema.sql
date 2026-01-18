-- conversations table
create table if not exists conversations (
  id text primary key,
  title text not null default 'New Chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- response_sessions table
create table if not exists response_sessions (
  id text primary key,
  conversation_id text references conversations(id) on delete cascade,
  user_prompt text not null,
  intro_message text,
  outro_message text,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'failed')),
  final_code text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- response_session_steps table
create table if not exists response_session_steps (
  id text primary key default gen_random_uuid()::text,
  response_session_id text not null references response_sessions(id) on delete cascade,
  step_number integer not null,
  description text not null,
  status text not null default 'active' check (status in ('active', 'completed', 'failed')),
  output text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(response_session_id, step_number)
);

-- messages table
create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  response_session_id text references response_sessions(id) on delete set null,
  role text not null check (role in ('user', 'assistant')),
  message_type text check (message_type in ('intro', 'tasks', 'summary', 'text', 'deployed')),
  content text,
  version text,
  timestamp bigint not null,
  created_at timestamptz not null default now()
);

-- api_logs table
create table if not exists api_logs (
  id text primary key default gen_random_uuid()::text,
  endpoint text not null,
  method text not null,
  request_body jsonb,
  response_status integer,
  response_body jsonb,
  error text,
  duration_ms integer,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

-- indexes for performance
create index if not exists idx_response_sessions_conversation_id on response_sessions(conversation_id);
create index if not exists idx_response_sessions_status on response_sessions(status);
create index if not exists idx_response_sessions_created_at on response_sessions(created_at desc);
create index if not exists idx_response_session_steps_session_id on response_session_steps(response_session_id);
create index if not exists idx_messages_conversation_id on messages(conversation_id);
create index if not exists idx_messages_timestamp on messages(timestamp desc);
create index if not exists idx_api_logs_created_at on api_logs(created_at desc);
create index if not exists idx_api_logs_endpoint on api_logs(endpoint);

-- function to update updated_at timestamp
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- triggers for updated_at
create trigger update_conversations_updated_at before update on conversations
  for each row execute function update_updated_at_column();

create trigger update_response_sessions_updated_at before update on response_sessions
  for each row execute function update_updated_at_column();

create trigger update_response_session_steps_updated_at before update on response_session_steps
  for each row execute function update_updated_at_column();

