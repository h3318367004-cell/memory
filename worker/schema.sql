create table if not exists memories (
  id text primary key,
  external_id text unique,
  canonical_key text unique,
  layer text not null default 'note',
  kind text not null default 'note',
  title text,
  text text not null,
  summary text,
  source text not null default 'codex',
  tags_json text not null default '[]',
  importance real not null default 0.5,
  confidence real not null default 0.8,
  sensitivity text not null default 'low',
  emotion_score real,
  pinned integer not null default 0,
  locked integer not null default 0,
  status text not null default 'active',
  memory_date text,
  valid_from text,
  valid_to text,
  expires_at text,
  archived_at text,
  superseded_by text,
  metadata_json text not null default '{}',
  embedding_json text,
  created_at text not null,
  updated_at text not null,
  last_recalled_at text,
  recall_count integer not null default 0,
  last_dreamed_at text,
  dream_count integer not null default 0
);

create index if not exists memories_layer_status_idx on memories (layer, status, updated_at);
create index if not exists memories_status_updated_idx on memories (status, updated_at);
create index if not exists memories_pinned_heat_idx on memories (pinned, recall_count, importance);

create table if not exists memory_links (
  id text primary key,
  from_memory_id text not null,
  to_memory_id text not null,
  relation text not null default 'related',
  strength real not null default 0.5,
  note text,
  created_at text not null,
  unique (from_memory_id, to_memory_id, relation)
);

create index if not exists memory_links_from_idx on memory_links (from_memory_id, relation);
create index if not exists memory_links_to_idx on memory_links (to_memory_id, relation);

create table if not exists memory_state (
  key text primary key,
  value_json text not null,
  note text,
  updated_at text not null
);

create table if not exists dream_runs (
  id text primary key,
  kind text not null,
  source_ids_json text not null default '[]',
  summary_memory_id text,
  text text not null,
  created_at text not null
);

create table if not exists audit_logs (
  id text primary key,
  tool text not null,
  ok integer not null,
  duration_ms integer not null,
  ip_hash text,
  user_agent_hash text,
  created_at text not null
);

create index if not exists audit_logs_created_idx on audit_logs (created_at);
