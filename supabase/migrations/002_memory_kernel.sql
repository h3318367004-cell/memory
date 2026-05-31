alter table public.codex_memories
  add column if not exists layer text not null default 'note',
  add column if not exists title text,
  add column if not exists canonical_key text,
  add column if not exists status text not null default 'active',
  add column if not exists locked boolean not null default false,
  add column if not exists memory_date timestamptz,
  add column if not exists valid_from timestamptz,
  add column if not exists valid_to timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists last_dreamed_at timestamptz,
  add column if not exists dream_count integer not null default 0;

update public.codex_memories
set
  layer = case
    when kind in ('preference', 'boundary') then 'core'
    when kind = 'event' then 'episode'
    when kind = 'feel' then 'feel'
    when kind = 'project' then 'project'
    when kind = 'summary' then 'dream'
    else 'note'
  end,
  title = coalesce(title, summary, external_id),
  memory_date = coalesce(memory_date, created_at)
where layer = 'note' or title is null or memory_date is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'codex_memories_layer_check'
  ) then
    alter table public.codex_memories add constraint codex_memories_layer_check
      check (layer in ('core', 'identity', 'relationship', 'episode', 'feel', 'project', 'dream', 'working', 'note'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'codex_memories_status_check'
  ) then
    alter table public.codex_memories add constraint codex_memories_status_check
      check (status in ('active', 'archived', 'superseded', 'draft'));
  end if;
end $$;

create unique index if not exists codex_memories_canonical_key_idx
  on public.codex_memories (canonical_key)
  where canonical_key is not null;
create index if not exists codex_memories_layer_idx on public.codex_memories (layer, status, updated_at desc);
create index if not exists codex_memories_status_idx on public.codex_memories (status, updated_at desc);
create index if not exists codex_memories_memory_date_idx on public.codex_memories (memory_date desc);

create table if not exists public.codex_memory_links (
  id uuid primary key default extensions.gen_random_uuid(),
  from_memory_id uuid not null references public.codex_memories(id) on delete cascade,
  to_memory_id uuid not null references public.codex_memories(id) on delete cascade,
  relation text not null default 'related',
  strength double precision not null default 0.5 check (strength >= 0 and strength <= 1),
  note text,
  created_at timestamptz not null default now(),
  unique (from_memory_id, to_memory_id, relation)
);

create index if not exists codex_memory_links_from_idx on public.codex_memory_links (from_memory_id, relation);
create index if not exists codex_memory_links_to_idx on public.codex_memory_links (to_memory_id, relation);

create table if not exists public.codex_memory_state (
  key text primary key,
  value jsonb not null,
  note text,
  updated_at timestamptz not null default now()
);

create or replace function public.set_codex_memory_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_codex_memory_state_updated_at on public.codex_memory_state;
create trigger set_codex_memory_state_updated_at
before update on public.codex_memory_state
for each row execute function public.set_codex_memory_state_updated_at();

create table if not exists public.codex_memory_dreams (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null default 'ad_hoc',
  period_start timestamptz,
  period_end timestamptz,
  source_memory_ids uuid[] not null default '{}',
  summary_memory_id uuid references public.codex_memories(id) on delete set null,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists codex_memory_dreams_created_idx on public.codex_memory_dreams (created_at desc);

create or replace function public.set_codex_memory_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector =
    setweight(to_tsvector('simple', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.summary, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.text, '')), 'B') ||
    setweight(to_tsvector('simple', array_to_string(new.tags, ' ')), 'C') ||
    setweight(to_tsvector('simple', coalesce(new.source, '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(new.layer, '')), 'D') ||
    setweight(to_tsvector('simple', coalesce(new.kind, '')), 'D');
  return new;
end;
$$;

drop trigger if exists set_codex_memory_search_vector on public.codex_memories;
create trigger set_codex_memory_search_vector
before insert or update of title, text, summary, tags, source, layer, kind on public.codex_memories
for each row execute function public.set_codex_memory_search_vector();

update public.codex_memories
set text = text;

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
    and archived_at is null
    and status = 'active';
$$;
