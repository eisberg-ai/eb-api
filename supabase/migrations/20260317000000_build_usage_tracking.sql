-- Add usage tracking columns to builds table
-- Enables live token-based billing and leaderboard functionality

-- Add usage_summary jsonb for accumulated LLM usage
alter table builds
  add column if not exists usage_summary jsonb default '{}';

-- Add langfuse_trace_id for linking to Langfuse traces
alter table builds
  add column if not exists langfuse_trace_id text;

-- Add scores jsonb for admin rating (design, functionality, polish)
alter table builds
  add column if not exists scores jsonb default '{}';

-- Index for efficient querying in leaderboard
create index if not exists idx_builds_agent_version on builds (agent_version);
create index if not exists idx_builds_model on builds (model);
create index if not exists idx_builds_status_created on builds (status, created_at desc);

-- Comment on columns for documentation
comment on column builds.usage_summary is 'Aggregated LLM usage: {total_input_tokens, total_output_tokens, total_calls, total_charged_usd, tokens_by_model}';
comment on column builds.langfuse_trace_id is 'Langfuse trace ID for debugging and observability';
comment on column builds.scores is 'Admin ratings: {design: 1-5, functionality: 1-5, polish: 1-5}';
