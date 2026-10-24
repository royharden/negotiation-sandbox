-- Negotiation sandbox schema. Not applied in Dirty Mode construction.
create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  slug text not null,
  title text not null,
  document jsonb not null,
  visibility text not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scenarios_visibility_check check (visibility in ('private', 'public')),
  constraint scenarios_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 64),
  constraint scenarios_document_object check (jsonb_typeof(document) = 'object'),
  constraint scenarios_public_owner_check check (
    (visibility = 'public' and owner_id is null)
    or (visibility = 'private' and owner_id is not null)
  )
);

create unique index scenarios_owner_slug_idx on public.scenarios (owner_id, slug);
create unique index scenarios_public_slug_idx on public.scenarios (slug) where owner_id is null;

create trigger scenarios_set_updated_at
  before update on public.scenarios
  for each row
  execute function public.set_updated_at();

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  scenario_id uuid references public.scenarios (id) on delete set null,
  scenario_slug text not null,
  scenario_document jsonb not null,
  seed integer not null,
  buyer_agent text not null,
  seller_agent text not null,
  batch_label text,
  status text not null,
  transcript jsonb not null,
  scores jsonb not null,
  prompt_hash text not null,
  created_at timestamptz not null default now(),
  constraint runs_status_check check (status in ('complete', 'format_failure')),
  constraint runs_seed_check check (seed >= 0 and seed <= 1000000000),
  constraint runs_agent_check check (
    buyer_agent in ('concession', 'firm', 'bluff', 'model')
    and seller_agent in ('concession', 'firm', 'bluff', 'model')
  ),
  constraint runs_prompt_hash_check check (char_length(prompt_hash) between 4 and 64),
  constraint runs_document_object check (jsonb_typeof(scenario_document) = 'object'),
  constraint runs_transcript_array check (jsonb_typeof(transcript) = 'array'),
  constraint runs_scores_object check (jsonb_typeof(scores) = 'object')
);

create index runs_owner_created_idx on public.runs (owner_id, created_at desc);

create table public.llm_turn_usage (
  owner_id uuid not null references auth.users (id) on delete cascade,
  usage_day date not null,
  turn_count integer not null default 0,
  primary key (owner_id, usage_day),
  constraint llm_turn_usage_count_check check (turn_count >= 0 and turn_count <= 40)
);

-- Reserves one model turn for auth.uid(). The client cannot raise the cap of 40.
create or replace function public.reserve_llm_turn()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_count integer;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.llm_turn_usage as usage (owner_id, usage_day, turn_count)
  values (uid, (timezone('utc', now()))::date, 1)
  on conflict (owner_id, usage_day)
  do update set turn_count = usage.turn_count + 1
  where usage.turn_count < 40
  returning turn_count into new_count;

  if new_count is null then
    raise exception 'daily_turn_limit';
  end if;

  return new_count;
end;
$$;

revoke all on function public.reserve_llm_turn() from public;
grant execute on function public.reserve_llm_turn() to authenticated;

alter table public.scenarios enable row level security;
alter table public.runs enable row level security;
alter table public.llm_turn_usage enable row level security;

create policy scenarios_select on public.scenarios
  for select
  using (visibility = 'public' or owner_id = auth.uid());

create policy scenarios_insert on public.scenarios
  for insert
  with check (owner_id = auth.uid() and visibility = 'private');

create policy scenarios_update on public.scenarios
  for update
  using (owner_id = auth.uid() and visibility = 'private')
  with check (owner_id = auth.uid() and visibility = 'private');

create policy scenarios_delete on public.scenarios
  for delete
  using (owner_id = auth.uid() and visibility = 'private');

create policy runs_select on public.runs
  for select
  using (owner_id = auth.uid());

create policy runs_insert on public.runs
  for insert
  with check (owner_id = auth.uid());

create policy runs_delete on public.runs
  for delete
  using (owner_id = auth.uid());

revoke all on public.llm_turn_usage from public, anon, authenticated;
grant select, insert, update, delete on public.scenarios to authenticated;
grant select on public.scenarios to anon;
grant select, insert, delete on public.runs to authenticated;
