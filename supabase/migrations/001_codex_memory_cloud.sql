create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.codex_memories (
  id uuid primary key default extensions.gen_random_uuid(),
  external_id text unique,
  kind text not null default 'note'
    check (kind in ('fact', 'event', 'feel', 'preference', 'boundary', 'project', 'note', 'summary')),
  text text not null,
  summary text,
  source text not null default 'codex',
  tags text[] not null default '{}',
  importance double precision not null default 0.5 check (importance >= 0 and importance <= 1),
  confidence double precision not null default 0.8 check (confidence >= 0 and confidence <= 1),
  sensitivity text not null default 'low' check (sensitivity in ('low', 'medium', 'high')),
  emotion_score double precision check (emotion_score is null or (emotion_score >= -1 and emotion_score <= 1)),
  pinned boolean not null default false,
  archived_at timestamptz,
  superseded_by uuid references public.codex_memories(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536),
  search_vector tsvector not null default ''::tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_recalled_at timestamptz,
  recall_count integer not null default 0
);

create index if not exists codex_memories_tags_idx on public.codex_memories using gin (tags);
create index if not exists codex_memories_search_idx on public.codex_memories using gin (search_vector);
create index if not exists codex_memories_created_idx on public.codex_memories (created_at desc);
create index if not exists codex_memories_heat_idx on public.codex_memories (pinned desc, importance desc, recall_count desc);
create index if not exists codex_memories_embedding_idx
  on public.codex_memories using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create or replace function public.set_codex_memory_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_codex_memory_updated_at on public.codex_memories;
create trigger set_codex_memory_updated_at
before update on public.codex_memories
for each row execute function public.set_codex_memory_updated_at();

create or replace function public.set_codex_memory_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector =
    setweight(to_tsvector('simple', coalesce(new.summary, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.text, '')), 'B') ||
    setweight(to_tsvector('simple', array_to_string(new.tags, ' ')), 'C') ||
    setweight(to_tsvector('simple', coalesce(new.source, '')), 'D');
  return new;
end;
$$;

drop trigger if exists set_codex_memory_search_vector on public.codex_memories;
create trigger set_codex_memory_search_vector
before insert or update of text, summary, tags, source on public.codex_memories
for each row execute function public.set_codex_memory_search_vector();

create or replace function public.codex_memory_touch(memory_id uuid)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.codex_memories
  set recall_count = recall_count + 1,
      last_recalled_at = now()
  where id = memory_id
    and archived_at is null;
$$;

create or replace function public.codex_memory_search(
  query_text text,
  query_embedding extensions.vector(1536) default null,
  match_count integer default 8,
  filter_kinds text[] default null,
  filter_tags text[] default null,
  include_archived boolean default false
)
returns table (
  id uuid,
  external_id text,
  kind text,
  text text,
  summary text,
  source text,
  tags text[],
  importance double precision,
  confidence double precision,
  sensitivity text,
  emotion_score double precision,
  pinned boolean,
  archived_at timestamptz,
  superseded_by uuid,
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  last_recalled_at timestamptz,
  recall_count integer,
  score double precision,
  lexical_score double precision,
  semantic_score double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with params as (
    select
      nullif(trim(coalesce(query_text, '')), '') as q,
      greatest(1, least(coalesce(match_count, 8), 50)) as max_count
  ),
  ranked as (
    select
      m.*,
      case
        when p.q is null then 0
        else ts_rank_cd(m.search_vector, websearch_to_tsquery('simple', p.q))
      end as lexical_score,
      case
        when query_embedding is null or m.embedding is null then 0
        else greatest(0, 1 - (m.embedding <=> query_embedding))
      end as semantic_score,
      (1 / (1 + greatest(0, extract(epoch from (now() - m.updated_at)) / 86400) / 30)) as recency_score,
      (ln(1 + m.recall_count) / 5) as heat_score
    from public.codex_memories m
    cross join params p
    where (include_archived or m.archived_at is null)
      and (filter_kinds is null or cardinality(filter_kinds) = 0 or m.kind = any(filter_kinds))
      and (filter_tags is null or cardinality(filter_tags) = 0 or m.tags && filter_tags)
      and (
        p.q is null
        or m.search_vector @@ websearch_to_tsquery('simple', p.q)
        or (query_embedding is not null and m.embedding is not null)
      )
  )
  select
    ranked.id,
    ranked.external_id,
    ranked.kind,
    ranked.text,
    ranked.summary,
    ranked.source,
    ranked.tags,
    ranked.importance,
    ranked.confidence,
    ranked.sensitivity,
    ranked.emotion_score,
    ranked.pinned,
    ranked.archived_at,
    ranked.superseded_by,
    ranked.metadata,
    ranked.created_at,
    ranked.updated_at,
    ranked.last_recalled_at,
    ranked.recall_count,
    (
      ranked.lexical_score * 0.35 +
      ranked.semantic_score * 0.45 +
      ranked.importance * 0.25 +
      ranked.confidence * 0.10 +
      ranked.recency_score * 0.10 +
      ranked.heat_score * 0.15 +
      case when ranked.pinned then 0.50 else 0 end
    ) as score,
    ranked.lexical_score,
    ranked.semantic_score
  from ranked, params
  order by score desc, ranked.updated_at desc
  limit (select max_count from params);
$$;

create or replace function public.codex_memory_wakeup(match_count integer default 12)
returns table (
  reason text,
  id uuid,
  external_id text,
  kind text,
  text text,
  summary text,
  source text,
  tags text[],
  importance double precision,
  confidence double precision,
  sensitivity text,
  emotion_score double precision,
  pinned boolean,
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  last_recalled_at timestamptz,
  recall_count integer
)
language sql
stable
set search_path = public
as $$
  with recent as (
    select m.*
    from public.codex_memories m
    where m.archived_at is null
    order by m.updated_at desc
    limit 12
  ),
  candidates as (
    select 'pinned'::text as reason, 100 as priority, m.*
    from public.codex_memories m
    where m.archived_at is null and m.pinned
    union all
    select 'important'::text as reason, 80 as priority, m.*
    from public.codex_memories m
    where m.archived_at is null and m.importance >= 0.85
    union all
    select 'felt'::text as reason, 70 as priority, m.*
    from public.codex_memories m
    where m.archived_at is null and coalesce(abs(m.emotion_score), 0) >= 0.7
    union all
    select 'recent'::text as reason, 50 as priority, m.*
    from recent m
  ),
  deduped as (
    select *,
      row_number() over (partition by id order by priority desc, updated_at desc) as rn
    from candidates
  )
  select
    deduped.reason,
    deduped.id,
    deduped.external_id,
    deduped.kind,
    deduped.text,
    deduped.summary,
    deduped.source,
    deduped.tags,
    deduped.importance,
    deduped.confidence,
    deduped.sensitivity,
    deduped.emotion_score,
    deduped.pinned,
    deduped.metadata,
    deduped.created_at,
    deduped.updated_at,
    deduped.last_recalled_at,
    deduped.recall_count
  from deduped
  where rn = 1
  order by priority desc, updated_at desc
  limit greatest(1, least(coalesce(match_count, 12), 50));
$$;

alter table public.codex_memories enable row level security;
