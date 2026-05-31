create or replace function public.codex_memory_public_row(m public.codex_memories)
returns jsonb
language sql
stable
as $$
  select to_jsonb(m) - 'embedding' - 'search_vector';
$$;

create or replace function public.codex_memory_kernel_search(
  query_text text default '',
  match_count integer default 8,
  filter_layers text[] default null,
  filter_kinds text[] default null,
  filter_tags text[] default null,
  include_archived boolean default false
)
returns table (
  memory jsonb,
  score double precision,
  lexical_score double precision
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
      (1 / (1 + greatest(0, extract(epoch from (now() - m.updated_at)) / 86400) / 30)) as recency_score,
      (ln(1 + m.recall_count) / 5) as heat_score
    from public.codex_memories m
    cross join params p
    where (include_archived or (m.archived_at is null and m.status = 'active'))
      and (filter_layers is null or cardinality(filter_layers) = 0 or m.layer = any(filter_layers))
      and (filter_kinds is null or cardinality(filter_kinds) = 0 or m.kind = any(filter_kinds))
      and (filter_tags is null or cardinality(filter_tags) = 0 or m.tags && filter_tags)
      and (p.q is null or m.search_vector @@ websearch_to_tsquery('simple', p.q))
  )
  select
    to_jsonb(ranked)
      - 'embedding'
      - 'search_vector'
      - 'lexical_score'
      - 'recency_score'
      - 'heat_score' as memory,
    (
      ranked.lexical_score * 0.35 +
      ranked.importance * 0.25 +
      ranked.confidence * 0.10 +
      ranked.recency_score * 0.10 +
      ranked.heat_score * 0.15 +
      case when ranked.pinned then 0.50 else 0 end +
      case when ranked.locked then 0.35 else 0 end
    ) as score,
    ranked.lexical_score
  from ranked, params
  order by score desc, ranked.updated_at desc
  limit (select max_count from params);
$$;

create or replace function public.codex_memory_kernel_wakeup(match_count integer default 24)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'state', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.key)
      from public.codex_memory_state s
    ), '[]'::jsonb),
    'core', coalesce((
      select jsonb_agg(public.codex_memory_public_row(m) order by m.locked desc, m.pinned desc, m.importance desc, m.updated_at desc)
      from (
        select *
        from public.codex_memories
        where status = 'active'
          and archived_at is null
          and layer in ('core', 'identity', 'relationship')
        order by locked desc, pinned desc, importance desc, updated_at desc
        limit least(greatest(match_count, 4), 12)
      ) m
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(public.codex_memory_public_row(m) order by m.pinned desc, m.importance desc, m.updated_at desc)
      from (
        select *
        from public.codex_memories
        where status = 'active' and archived_at is null and layer = 'project'
        order by pinned desc, importance desc, updated_at desc
        limit 8
      ) m
    ), '[]'::jsonb),
    'feel', coalesce((
      select jsonb_agg(public.codex_memory_public_row(m) order by abs(coalesce(m.emotion_score, 0)) desc, m.importance desc, m.updated_at desc)
      from (
        select *
        from public.codex_memories
        where status = 'active' and archived_at is null and layer = 'feel'
        order by abs(coalesce(emotion_score, 0)) desc, importance desc, updated_at desc
        limit 6
      ) m
    ), '[]'::jsonb),
    'hot', coalesce((
      select jsonb_agg(public.codex_memory_public_row(m) order by m.pinned desc, ln(1 + m.recall_count) desc, m.importance desc, m.updated_at desc)
      from (
        select *
        from public.codex_memories
        where status = 'active' and archived_at is null
        order by pinned desc, ln(1 + recall_count) desc, importance desc, updated_at desc
        limit least(greatest(match_count, 4), 10)
      ) m
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(public.codex_memory_public_row(m) order by coalesce(m.memory_date, m.created_at) desc, m.updated_at desc)
      from (
        select *
        from public.codex_memories
        where status = 'active' and archived_at is null
        order by coalesce(memory_date, created_at) desc, updated_at desc
        limit least(greatest(match_count, 4), 10)
      ) m
    ), '[]'::jsonb),
    'dream', coalesce((
      select jsonb_agg(public.codex_memory_public_row(m) order by m.created_at desc)
      from (
        select *
        from public.codex_memories
        where status = 'active' and archived_at is null and layer = 'dream'
        order by created_at desc
        limit 4
      ) m
    ), '[]'::jsonb)
  );
$$;
